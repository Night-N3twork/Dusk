// /bin/dsh — Dusk SHell. DuskJS binary wrapping just-bash's Bash class.
//
// Also aliased as /bin/sh and /bin/jsh (see host/process-manager.ts:319+).
// Provides ~90 commands (grep, sed, awk, find, sort, uniq, cut, cp, mv, tar,
// jq, printf, tee, base64, xargs, and more) via the vendored just-bash source
// (Apache-2.0, Vercel Labs — see /NOTICE).
//
// Usage:
//   dsh -c "grep -r TODO /src"     # inline script
//   dsh                            # interactive REPL
//   dsh script.sh                  # run script file
//
// Filesystem: dsh runs against DuskJS's TFS directly via the TfsFs adapter.
// Writes are immediately visible to other binaries and persist across dsh
// invocations. Symlinks/hardlinks/chmod/utimes are degraded (TFS lacks them);
// see tfs-fs.ts for the coverage matrix.

import { Bash } from '../../vendor/just-bash/Bash';
import { TfsFs } from './tfs-fs';
import { python3Command, pythonCommand } from './commands/python3-command';
import { dpmCommand } from './commands/dpm-command';
import { curlCommand } from './commands/curl-command';
import { tarCommand } from './commands/tar-command';
import { gunzipCommand, gzipCommand, zcatCommand } from './commands/gzip-command';
import { unzipCommand, zipCommand } from './commands/zip-command';
import { patchCommand } from './commands/patch-command';
import { lessCommand, moreCommand } from './commands/pager-command';
import { nanoCommand, viCommand, vimCommand } from './commands/editor-command';
import { externalCommand } from './commands/external-command';
import { JobManager, PauseGate } from './jobs';
import { History, KeyReader, LineEditor } from './line-editor';
import { createCompleter } from './completion';
import type { ExecResult, TerminalAccess } from '../../vendor/just-bash/types';
import type { JobControl } from '../../vendor/just-bash/interpreter/types';

const wait = globalThis.setTimeout.bind(globalThis);

type ProcessGlobal = {
  argv: string[];
  env: Record<string, string>;
  cwd: () => string;
  exit?: (n: number) => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  stdin?: { read: () => Uint8Array | null };
  stdout: { write: (d: string | Uint8Array) => unknown };
  stderr: { write: (d: string | Uint8Array) => unknown };
};

type FsGlobal = {
  readFile: (path: string) => string;
  writeFile: (path: string, data: string) => void;
  readdir: (path: string) => string[];
  mkdir: (path: string, recursive: boolean) => void;
  exists: (path: string) => boolean;
  stat: (path: string) => { isFile: boolean; isDirectory: boolean; size?: number };
};

const getProc = (): ProcessGlobal | undefined =>
  (globalThis as Record<string, unknown>)['process'] as ProcessGlobal | undefined;

const getFs = (): FsGlobal | undefined =>
  (globalThis as Record<string, unknown>)['__fs'] as FsGlobal | undefined;

interface StdinRead {
  bytes: Uint8Array | null;
  signal?: string;
}

const readStdinChunk = (wait: boolean): StdinRead => {
  const ipc = (globalThis as { ipc?: { send: (m: unknown) => { value?: unknown; error?: string; signal?: string } } }).ipc;
  if (!ipc) return { bytes: null };
  try {
    const r = ipc.send(wait ? { f: 'proc.readStdin', wait: true } : { f: 'proc.readStdin' });
    if (r.error) return { bytes: null };
    if (r.signal) return { bytes: new Uint8Array(0), signal: r.signal };
    const v = r.value;
    if (v instanceof Uint8Array) return { bytes: v };
    if (Array.isArray(v)) return { bytes: Uint8Array.from(v as number[]) };
    return { bytes: null };
  } catch { return { bytes: null }; }
};

const latin1FromBytes = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
};

const bytesFromLatin1 = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
};

const readAllStdinBytes = (): Uint8Array[] => {
  const chunks: Uint8Array[] = [];
  while (true) {
    const { bytes, signal } = readStdinChunk(true);
    if (bytes === null || signal) break;
    if (bytes.length > 0) chunks.push(bytes);
  }
  return chunks;
};

const readAllStdin = (): string => readAllStdinBytes().map(latin1FromBytes).join('');

const readScriptFromStdin = (): string => {
  const decoder = new TextDecoder();
  let text = '';
  for (const chunk of readAllStdinBytes()) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
};

// Wire positional args into the shell's $0, $1, $#, $@, $* — matching
// bash -c script args... behavior. just-bash surfaces these through the
// exec env under keys "0", "1", "#", etc. (see vendor/…/commands/bash/bash.ts).
const buildPositionalEnv = (scriptName: string, args: string[]): Record<string, string> => {
  const env: Record<string, string> = {
    '0': scriptName,
    '#': String(args.length),
    '@': args.join(' '),
    '*': args.join(' '),
  };
  args.forEach((a, i) => { env[String(i + 1)] = a; });
  return env;
};

// dsh tracks its own cwd across interactive lines so `cd` persists. First
// call gets the process's cwd; subsequent calls reuse whatever the last
// exec left in state (which just-bash updates in state.cwd on cd).
let dshCwdState: string | null = null;

const composeNpmPath = (cwd: string, basePath: string): string => {
  const entries: string[] = [];
  const seen = new Set<string>();
  const add = (entry: string): void => {
    if (!seen.has(entry)) {
      seen.add(entry);
      entries.push(entry);
    }
  };

  let directory = cwd === '/' ? '/' : cwd.replace(/\/+$/, '');
  while (true) {
    add(`${directory === '/' ? '' : directory}/node_modules/.bin`);
    if (directory === '/') break;
    const parent = directory.slice(0, directory.lastIndexOf('/')) || '/';
    directory = parent;
  }
  for (const entry of basePath.split(':')) add(entry);
  return entries.join(':');
};

type OutputChunk = { stdout: string; stderr: string; stdoutKind?: 'text' | 'bytes' };

const writeOutput = (proc: ProcessGlobal | undefined, chunk: OutputChunk): void => {
  if (chunk.stdout) proc?.stdout.write(chunk.stdoutKind === 'bytes' ? bytesFromLatin1(chunk.stdout) : chunk.stdout);
  if (chunk.stderr) proc?.stderr.write(chunk.stderr);
};

interface RunControls {
  signal?: AbortSignal;
  pauseGate?: () => Promise<void> | void;
  lastExitCode?: number;
  terminal?: TerminalAccess;
}

const runOnce = async (
  bash: Bash,
  script: string,
  readStdin: boolean,
  jobs: JobControl,
  positionalArgs: string[] = [],
  scriptName = 'dsh',
  controls: RunControls = {},
): Promise<number> => {
  const proc = getProc();
  if (dshCwdState === null) dshCwdState = proc?.cwd ? proc.cwd() : '/';
  const positionalEnv = positionalArgs.length > 0 || scriptName !== 'dsh'
    ? buildPositionalEnv(scriptName, positionalArgs)
    : {};
  const path = proc?.env?.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  const opts: Parameters<Bash['exec']>[1] = {
    cwd: dshCwdState,
    ...(readStdin ? { stdinLoader: readAllStdin, stdinKind: 'bytes' as const } : { stdin: '' }),
    env: { ...(proc?.env ?? {}), ...positionalEnv, PATH: composeNpmPath(dshCwdState, path) },
    onOutput: (chunk) => writeOutput(proc, chunk),
    jobControl: jobs,
    ...(controls.signal ? { signal: controls.signal } : {}),
    ...(controls.pauseGate ? { pauseGate: controls.pauseGate } : {}),
    ...(controls.lastExitCode !== undefined ? { lastExitCode: controls.lastExitCode } : {}),
    ...(controls.terminal ? { terminal: controls.terminal } : {}),
  };
  const result = await bash.exec(script, opts);
  // Persist any cd from this invocation. just-bash's exec restores state.cwd
  // after the call, but exposes the final PWD via result.env. Pull that
  // out and use it as our next cwd — this is how the interactive prompt
  // gets `cd /tmp` to persist between lines.
  const nextPwd = result.env?.['PWD'];
  if (typeof nextPwd === 'string' && nextPwd.length > 0) dshCwdState = nextPwd;
  writeOutput(proc, { stdout: result.stdout, stderr: result.stderr, ...(result.stdoutKind ? { stdoutKind: result.stdoutKind } : {}) });
  return result.exitCode;
};

// Inspect a value the way node's REPL does. Not a full util.inspect, but
// enough to differentiate strings, numbers, objects, arrays, functions,
// undefined, and errors. Cycle-safe within 3 levels.
const inspect = (v: unknown, depth = 0): string => {
  if (depth > 3) return '...';
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'string') return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
  if (t === 'function') {
    const name = (v as { name?: string }).name;
    return '[Function: ' + (name || 'anonymous') + ']';
  }
  if (t === 'symbol') return String(v);
  if (v instanceof Error) return v.stack ? String(v.stack) : (v.name + ': ' + v.message);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return '[ ' + v.slice(0, 100).map((x) => inspect(x, depth + 1)).join(', ') +
      (v.length > 100 ? ', ...' + (v.length - 100) + ' more' : '') + ' ]';
  }
  if (t === 'object') {
    try {
      const keys = Object.keys(v as object);
      if (keys.length === 0) return '{}';
      const parts = keys.slice(0, 50).map((k) => k + ': ' + inspect((v as Record<string, unknown>)[k], depth + 1));
      return '{ ' + parts.join(', ') + (keys.length > 50 ? ', ...' + (keys.length - 50) + ' more' : '') + ' }';
    } catch { return '[object]'; }
  }
  return String(v);
};

// A minimal node-like REPL. Persists a shared context (`replCtx`) across
// lines so users can define variables and reuse them. Supports `.exit`,
// `.help`, `.clear`, and multi-line via trailing backslash.
const runNodeRepl = async (
  stdout: { write: (d: string | Uint8Array) => unknown },
  stderr: { write: (d: string | Uint8Array) => unknown },
  readLine: () => Promise<string | null>,
): Promise<void> => {
  stdout.write('Welcome to DuskJS node REPL. Type .help for commands, .exit to leave.\n');
  // Shared eval context. We wrap in a Proxy so `with` intercepts ALL
  // identifier lookups on it — otherwise bare assignments (`y = 100`) fall
  // through to globalThis instead of landing on ctx.
  //
  // The has-trap returns true for everything, forcing `with` to route every
  // identifier through our get-trap. The get-trap first checks ctx (user
  // state), then globalThis (so `console`, `require`, `Math`, etc. still
  // resolve). The set-trap stores exclusively on ctx.
  const state: Record<string, unknown> = Object.create(null);
  const ctxProxy = new Proxy(state, {
    has(_target, key): boolean {
      // CRITICAL: `eval` must NOT resolve through the with-scope. If the
      // has-trap returns true for 'eval', then `eval(code)` inside `with`
      // becomes an aliased/indirect eval per ECMA-262 §19.2.1 — indirect
      // eval runs in global scope and does NOT inherit the enclosing
      // async function's status, which makes top-level `await` in `code`
      // throw "await is only valid in async functions". Returning false
      // here lets `eval` resolve as a normal free binding (the direct
      // builtin), which preserves direct-eval semantics: same lexical
      // scope, same async status, same strictness.
      //
      // We also exclude 'arguments' for the same class of reason (avoid
      // shadowing the async function's synthetic arguments object).
      if (typeof key === 'string' && (key === 'eval' || key === 'arguments')) return false;
      return true;
    },
    get(target, key: PropertyKey): unknown {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return (target as Record<PropertyKey, unknown>)[key];
      return (globalThis as unknown as Record<PropertyKey, unknown>)[key];
    },
    set(target, key: PropertyKey, value: unknown): boolean {
      (target as Record<PropertyKey, unknown>)[key] = value;
      return true;
    },
    deleteProperty(target, key: PropertyKey): boolean {
      return delete (target as Record<PropertyKey, unknown>)[key];
    },
  });
  const ctx = ctxProxy as unknown as Record<string, unknown>;
  let buffered = '';
  const promptPrimary = '> ';
  const promptContinue = '... ';
  while (true) {
    stdout.write(buffered.length === 0 ? promptPrimary : promptContinue);
    const line = await readLine();
    if (line === null) { stdout.write('\n'); return; }
    const raw = line;
    if (buffered.length === 0) {
      const cmd = raw.trim();
      if (cmd === '.exit' || cmd === '.quit') return;
      if (cmd === '.help') {
        stdout.write('.help    show this help\n.exit    return to dsh\n.clear   reset REPL context\n(end a line with \\ to continue on the next line)\n');
        continue;
      }
      if (cmd === '.clear') {
        for (const k of Object.keys(state)) delete state[k];
        stdout.write('context cleared.\n');
        continue;
      }
    }
    // Multi-line continuation on trailing backslash.
    if (raw.endsWith('\\')) {
      buffered += raw.slice(0, -1) + '\n';
      continue;
    }
    const code = buffered + raw;
    buffered = '';
    if (!code.trim()) continue;
    // Evaluate. Wrap in async fn so `await` at top level works. Use `with`
    // on ctx to make bare assignments (`x = 5`) persist across lines.
    //
    // Known limitation: `var`/`let`/`const` declarations and `function foo`
    // declarations scope to this eval frame and do NOT persist across lines
    // — the underlying eval runs in strict mode via `new Function`. Users
    // wanting cross-line state should assign bare (no keyword). Node's real
    // REPL rewrites source to hoist these; that's more work than we need.
    let result: unknown;
    let threw = false;
    try {
      // Wrap in `new Function(...)` (non-strict) so `with (__ctx)` is legal
      // — AsyncFunction bodies are always strict and would reject `with`.
      // Inside, an async IIFE hosts `eval(code)`. The critical bit: our
      // Proxy's has-trap now returns false for 'eval' (see ctxProxy above),
      // so `eval` resolves as the direct free binding — this is DIRECT eval,
      // which inherits the enclosing arrow's async status. That's what makes
      // top-level `await` legal in `code`. Making eval resolve through
      // `with` (indirect eval) would silently break async — SpiderMonkey
      // reports "await is only valid in async functions" in that path.
      // eslint-disable-next-line no-new-func
      const fn = new Function('__ctx',
        'with (__ctx) { return (async () => { return eval(' + JSON.stringify(code) + '); })(); }');
      result = await (fn as (c: Record<string, unknown>) => Promise<unknown>)(ctx);
    } catch (e) {
      threw = true;
      // SpiderMonkey's Error.stack does NOT include the `name: message`
      // header line (unlike V8), so relying on stack alone hides the actual
      // error text. Always print the header line first, then the stack for
      // context. This is what makes REPL errors debuggable.
      if (e instanceof Error) {
        const header = (e.name || 'Error') + ': ' + (e.message || String(e));
        const stack = e.stack ? String(e.stack) : '';
        // If the stack already begins with the header (some engines do this),
        // don't duplicate it.
        const body = stack && !stack.startsWith(header) ? header + '\n' + stack : (stack || header);
        stderr.write('Uncaught ' + body + '\n');
      } else {
        stderr.write('Uncaught ' + String(e) + '\n');
      }
    }
    if (!threw && result !== undefined) {
      stdout.write(inspect(result) + '\n');
    }
  }
};

type Ipc = { send: (m: unknown) => { value?: unknown; error?: string } };

const getIpc = (): Ipc | undefined => (globalThis as { ipc?: Ipc }).ipc;

const ttyQuery = <T>(message: Record<string, unknown>, fallback: T): T => {
  try {
    const reply = getIpc()?.send(message);
    return reply && !reply.error && reply.value !== undefined ? reply.value as T : fallback;
  } catch {
    return fallback;
  }
};

const expandHistory = (line: string, history: History): { line: string; error?: string } => {
  if (!line.includes('!')) return { line };
  let out = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '\\' && i + 1 < line.length) {
      out += char + line[++i];
      continue;
    }
    if (char === "'") quoted = !quoted;
    if (char !== '!' || quoted) {
      out += char;
      continue;
    }
    const rest = line.slice(i + 1);
    const last = history.size > 0 ? history.at(history.size - 1)! : undefined;
    let match: RegExpExecArray | null;
    if (rest.startsWith('!')) {
      if (last === undefined) return { line, error: '!!: event not found' };
      out += last;
      i += 1;
    } else if (rest.startsWith('$')) {
      if (last === undefined) return { line, error: '!$: event not found' };
      out += last.trim().split(/\s+/).pop() ?? '';
      i += 1;
    } else if ((match = /^-?\d+/.exec(rest))) {
      const n = Number(match[0]);
      const entry = history.at(n < 0 ? history.size + n : n - 1);
      if (entry === undefined) return { line, error: `!${match[0]}: event not found` };
      out += entry;
      i += match[0].length;
    } else if ((match = /^[A-Za-z_.\/][^\s;|&]*/.exec(rest)) && (i === 0 || /\s/.test(line[i - 1]!))) {
      const prefix = match[0];
      let found: string | undefined;
      for (let j = history.size - 1; j >= 0; j--) {
        if (history.at(j)!.startsWith(prefix)) { found = history.at(j); break; }
      }
      if (found === undefined) return { line, error: `!${prefix}: event not found` };
      out += found;
      i += prefix.length;
    } else {
      out += char;
    }
  }
  return { line: out };
};

const createHistory = (fs: FsGlobal | undefined, home: string | undefined): History => {
  const file = home ? `${home === '/' ? '' : home}/.dsh_history` : undefined;
  return new History(file && fs ? {
    load: () => {
      try { return fs.exists(file) ? fs.readFile(file) : undefined; } catch { return undefined; }
    },
    save: (text) => fs.writeFile(file, text),
  } : undefined);
};

const historyBuiltin = (history: History, args: string[]): ExecResult => {
  if (args[0] === '-c') {
    history.clear();
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  const entries = history.list();
  const count = args[0] && /^\d+$/.test(args[0]) ? Math.min(Number(args[0]), entries.length) : entries.length;
  let stdout = '';
  for (let i = entries.length - count; i < entries.length; i++) stdout += `${String(i + 1).padStart(5)}  ${entries[i]}\n`;
  return { stdout, stderr: '', exitCode: 0 };
};

const runInteractive = async (bash: Bash, jobs: JobManager, control: JobControl, history: History): Promise<number> => {
  const proc = getProc();
  if (!proc) return 1;
  const stdout = proc.stdout;
  const stderr = proc.stderr;
  if (!getIpc()) { stderr.write('dsh: no stdin available\n'); return 1; }

  const decoder = new TextDecoder();
  const isTty = ttyQuery({ f: 'tty.isatty', fd: 0 }, false);

  const pollChunk = async (timeoutMs?: number): Promise<Uint8Array | null | undefined> => {
    const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    let delay = 2;
    while (true) {
      const chunk = readStdinChunk(false).bytes;
      if (chunk === null || chunk.length > 0) return chunk;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await new Promise<void>((resolve) => wait(resolve, Math.min(delay, remaining)));
      delay = Math.min(delay * 2, 30);
    }
  };

  let lineBuf = '';
  const readLine = async (): Promise<string | null> => {
    while (true) {
      const nl = lineBuf.indexOf('\n');
      if (nl !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        return line;
      }
      const chunk = await pollChunk();
      if (chunk === undefined) continue;
      if (chunk === null) {
        lineBuf += decoder.decode();
        if (lineBuf.length > 0) { const rest = lineBuf; lineBuf = ''; return rest; }
        return null;
      }
      lineBuf += decoder.decode(chunk, { stream: true });
    }
  };

  const setRaw = (raw: boolean): void => {
    if (isTty) ttyQuery({ f: 'tty.setRawMode', raw }, true);
  };

  const fsGlobal = getFs();
  const winSize = (): number[] => ttyQuery<number[]>({ f: 'tty.getWinSize' }, [80, 24]);
  const keys = new KeyReader(async (timeoutMs) => {
    const chunk = await pollChunk(timeoutMs);
    return chunk === null || chunk === undefined ? chunk : decoder.decode(chunk, { stream: true });
  });
  const terminal: TerminalAccess | undefined = isTty ? {
    columns: () => winSize()[0] ?? 80,
    rows: () => winSize()[1] ?? 24,
    write: (data) => { stdout.write(data); },
    readKey: async () => {
      while (true) {
        const key = await keys.next();
        if (key !== undefined) return key;
      }
    },
    pollKey: (timeoutMs) => keys.next(false, timeoutMs),
    setRaw,
  } : undefined;
  const editor = isTty ? new LineEditor(
    {
      write: (text) => stdout.write(text),
      columns: () => winSize()[0] ?? 80,
    },
    history,
    createCompleter({
      cwd: () => dshCwdState ?? '/',
      env: () => proc.env ?? {},
      commands: () => bash.getCommandNames(),
      readdir: (path) => fsGlobal?.readdir(path) ?? [],
      isDirectory: (path) => fsGlobal?.stat(path).isDirectory ?? false,
    }),
    keys,
  ) : undefined;

  let current: AbortController | undefined;
  let interrupted = false;
  proc.on?.('SIGINT', () => {
    if (jobs.forwardSignal('SIGINT')) return;
    if (current) {
      interrupted = true;
      current.abort();
    }
  });
  proc.on?.('SIGTSTP', () => { jobs.forwardSignal('SIGTSTP'); });
  proc.on?.('SIGQUIT', () => { jobs.forwardSignal('SIGQUIT'); });

  let exitCode = 0;
  let warnedStopped = false;
  while (true) {
    const notices = jobs.notifications();
    if (notices) stderr.write(notices);
    let line: string | null;
    if (editor) {
      setRaw(true);
      try {
        line = await editor.readLine('dsh$ ');
      } finally {
        setRaw(false);
      }
    } else {
      stdout.write('dsh$ ');
      line = await readLine();
    }
    if (line === null) break;
    const expanded = expandHistory(line, history);
    if (expanded.error) {
      stderr.write(`dsh: ${expanded.error}\n`);
      continue;
    }
    if (expanded.line !== line) stdout.write(expanded.line + '\n');
    const script = expanded.line.trim();
    if (script.length === 0) continue;
    history.add(expanded.line);
    if (script === 'exit' || script === 'quit' || script === 'logout') {
      if (jobs.hasJobs() && !warnedStopped) {
        warnedStopped = true;
        stderr.write('There are stopped or running jobs.\n');
        continue;
      }
      return exitCode;
    }
    warnedStopped = false;
    if (script === 'node') {
      try {
        await runNodeRepl(stdout, stderr, readLine);
      } catch (e) {
        stderr.write('node: ' + String(e) + '\n');
      }
      continue;
    }
    current = new AbortController();
    interrupted = false;
    try {
      const code = await runOnce(bash, script, false, control, [], 'dsh', { signal: current.signal, lastExitCode: exitCode, ...(terminal ? { terminal } : {}) });
      exitCode = interrupted ? 130 : code;
      if (interrupted) stdout.write('\n');
    } catch (e) {
      stderr.write('dsh: ' + String(e) + '\n');
      exitCode = 2;
    } finally {
      current = undefined;
    }
  }
  return exitCode;
};

export const main = async (): Promise<number> => {
  const proc = getProc();
  const fs = getFs();
  if (!proc) return 1;

  const argv = proc.argv;
  const args = argv.slice(1);

  // Parse flags: -c script, --version, -h/--help, script file.
  let scriptInline: string | null = null;
  let scriptFile: string | null = null;
  let showHelp = false;
  let showVersion = false;
  let scriptFromStdin = false;
  const scriptArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-c' && i + 1 < args.length) {
      scriptInline = args[i + 1]!;
      i++;
      // any remaining args are $0, $1, ... for the script
      for (let j = i + 1; j < args.length; j++) scriptArgs.push(args[j]!);
      break;
    } else if (a === '--version' || a === '-v') {
      showVersion = true;
    } else if (a === '--help' || a === '-h') {
      showHelp = true;
    } else if (a === '-') {
      scriptInline = readScriptFromStdin();
      scriptFromStdin = true;
      break;
    } else if (!a.startsWith('-')) {
      scriptFile = a;
      for (let j = i + 1; j < args.length; j++) scriptArgs.push(args[j]!);
      break;
    }
  }

  if (showHelp) {
    proc.stdout.write('dsh — Dusk SHell (powered by just-bash)\n');
    proc.stdout.write('Usage: dsh [-c script] [script-file] [args...]\n');
    proc.stdout.write('Options:\n');
    proc.stdout.write('  -c script     Run inline script and exit\n');
    proc.stdout.write('  -             Read script from stdin\n');
    proc.stdout.write('  --version     Print version and exit\n');
    proc.stdout.write('  --help        Print this help and exit\n');
    if (proc.exit) proc.exit(0);
    return 0;
  }

  if (showVersion) {
    proc.stdout.write('dsh (Dusk SHell / just-bash 3.0.2)\n');
    if (proc.exit) proc.exit(0);
    return 0;
  }

  // Build a just-bash environment backed by DuskJS's TFS. Writes hit TFS
  // immediately and are visible to other binaries (no snapshotting).
  if (!fs) {
    proc.stderr.write('dsh: __fs global missing; TFS bridge unavailable\n');
    if (proc.exit) proc.exit(1);
    return 1;
  }
  const jbFs = new TfsFs();

  const history = createHistory(fs, proc.env?.['HOME']);
  const interactive = scriptInline === null && scriptFile === null;
  const jobs = new JobManager({
    stdout: (data) => { proc.stdout.write(data); },
    stderr: (data) => { proc.stderr.write(data); },
    readInput: () => readStdinChunk(false).bytes,
  }, interactive);
  const gate = new PauseGate();
  if (!interactive) {
    proc.on?.('SIGTSTP', () => gate.pause());
    proc.on?.('SIGCONT', () => gate.resume());
  }
  const shellControl: JobControl = {
    background: (job) => jobs.background(job),
    wait: (waitArgs) => jobs.wait(waitArgs),
    builtin: (name, builtinArgs) => (name === 'history' ? Promise.resolve(historyBuiltin(history, builtinArgs)) : jobs.builtin(name, builtinArgs)),
  };

  const bash = new Bash({
    fs: jbFs,
    // Enable JS: registers `js-exec` and `node` commands that route to a
    // DuskJS-native in-engine eval (see vendor/just-bash/commands/js-exec/).
    javascript: true,
    // Custom DuskJS commands: python3 (via host Pyodide bridge). See
    // ./commands/. Each of these routes IPC through
    // the same channel other host funcs use (fs.*, net.*).
    customCommands: [
      curlCommand,
      python3Command,
      pythonCommand,
      dpmCommand('dpm'),
      dpmCommand('npm'),
      dpmCommand('npx'),
      dpmCommand('pnpm'),
      dpmCommand('dpx'),
      tarCommand,
      gzipCommand,
      gunzipCommand,
      zcatCommand,
      zipCommand,
      unzipCommand,
      patchCommand,
      lessCommand,
      moreCommand,
      nanoCommand,
      viCommand,
      vimCommand,
      externalCommand('tsx'),
      externalCommand('git'),
    ],
  });

  let code: number;
  if (scriptInline !== null) {
    // For `dsh -c "script" arg0 arg1 arg2`: matches bash's -c behavior —
    // arg0 becomes $0, arg1 becomes $1, arg2 becomes $2. If no args, $0
    // defaults to 'dsh'. This is deliberately DIFFERENT from `dsh script`
    // (where $0 = script path). See POSIX sh -c behavior.
    const inlineScriptName = scriptArgs.length > 0 ? scriptArgs[0]! : 'dsh';
    const inlinePositional = scriptArgs.length > 0 ? scriptArgs.slice(1) : [];
    code = await runOnce(bash, scriptInline, !scriptFromStdin, shellControl, inlinePositional, inlineScriptName, { pauseGate: gate.wait });
  } else if (scriptFile !== null) {
    let content: string;
    try {
      if (!fs) throw new Error('__fs not available');
      content = fs.readFile(scriptFile);
    } catch (e) {
      proc.stderr.write('dsh: ' + scriptFile + ': ' + String(e) + '\n');
      if (proc.exit) proc.exit(1);
      return 1;
    }
    // For `dsh script.sh a b c`: $0 = script.sh, $1... = a b c.
    code = await runOnce(bash, content, true, shellControl, scriptArgs, scriptFile, { pauseGate: gate.wait });
  } else {
    code = await runInteractive(bash, jobs, shellControl, history);
  }

  if (proc.exit) proc.exit(code);
  return code;
};
