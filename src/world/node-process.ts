import { EventEmitter } from './node-events';
import { signalToName, defaultSignalAction, type SignalName } from './node-constants';
import { isatty, WriteStream as TtyWriteStream, ReadStream as TtyReadStream } from './node-tty';
import { createStreamWritable } from './engine-streams';

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };
declare const performance: { now(): number } | undefined;
declare const __DUSK_PID__: number | undefined;
declare const __DUSK_VERSION__: string;

const __call = (f: string, extra: Record<string, unknown> = {}): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) {
    const e = new Error(r.error);
    const m = /^([A-Z]+):/.exec(r.error);
    if (m) (e as unknown as Record<string, unknown>)['code'] = m[1];
    throw e;
  }
  return r.value;
};

const encodeUtf8 = (str: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) { out.push(c); }
    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }
  return out;
};

interface ProcessBootstrapResponse {
  pid: number;
  ppid: number;
  argv: string[];
  argv0: string;
  execArgv: string[];
  execPath: string;
  env: Record<string, string>;
  cwd: string;
  title: string;
  uid: number;
  gid: number;
  hostname: string;
  bootTime: number;
  isTTY: { stdin: boolean; stdout: boolean; stderr: boolean };
}

const DEFAULT_BOOTSTRAP: ProcessBootstrapResponse = {
  pid: 0,
  ppid: 0,
  argv: ['node'],
  argv0: 'node',
  execArgv: [],
  execPath: '/bin/node',
  env: {},
  cwd: '/',
  title: 'duskjs',
  uid: 1000,
  gid: 1000,
  hostname: 'duskjs',
  bootTime: 0,
  isTTY: { stdin: false, stdout: false, stderr: false },
};

let bootstrap: ProcessBootstrapResponse = DEFAULT_BOOTSTRAP;
const bootPerfNow = (typeof performance !== 'undefined' && performance ? performance.now() : 0);

const envCache: Record<string, string> = {};

const buildEnvProxy = (pid: number): Record<string, string> => {
  const target = envCache;
  return new Proxy(target, {
    get(t, key) {
      if (typeof key !== 'string') return undefined;
      return t[key];
    },
    set(t, key, value) {
      if (typeof key !== 'string') return false;
      const v = value == null ? '' : String(value);
      try { __call('env.set', { pid, key, value: v }); } catch { /* host may not have func */ }
      t[key] = v;
      return true;
    },
    deleteProperty(t, key) {
      if (typeof key !== 'string') return true;
      try { __call('env.delete', { pid, key }); } catch { /* */ }
      delete t[key];
      return true;
    },
    has(t, key) {
      return typeof key === 'string' && key in t;
    },
    ownKeys(t) {
      return Object.keys(t);
    },
    getOwnPropertyDescriptor(t, key) {
      if (typeof key !== 'string') return undefined;
      if (!(key in t)) return undefined;
      return { value: t[key], writable: true, enumerable: true, configurable: true };
    },
    defineProperty(t, key, desc) {
      if (typeof key !== 'string') return false;
      if (!('value' in desc)) return false;
      const v = desc.value == null ? '' : String(desc.value);
      try { __call('env.set', { pid, key, value: v }); } catch { /* */ }
      t[key] = v;
      return true;
    },
  });
};

class ProcessSingleton extends EventEmitter {
  pid = 0;
  ppid = 0;
  argv: string[] = ['node'];
  argv0 = 'node';
  execArgv: string[] = [];
  execPath = '/bin/node';
  platform = 'linux' as const;
  arch = 'wasm32' as const;
  version = 'v20.0.0';
  versions: Readonly<Record<string, string | undefined>> = Object.freeze({
    node: '20.0.0',
    // SpiderMonkey wasm does not expose its version (see src/engine/spidermonkey.ts —
    // SM_DATA_URL serves a wasm blob with no version metadata). Stays '0' until
    // upstream publishes a version channel. Regression: test/node-process-versions.test.ts.
    spidermonkey: '0',
    dusk: (typeof __DUSK_VERSION__ !== 'undefined') ? __DUSK_VERSION__ : '0.0.0',
    openssl: undefined,
    v8: undefined,
    uv: undefined,
    zlib: undefined,
    modules: '115',
    ares: undefined,
  });
  features = Object.freeze({
    inspector: false,
    debug: false,
    uv: false,
    ipv6: true,
    tls_alpn: false,
    tls_sni: false,
    tls_ocsp: false,
    tls: false,
    cached_builtins: false,
  });
  release = Object.freeze({
    name: 'node',
    sourceUrl: '',
    headersUrl: '',
    libUrl: '',
    lts: undefined as string | undefined,
  });
  config = Object.freeze({});
  allowedNodeEnvironmentFlags: ReadonlySet<string> = new Set();
  env: Record<string, string> = {};
  exitCode: number | undefined = undefined;
  connected = false as const;
  send: undefined = undefined;
  private _title = 'duskjs';
  get title(): string { return this._title; }
  set title(v: string) {
    const s = String(v);
    this._title = s;
    try { __call('process.title.set', { pid: this.pid, title: s }); } catch { /* host may not have func; keep local */ }
  }

  private _cwd = '/';
  private _stdin: unknown = null;
  private _stdout: unknown = null;
  private _stderr: unknown = null;
  private _exiting = false;
  private _stdoutFactory: (() => unknown) | null = null;
  private _stderrFactory: (() => unknown) | null = null;
  private _stdinFactory: (() => unknown) | null = null;

  cwd(): string { return this._cwd; }

  chdir(path: string): void {
    // No fallback: if the host rejects (ENOENT / ENOTDIR / EACCES), rethrow.
    // `__call` already parses the leading "CODE:" prefix into err.code.
    const v = __call('process.chdir', { pid: this.pid, path });
    if (v && typeof v === 'object' && 'cwd' in v) {
      this._cwd = String((v as { cwd: string }).cwd);
    } else {
      this._cwd = path;
    }
  }

  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    super.on(event, listener);
    if (event === 'SIGCHLD') {
      try { __call('process.signal.listen', { pid: this.pid, signal: event }); } catch { /* optional host capability */ }
    }
    return this;
  }

  exit(code?: number): void {
    const effective = code ?? this.exitCode ?? 0;
    this.exitCode = effective;
    if (!this._exiting) {
      this._exiting = true;
      try { this.emit('beforeExit', effective); } catch { /* */ }
      try { this.emit('exit', effective); } catch { /* */ }
    }
    try {
      __call('process.exit', { code: effective });
    } catch { /* */ }
    const g = globalThis as Record<string, unknown>;
    const proc = (g['__process'] as Record<string, unknown>) ?? {};
    proc['_exitCode'] = effective;
    g['__process'] = proc;
  }

  abort(): void {
    this.exit(134);
  }

  kill(pid: number, sig?: string | number): boolean {
    const signame = typeof sig === 'number' ? (signalToName(sig) ?? 'SIGTERM') : (sig ?? 'SIGTERM');
    try {
      __call('process.kill', { pid, signal: signame });
      return true;
    } catch (e) {
      throw e;
    }
  }

  setpgid(pid: number, pgid: number): void {
    try { __call('process.setpgid', { pid, pgid, callerPid: this.pid }); }
    catch (e) { throw e; }
  }

  getpgid(pid: number = 0): number {
    try { return __call('process.getpgid', { pid: pid || this.pid }) as number; }
    catch { return 0; }
  }

  getpgrp(): number {
    return this.getpgid(this.pid);
  }

  umask(_mask?: number): number {
    return 0o022;
  }

  uptime(): number {
    const now = (typeof performance !== 'undefined' && performance ? performance.now() : 0);
    return Math.max(0, (now - bootPerfNow) / 1000);
  }

  hrtime: ProcessHrtime = createHrtime();

  nextTick(fn: Function, ...args: unknown[]): void {
    if (typeof fn !== 'function') {
      const err = new TypeError('callback must be a function');
      (err as unknown as Record<string, unknown>)['code'] = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    Promise.resolve().then(() => {
      try { (fn as Function)(...args); } catch (e) {
        try { this.emit('uncaughtException', e); } catch { /* */ }
      }
    });
  }

  memoryUsage(): { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number } {
    const perfMem = (globalThis as { performance?: { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number } } }).performance?.memory;
    return {
      rss: 0,
      heapTotal: perfMem?.totalJSHeapSize ?? 0,
      heapUsed: perfMem?.usedJSHeapSize ?? 0,
      external: 0,
      arrayBuffers: 0,
    };
  }

  cpuUsage(_prev?: { user: number; system: number }): { user: number; system: number } {
    return { user: 0, system: 0 };
  }

  resourceUsage(): Record<string, number> {
    return {
      userCPUTime: 0, systemCPUTime: 0, maxRSS: 0,
      sharedMemorySize: 0, unsharedDataSize: 0, unsharedStackSize: 0,
      minorPageFault: 0, majorPageFault: 0, swappedOut: 0,
      fsRead: 0, fsWrite: 0, ipcSent: 0, ipcReceived: 0, signalsCount: 0,
      voluntaryContextSwitches: 0, involuntaryContextSwitches: 0,
    };
  }

  getuid(): number { return bootstrap.uid; }
  getgid(): number { return bootstrap.gid; }
  geteuid(): number { return bootstrap.uid; }
  getegid(): number { return bootstrap.gid; }

  disconnect(): void { /* no-op */ }

  emitWarning(warning: string | Error, _opts?: Record<string, unknown>): void {
    try {
      this.emit('warning', typeof warning === 'string' ? new Error(warning) : warning);
    } catch { /* */ }
  }

  getBuiltinModule(id: string): unknown {
    const lookup = (globalThis as Record<string, unknown>)['__duskGetBuiltinModule'] as ((id: string) => unknown) | undefined;
    return lookup ? lookup(id) : undefined;
  }

  binding(name: string): never {
    const err = new Error('process.binding is not supported');
    (err as unknown as Record<string, unknown>)['code'] = 'ERR_UNSUPPORTED';
    throw err;
  }

  _setStdioFactories(s: { stdin: () => unknown; stdout: () => unknown; stderr: () => unknown }): void {
    this._stdinFactory = s.stdin;
    this._stdoutFactory = s.stdout;
    this._stderrFactory = s.stderr;
  }

  get stdin(): unknown {
    if (this._stdin === null) {
      this._stdin = this._stdinFactory ? this._stdinFactory() : makeFallbackReadable();
    }
    return this._stdin;
  }

  get stdout(): unknown {
    if (this._stdout === null) {
      this._stdout = this._stdoutFactory ? this._stdoutFactory() : makeFallbackWritable(1, this.pid);
    }
    return this._stdout;
  }

  get stderr(): unknown {
    if (this._stderr === null) {
      this._stderr = this._stderrFactory ? this._stderrFactory() : makeFallbackWritable(2, this.pid);
    }
    return this._stderr;
  }
}

interface ProcessHrtime {
  (prev?: [number, number]): [number, number];
  bigint(): bigint;
}

const createHrtime = (): ProcessHrtime => {
  const fn = ((prev?: [number, number]): [number, number] => {
    const ms = (typeof performance !== 'undefined' && performance ? performance.now() : 0);
    const totalNs = BigInt(Math.round(ms * 1e6));
    let secs = Number(totalNs / 1_000_000_000n);
    let ns = Number(totalNs % 1_000_000_000n);
    if (prev) {
      const prevTotal = BigInt(prev[0]) * 1_000_000_000n + BigInt(prev[1]);
      const delta = totalNs - prevTotal;
      secs = Number(delta / 1_000_000_000n);
      ns = Number(delta % 1_000_000_000n);
    }
    return [secs, ns];
  }) as ProcessHrtime;
  fn.bigint = (): bigint => {
    const ms = (typeof performance !== 'undefined' && performance ? performance.now() : 0);
    return BigInt(Math.round(ms * 1e6));
  };
  return fn;
};

// Simple proc.write-backed fallback for non-REPL pids. Spawned children keep
// this shape so `pipeChildToParent`, which already pumps stdout/stderr via its
// own path, is untouched. Registering a second sink via the stream registry
// here would double-pump the child's output.
const makeProcWriteFallback = (fd: number): { write: (data: string | Uint8Array) => boolean; end: () => void; isTTY?: boolean } => {
  return {
    write(data: string | Uint8Array): boolean {
      const bytes = typeof data === 'string' ? encodeUtf8(data) : data;
      try { __call('proc.write', { fd, data: bytes }); } catch { /* */ }
      return true;
    },
    end(): void { /* no-op */ },
  };
};

// Only the REPL (pid 0) gets a real Writable backed by the stream registry.
// The host `stream.registerStdioSink` handler (in createPidZero) routes
// chunks to the REPL's print sink. This gives REPL code the full Writable
// EventEmitter surface (`.on('drain')`, backpressure, etc.) while leaving
// spawned children on the simpler proc.write path.
const makeReplStdioWritable = (fd: number): unknown => {
  try {
    const r = __call('stream.allocate') as { id: number };
    const id = r.id;
    __call('stream.registerStdioSink', { id, fd });
    const w = createStreamWritable(id);
    (w as unknown as { isTTY?: boolean }).isTTY = false;
    return w;
  } catch {
    // Host does not support the stdio-sink handler yet — degrade so we
    // still emit output rather than throw during REPL boot.
    return makeProcWriteFallback(fd);
  }
};

const makeFallbackWritable = (fd: number, pid: number): unknown => {
  if (pid === 0) return makeReplStdioWritable(fd);
  return makeProcWriteFallback(fd);
};

const makeFallbackReadable = (): EventEmitter & { read: () => Uint8Array | null; resume: () => EventEmitter; pause: () => EventEmitter; isTTY?: boolean } => {
  const stream = new EventEmitter() as EventEmitter & {
    read: () => Uint8Array | null;
    resume: () => EventEmitter;
    pause: () => EventEmitter;
  };
  stream.read = (): Uint8Array | null => {
      try {
        const v = __call('proc.readStdin') as number[] | null;
        if (v === null) return null;
        return new Uint8Array(v);
      } catch { return null; }
  };
  stream.resume = (): EventEmitter => stream;
  stream.pause = (): EventEmitter => stream;
  return stream;
};

export const installNodeProcess = (): ProcessSingleton => {
  const g = globalThis as Record<string, unknown>;

  let boot: ProcessBootstrapResponse = DEFAULT_BOOTSTRAP;
  const fallbackPid: number = (typeof __DUSK_PID__ !== 'undefined' && __DUSK_PID__ !== undefined) ? __DUSK_PID__ : 0;
  try {
    const v = __call('process.bootstrap') as ProcessBootstrapResponse | undefined;
    if (v && typeof v === 'object') {
      boot = { ...DEFAULT_BOOTSTRAP, ...v };
    } else {
      boot = { ...DEFAULT_BOOTSTRAP, pid: fallbackPid };
    }
  } catch {
    boot = { ...DEFAULT_BOOTSTRAP, pid: fallbackPid };
  }
  bootstrap = boot;

  Object.keys(envCache).forEach((k) => delete envCache[k]);
  for (const k of Object.keys(boot.env)) envCache[k] = boot.env[k]!;

  const proc = new ProcessSingleton();
  proc.pid = boot.pid;
  proc.ppid = boot.ppid;
  proc.argv = [...boot.argv];
  proc.argv0 = boot.argv0;
  proc.execArgv = [...boot.execArgv];
  proc.execPath = boot.execPath;
  (proc as unknown as { _title: string })._title = boot.title;
  proc.env = buildEnvProxy(boot.pid);
  (proc as unknown as { _cwd: string })._cwd = boot.cwd;

  g['process'] = proc;

  proc._setStdioFactories({
    stdin: (): unknown => {
      if (isatty(0)) return new TtyReadStream(0);
      return makeFallbackReadable();
    },
    stdout: (): unknown => {
      if (isatty(1)) return new TtyWriteStream(1);
      return makeFallbackWritable(1, boot.pid);
    },
    stderr: (): unknown => {
      if (isatty(2)) return new TtyWriteStream(2);
      return makeFallbackWritable(2, boot.pid);
    },
  });

  // Signal dispatch hook: world.ts dispatch loop will call this when receiving signal envelopes
  const procRec = (g['__process'] as Record<string, unknown> | undefined) ?? {};
  const exitProcess = proc.exit.bind(proc);
  procRec['onSignal'] = (signame: string, _signo?: number, payload?: unknown): void => {
    const had = proc.listenerCount(signame) > 0;
    try { proc.emit(signame, signame, payload); } catch { /* */ }
    if (!had) {
      const action = defaultSignalAction(signame);
      if (action === 'terminate' || action === 'core') {
        const num = (typeof signame === 'string' && signame.startsWith('SIG'))
          ? (signalNumberFromName(signame as SignalName) ?? 15)
          : 15;
        exitProcess(128 + num);
      }
    }
  };
  procRec['onUncaught'] = (err: unknown, origin: 'uncaughtException' | 'unhandledRejection' = 'uncaughtException'): void => {
    const e: Error = (err instanceof Error) ? err : new Error(String(err));
    if (origin === 'unhandledRejection') {
      const hadRej = proc.listenerCount('unhandledRejection') > 0;
      if (hadRej) {
        try { proc.emit('unhandledRejection', e, Promise.reject(e).catch(() => {})); } catch { /* */ }
        return;
      }
      // No unhandledRejection handler. In Node, a rejection with no
      // `unhandledRejection` listener is escalated to `uncaughtException`
      // when the process exits (--unhandled-rejections=throw is default in
      // Node 15+). Fall through to the uncaughtException path so
      // `process.on('uncaughtException', ...)` sees async errors too.
    }
    // uncaughtExceptionMonitor fires first, regardless of whether uncaughtException
    // handlers exist. It is informational only and never suppresses default behavior.
    try { proc.emit('uncaughtExceptionMonitor', e, origin); } catch { /* */ }
    const hadExc = proc.listenerCount('uncaughtException') > 0;
    if (hadExc) {
      try { proc.emit('uncaughtException', e, origin); } catch { /* */ }
      return;
    }
    // No handler — default Node behavior: print and exit(1).
    const label = origin === 'unhandledRejection' ? '(node:unhandledRejection) ' : '';
    try { __call('console.error', { args: [label + String(e && (e as Error).stack ? (e as Error).stack : e)] }); } catch { /* */ }
    proc.exit(1);
  };
  procRec['process'] = proc;
  g['__process'] = procRec;

  return proc;
};

const signalNumberFromName = (name: string): number | undefined => {
  // Avoid a circular import by reusing the inverse map indirectly through __call.
  // Local fallback table for the most common signals.
  const map: Record<string, number> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8,
    SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
    SIGSTKFLT: 16, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22,
    SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29,
    SIGPWR: 30, SIGSYS: 31,
  };
  return map[name];
};

export const getProcessSingleton = (): ProcessSingleton | undefined => {
  return (globalThis as Record<string, unknown>)['process'] as ProcessSingleton | undefined;
};

export const nodeProcess = new Proxy({} as Record<string, unknown>, {
  get(_t, key) {
    const p = getProcessSingleton();
    if (!p) return undefined;
    return (p as unknown as Record<string, unknown>)[key as string];
  },
  set(_t, key, value) {
    const p = getProcessSingleton();
    if (!p) return false;
    (p as unknown as Record<string, unknown>)[key as string] = value;
    return true;
  },
  has(_t, key) {
    const p = getProcessSingleton();
    if (!p) return false;
    return key in (p as unknown as object);
  },
});
