// /bin/python3 — CPython (via Pyodide) on the host.
//
// Usage:
//   python3 -c "print('hi')"          inline code
//   python3 script.py [args...]       run TFS-resident script
//   python3 -                         read code from stdin
//   echo 'print(1)' | python3         same
//   python3                           interactive REPL (line-buffered)
//   python3 --version
//
// Heavy lifting (Pyodide WASM) is done on the host; see src/host/python.ts.
// TFS integration: scripts are read from TFS and pushed into Pyodide's FS
// so `open('/tmp/x.txt')` inside Python sees the file — provided we mirror
// it first. Currently we only push the script file itself; general TFS
// mirroring is a follow-up.

type ProcessGlobal = {
  argv: string[];
  env: Record<string, string>;
  cwd: () => string;
  exit?: (n: number) => void;
  stdin?: { read: () => Uint8Array | null };
  stdout: { write: (d: string | Uint8Array) => unknown };
  stderr: { write: (d: string | Uint8Array) => unknown };
};

const getProc = (): ProcessGlobal | undefined =>
  (globalThis as Record<string, unknown>)['process'] as ProcessGlobal | undefined;

type Ipc = { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const call = (f: string, args: Record<string, unknown> = {}): unknown => {
  const ipc = (globalThis as { ipc?: Ipc }).ipc;
  if (!ipc) throw new Error('ipc unavailable');
  const r = ipc.send({ f, ...args });
  if (r.error) throw new Error(r.error);
  return r.value;
};

type FsGlobal = {
  readFile: (p: string) => string;
  exists: (p: string) => boolean;
};
const getFs = (): FsGlobal | undefined => (globalThis as Record<string, unknown>)['__fs'] as FsGlobal | undefined;

const stdinBytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return null;
};

const readStdinChunk = (wait: boolean): Uint8Array | null => {
  const ipc = (globalThis as { ipc?: Ipc }).ipc;
  if (!ipc) return null;
  try {
    const r = ipc.send(wait ? { f: 'proc.readStdin', wait: true } : { f: 'proc.readStdin' }) as { value?: unknown; error?: string; signal?: string };
    if (r.error || r.signal) return null;
    return stdinBytes(r.value);
  } catch { return null; }
};

const readStdinAll = (): string => {
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const chunk = readStdinChunk(true);
    if (chunk === null) break;
    if (chunk.length > 0) text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
};

const stdinIsTty = (): boolean => {
  try { return call('tty.isatty', { fd: 0 }) === true; } catch { return false; }
};

// Simple line-buffered REPL: send each statement/block to python.exec.
// Python's real REPL handles multi-line via indentation; we approximate:
// a line ending in `:` or non-empty indent means "expect more". Compound
// statements assemble until a blank line.
const runRepl = async (): Promise<number> => {
  const proc = getProc();
  if (!proc) return 1;
  const ipc = (globalThis as { ipc?: Ipc }).ipc;
  if (!ipc) return 1;

  const decoder = new TextDecoder();
  let lineBuf = '';
  const readLine = async (): Promise<string | null> => {
    while (true) {
      const nl = lineBuf.indexOf('\n');
      if (nl !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        return line;
      }
      const chunk = readStdinChunk(false);
      if (chunk === null) {
        lineBuf += decoder.decode();
        if (lineBuf.length > 0) { const rest = lineBuf; lineBuf = ''; return rest; }
        return null;
      }
      if (chunk.length === 0) { await new Promise<void>((r) => setTimeout(r, 5)); continue; }
      lineBuf += decoder.decode(chunk, { stream: true });
    }
  };

  try {
    const v = call('python.version') as { version: string };
    proc.stdout.write('Python ' + v.version + ' (Pyodide, Dusk edition)\n');
    proc.stdout.write('Type "exit()" or Ctrl+D to leave.\n');
  } catch (e) {
    proc.stderr.write('python3: ' + (e instanceof Error ? e.message : String(e)) + '\n');
    return 1;
  }

  let block = '';
  while (true) {
    proc.stdout.write(block.length === 0 ? '>>> ' : '... ');
    const line = await readLine();
    if (line === null) { proc.stdout.write('\n'); return 0; }
    if (block.length === 0 && (line.trim() === 'exit()' || line.trim() === 'quit()')) {
      return 0;
    }
    // If line ends with `:` or `\`, or starts with indentation, extend block.
    const trimmed = line.trimEnd();
    const extending = trimmed.endsWith(':') || trimmed.endsWith('\\') || /^\s+\S/.test(line);
    if (extending) {
      block += line + '\n';
      continue;
    }
    if (block.length > 0) {
      // Extending block but this line has no indent: dedents. Empty line
      // ends the block; non-empty is the last line of the block.
      if (line.trim() === '') {
        // Execute accumulated block
        const code = block;
        block = '';
        try {
          const r = call('python.exec', { code }) as { stdout: string; stderr: string; exitCode: number };
          if (r.stdout) proc.stdout.write(r.stdout);
          if (r.stderr) proc.stderr.write(r.stderr);
        } catch (e) {
          proc.stderr.write('python3: ' + (e instanceof Error ? e.message : String(e)) + '\n');
        }
        continue;
      } else {
        // Treat as inline continuation, then execute
        block += line + '\n';
        const code = block;
        block = '';
        try {
          const r = call('python.exec', { code }) as { stdout: string; stderr: string; exitCode: number };
          if (r.stdout) proc.stdout.write(r.stdout);
          if (r.stderr) proc.stderr.write(r.stderr);
        } catch (e) {
          proc.stderr.write('python3: ' + (e instanceof Error ? e.message : String(e)) + '\n');
        }
        continue;
      }
    }
    // Single-line statement or expression.
    if (line.trim() === '') continue;
    try {
      const r = call('python.exec', { code: line }) as { stdout: string; stderr: string; exitCode: number };
      if (r.stdout) proc.stdout.write(r.stdout);
      if (r.stderr) proc.stderr.write(r.stderr);
    } catch (e) {
      proc.stderr.write('python3: ' + (e instanceof Error ? e.message : String(e)) + '\n');
    }
  }
};

export const main = async (): Promise<number> => {
  const proc = getProc();
  if (!proc) return 1;

  const argv = proc.argv.slice(1);

  let inlineCode: string | null = null;
  let scriptPath: string | null = null;
  let readStdin = false;
  const scriptArgs: string[] = [];
  let showVersion = false;
  let showHelp = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-c' && i + 1 < argv.length) {
      inlineCode = argv[i + 1]!;
      for (let j = i + 2; j < argv.length; j++) scriptArgs.push(argv[j]!);
      break;
    }
    if (a === '--version' || a === '-V') { showVersion = true; i = argv.length; break; }
    if (a === '--help' || a === '-h') { showHelp = true; i = argv.length; break; }
    if (a === '-') { readStdin = true; for (let j = i + 1; j < argv.length; j++) scriptArgs.push(argv[j]!); break; }
    if (a.startsWith('-') && a.length > 1) {
      proc.stderr.write('python3: unrecognized option: ' + a + '\n');
      if (proc.exit) proc.exit(2);
      return 2;
    }
    scriptPath = a;
    for (let j = i + 1; j < argv.length; j++) scriptArgs.push(argv[j]!);
    break;
  }

  if (showHelp) {
    proc.stdout.write([
      'python3 — CPython via Pyodide (WASM)',
      'Usage: python3 [OPTIONS] [-c CODE | SCRIPT | -] [args...]',
      '  -c CODE      Execute CODE as Python',
      '  -            Read script from stdin',
      '  SCRIPT       Path in TFS to a .py file',
      '  --version    Print Python version and exit',
      '  --help       Print this help',
      'With no args: interactive REPL.',
      '',
    ].join('\n'));
    if (proc.exit) proc.exit(0);
    return 0;
  }
  if (showVersion) {
    try {
      const r = call('python.version') as { version: string };
      proc.stdout.write('Python ' + r.version + '\n');
      if (proc.exit) proc.exit(0);
      return 0;
    } catch (e) {
      proc.stderr.write('python3: ' + (e instanceof Error ? e.message : String(e)) + '\n');
      if (proc.exit) proc.exit(1);
      return 1;
    }
  }

  // Interactive REPL when no script/-c/stdin flag.
  if (inlineCode === null && scriptPath === null && !readStdin) {
    if (!stdinIsTty()) {
      const piped = readStdinAll();
      const argvForPy = ['python3', ...scriptArgs];
      const r = call('python.exec', { code: piped, argv: argvForPy }) as { stdout: string; stderr: string; exitCode: number };
      if (r.stdout) proc.stdout.write(r.stdout);
      if (r.stderr) proc.stderr.write(r.stderr);
      const code = r.exitCode ?? 0;
      if (proc.exit) proc.exit(code);
      return code;
    }
    const code = await runRepl();
    if (proc.exit) proc.exit(code);
    return code;
  }

  let code: string;
  let displayName = '<string>';
  if (inlineCode !== null) {
    code = inlineCode;
    displayName = '<-c>';
  } else if (readStdin) {
    code = readStdinAll();
    displayName = '<stdin>';
  } else {
    // scriptPath !== null
    const fs = getFs();
    if (!fs) {
      proc.stderr.write('python3: __fs unavailable\n');
      if (proc.exit) proc.exit(1);
      return 1;
    }
    try {
      code = fs.readFile(scriptPath!);
    } catch (e) {
      proc.stderr.write("python3: can't open file '" + scriptPath + "': " + (e instanceof Error ? e.message : String(e)) + '\n');
      if (proc.exit) proc.exit(2);
      return 2;
    }
    displayName = scriptPath!;
  }

  const argvForPy = [displayName, ...scriptArgs];
  try {
    const r = call('python.exec', {
      code,
      argv: argvForPy,
      scriptPath: scriptPath ?? undefined,
    }) as { stdout: string; stderr: string; exitCode: number };
    if (r.stdout) proc.stdout.write(r.stdout);
    if (r.stderr) proc.stderr.write(r.stderr);
    const exitCode = r.exitCode ?? 0;
    if (proc.exit) proc.exit(exitCode);
    return exitCode;
  } catch (e) {
    proc.stderr.write('python3: ' + (e instanceof Error ? e.message : String(e)) + '\n');
    if (proc.exit) proc.exit(1);
    return 1;
  }
};
