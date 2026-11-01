// /bin/node main entry — runs on engine startup.

export const main = async (): Promise<number> => {
  const proc = (globalThis as Record<string, unknown>)['process'] as {
    argv: string[];
    env: Record<string, string>;
    cwd: () => string;
    exit?: (n: number) => void;
    stderr: { write: (d: string | Uint8Array) => void };
    stdout: { write: (d: string | Uint8Array) => void };
    version?: string;
    versions?: Record<string, string>;
  } | undefined;
  const argv = proc?.argv ?? ['/bin/node'];

  // Strip node + binary-name argv[0]
  // process.argv is ['node', 'script.js', ...args]
  const args = argv.slice(1);

  if (args.length === 0) {
    await startRepl();
    return 0;
  }

  let i = 0;
  let evalExpr: string | undefined;
  let printExpr: string | undefined;
  let scriptPath: string | undefined;
  let inputType: 'esm' | 'cjs' | undefined;

  while (i < args.length) {
    const a = args[i]!;
    if (a === '--version' || a === '-v') {
      proc?.stdout.write((proc?.version ?? 'v20.0.0') + '\n');
      proc?.exit?.(0);
      return 0;
    }
    if (a === '-e' || a === '--eval') {
      evalExpr = args[++i];
      i++;
      continue;
    }
    if (a === '-p' || a === '--print') {
      printExpr = args[++i];
      i++;
      continue;
    }
    if (a === '--input-type=module') { inputType = 'esm'; i++; continue; }
    if (a === '--input-type=commonjs') { inputType = 'cjs'; i++; continue; }
    if (a.startsWith('--')) { i++; continue; }
    if (a.startsWith('-')) { i++; continue; }
    scriptPath = a;
    break;
  }

  // Re-shape process.argv to ['node', scriptPath, ...rest]
  const restAfterScript = scriptPath ? args.slice(args.indexOf(scriptPath) + 1) : [];
  if (proc) {
    proc.argv = ['node', scriptPath ?? '', ...restAfterScript];
  }

  try {
    if (evalExpr !== undefined) {
      if (inputType === 'esm') {
        await runEsmInline(evalExpr);
      } else {
        runCjsInline(evalExpr);
      }
    } else if (printExpr !== undefined) {
      const result = inputType === 'esm' ? await runEsmInline(printExpr, true) : runCjsInline(printExpr, true);
      proc?.stdout.write(String(result) + '\n');
    } else if (scriptPath !== undefined) {
      await runScript(scriptPath);
    }
    await waitForActiveHandles();
    await (globalThis as { __process?: { __duskLifecycle?: { whenIdle(): Promise<void> } } }).__process?.__duskLifecycle?.whenIdle();
    const code = (proc as { exitCode?: number } | undefined)?.exitCode ?? 0;
    proc?.exit?.(code);
    return code;
  } catch (e) {
    // SpiderMonkey's Error.stack omits the `name: message` header line,
    // so relying on stack alone loses the actual error text and makes
    // scripts look silently failed. Always print the header first.
    if (e instanceof Error) {
      const header = (e.name || 'Error') + ': ' + (e.message || String(e));
      const stack = e.stack ? String(e.stack) : '';
      const body = stack && !stack.startsWith(header) ? header + '\n' + stack : (stack || header);
      proc?.stderr.write(body + '\n');
    } else {
      proc?.stderr.write(String(e) + '\n');
    }
    proc?.exit?.(1);
    return 1;
  }
};

export const waitForActiveHandles = async (): Promise<void> => {
  while (true) {
    // Let script-scheduled microtasks establish handles before deciding the
    // process is idle. Repeat after each release for close callbacks that
    // replace one active handle with another.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const state = (globalThis as Record<string, unknown>)['__nodeActiveHandles'] as {
      count: number;
      waiters: Set<() => void>;
    } | undefined;
    if (!state || state.count === 0) return;
    await new Promise<void>((resolve) => state.waiters.add(resolve));
  }
};

const runScript = async (path: string): Promise<unknown> => {
  const fs = (globalThis as Record<string, unknown>)['__fs'] as { readFile: (p: string) => string; exists: (p: string) => boolean } | undefined;
  if (!fs) throw new Error('__fs unavailable');
  if (!fs.exists(path)) throw new Error(`Cannot find module '${path}'`);
  const isEsm = detectEsm(path);
  if (isEsm) {
    const imp = (globalThis as Record<string, unknown>)['__import__'] as ((req: string) => Promise<Record<string, unknown>>) | undefined;
    if (!imp) throw new Error('__import__ unavailable');
    return await imp(path);
  }
  // CJS
  let source = fs.readFile(path);
  // Strip shebang. `#!` is only legal at the very start of a script/module,
  // not inside the (function(exports, require, module, ...){ ... }) wrapper
  // we emit below — leaving it in produces a syntax error. Node itself does
  // the same strip (see Module.prototype._compile in Node core).
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n');
    source = nl === -1 ? '' : source.slice(nl + 1);
  }
  const dir = path.split('/').slice(0, -1).join('/') || '/';
  const req = (globalThis as Record<string, unknown>)['require'] as ((m: string) => unknown) | undefined;
  if (!req) throw new Error('require unavailable');
  const module = { exports: {} as unknown };
  const fn = (0, eval)('(function(exports, require, module, __filename, __dirname){' + source + '\n})') as (e: unknown, r: unknown, m: unknown, fn: string, dn: string) => unknown;
  fn(module.exports, req, module, path, dir);
  const binTarget = (globalThis as Record<string, unknown>)['__duskBinTarget'];
  if (typeof binTarget === 'string') {
    delete (globalThis as Record<string, unknown>)['__duskBinTarget'];
    const proc = (globalThis as Record<string, unknown>)['process'] as { argv: string[] } | undefined;
    if (proc) proc.argv[1] = binTarget;
    return runScript(binTarget);
  }
  return module.exports;
};

const detectEsm = (path: string): boolean => {
  if (path.endsWith('.mjs')) return true;
  if (path.endsWith('.cjs')) return false;
  if (!path.endsWith('.js') && !path.endsWith('.ts')) return false;
  // Look up parent package.json for "type": "module"
  const fs = (globalThis as Record<string, unknown>)['__fs'] as { readFile: (p: string) => string; exists: (p: string) => boolean } | undefined;
  if (!fs) return false;
  let dir = path.split('/').slice(0, -1).join('/') || '/';
  for (let i = 0; i < 32; i++) {
    const pkg = dir + '/package.json';
    try {
      if (fs.exists(pkg)) {
        const content = fs.readFile(pkg);
        const parsed = JSON.parse(content) as { type?: string };
        return parsed.type === 'module';
      }
    } catch { /* */ }
    if (dir === '/' || dir === '') break;
    dir = dir.split('/').slice(0, -1).join('/') || '/';
  }
  return false;
};

const runCjsInline = (expr: string, returnResult = false): unknown => {
  // Use `new Function` for statement/expression handling. It's more robust
  // than an eval-based expression-wrap-then-fallback dance because:
  //   - `new Function(body)` builds a function body that accepts any
  //     statements (including `throw`, `if`, `for`, ...).
  //   - The function runs cleanly; runtime throws propagate as errors,
  //     not as SyntaxErrors from a failed expression wrap.
  // For `-p` (returnResult=true) we still need to capture the last value,
  // so we try the expression wrap first and fall back to a plain body.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const F = Function as unknown as new (...args: string[]) => (...a: unknown[]) => unknown;
  if (returnResult) {
    try {
      const fn = new F('return (' + expr + ')');
      return fn();
    } catch (e) {
      // If the expression wrap threw at parse time (statement input) try
      // a plain body — the last completion won't be captured but the code
      // will at least run.
      if (e instanceof SyntaxError) {
        const fn = new F(expr);
        return fn();
      }
      throw e;
    }
  }
  // No result needed — run as a plain function body. Runtime throws
  // propagate to main()'s catch which prints the name:message header.
  const fn = new F(expr);
  fn();
  return undefined;
};

const runEsmInline = async (expr: string, returnResult = false): Promise<unknown> => {
  // For ESM inline, support top-level await
  const fn = (0, eval)('(async function(){return (' + expr + ');})') as () => Promise<unknown>;
  try {
    const r = await fn();
    return returnResult ? r : undefined;
  } catch (e) {
    if (returnResult) throw e;
    await (0, eval)('(async function(){' + expr + '})()');
    return undefined;
  }
};

const startRepl = async (): Promise<void> => {
  const proc = (globalThis as Record<string, unknown>)['process'] as {
    stdin: { on?(e: string, cb: (d: unknown) => void): unknown; resume?(): unknown; setEncoding?(e: string): unknown; read?(): Uint8Array | null };
    stdout: { write(d: string | Uint8Array): unknown };
    stderr: { write(d: string | Uint8Array): unknown };
    version?: string;
    exit?: (n: number) => void;
  } | undefined;
  const req = (globalThis as Record<string, unknown>)['require'] as ((m: string) => Record<string, unknown>) | undefined;
  if (!req || !proc) {
    proc?.stderr.write('node: cannot start REPL (no require/process)\n');
    proc?.exit?.(1);
    return;
  }
  proc.stdout.write(`Welcome to Node.js ${proc.version ?? 'v20.0.0'}.\n`);
  proc.stdout.write('Type ".help" for more information.\n');

  // Build an EventEmitter-shaped input that polls proc.stdin.read() and emits
  // 'data' events, since the fallback stdin returned by installNodeProcess
  // only exposes .read() (see world/node-process.ts makeFallbackReadable).
  // node:repl's REPLServer._attachInput requires input.on('data', ...).
  type Cb = (d: unknown) => void;
  const listeners: Record<string, Cb[]> = { data: [], end: [] };
  const input = {
    on(event: string, cb: Cb): unknown {
      (listeners[event] ??= []).push(cb);
      return input;
    },
    resume(): unknown { return input; },
    setEncoding(_e: string): unknown { return input; },
  };
  let stopped = false;
  const emit = (event: string, arg: unknown): void => {
    const arr = listeners[event];
    if (!arr) return;
    for (const cb of arr.slice()) { try { cb(arg); } catch { /* */ } }
  };

  const replMod = req('node:repl') as { start: (opts: object) => { on(e: string, cb: () => void): unknown } };
  const server = replMod.start({
    prompt: '> ',
    input,
    output: proc.stdout,
    useColors: false,
  });
  server.on('exit', () => {
    stopped = true;
    proc.exit?.(0);
  });

  // Pump loop: poll stdin for bytes and forward as 'data' events.
  // proc.stdin.read() returns Uint8Array or null (stdin closed).
  const readStdin = (proc.stdin as { read?: () => Uint8Array | null }).read;
  if (typeof readStdin === 'function') {
    while (!stopped) {
      let chunk: Uint8Array | null = null;
      try { chunk = readStdin.call(proc.stdin); } catch { chunk = null; }
      if (chunk === null) { emit('end', undefined); break; }
      if (chunk.length > 0) emit('data', chunk);
      else await new Promise((r) => setTimeout(r, 5));
    }
  } else {
    // No .read() surface — nothing to pump; block forever.
    await new Promise<void>(() => undefined);
  }
};
