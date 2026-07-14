import { createEngine, type EngineInstance, type FuncTable, type SendFn } from './engine-instance';
import type { FSBackend } from './fs-backend';
import { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_APPEND } from './fs-backend';
import { createFDTable, type FDTable } from './fd-table';
import { norm, dirname } from './vfs';
import { SERIAL_RES_SIZE } from '../protocol/messages';
import dshBinarySource from '../binaries/dsh/binary-entry.ts?worldsrc';
// /bin/node, /bin/sh.legacy, /bin/sqlite3, /bin/python3, and the dpm bundle
// family are only needed when the user (or a script) explicitly invokes them.
// dsh has its own in-engine `js-exec` and `node` REPL, and dsh's sqlite3/python3
// custom commands go through host IPC — none of that touches these bundles.
// We load them lazily on first spawn to keep idle bundle+parsed-JS footprint
// small. See the registerLazyBinary calls in the constructor.
import { BUILTIN_BINARIES, JSH_COMMAND_SET } from './builtin-binaries';
import { createSocketRegistry, type SocketRegistry, type SocketPair } from './socket-registry';
import { createStreamRegistry, type StreamRegistry } from './stream-registry';
import { createPtyManager, type PtyManager, type Pty } from './pty';

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8,
  SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
  SIGSTKFLT: 16, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22,
  SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29,
  SIGPWR: 30, SIGSYS: 31,
};

const DISPATCH_CHUNK_SIZE = Math.floor(SERIAL_RES_SIZE / 8);

export interface ProcessStdinWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface DuskProcessHandle {
  pid: number;
  exit: Promise<number>;
  stdin: ProcessStdinWriter;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(): void;
  master?: Pty;   // present iff spawned with { pty: ... }
}

export interface SpawnOptions {
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stdin?: Uint8Array | number[] | string;
  pty?: boolean | { cols?: number; rows?: number };
}

export interface SpawnSyncResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  status: number;
}

interface ProcessRecord {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  engine: EngineInstance;
  handle: DuskProcessHandle;
  stdinBuffer: Uint8Array[];
  stdinClosed: boolean;
  argv: string[];
  argv0: string;
  execPath: string;
  env: Map<string, string>;
  cwd: string;
  title: string;
  startTime: number;
  exitSignal?: string;
}



interface DispatchHolder {
  dispatch: ((js: string) => void) | null;
}

const formatErr = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));

const normalizeStdin = (stdin: unknown): Uint8Array | undefined => {
  if (stdin === undefined || stdin === null) return undefined;
  if (stdin instanceof Uint8Array) return stdin;
  if (Array.isArray(stdin)) return Uint8Array.from(stdin as number[]);
  if (typeof stdin === 'string') return new TextEncoder().encode(stdin);
  if (typeof stdin === 'object') {
    const vals = Object.values(stdin as Record<string, unknown>);
    if (vals.every((v) => typeof v === 'number')) return Uint8Array.from(vals as number[]);
  }
  return undefined;
};

// Node-compatible package.json `exports` field resolution.
//
// Spec reference: https://nodejs.org/api/packages.html#package-entry-points
// Subset implemented:
//   - String shorthand: "exports": "./index.js"
//   - Conditional map (no subpath): { "import": "...", "require": "...", "default": "..." }
//   - Subpath map: { "./feature": "./feature.js", ".": "./main.js" }
//   - Subpath patterns: { "./internal/*": "./src/internal/*.js" }
//   - Nested conditional: { "./a": { "node": "./a.node.js", "default": "./a.js" } }
//   - Falsy targets (null) → access denied
//
// Default conditions matched: ["node", "default", "require"]  (CJS path)
// For ESM the resolver here is shared; the engine-side esm.ts uses a similar
// algorithm internally. The CJS-only set is the safer default.

const DEFAULT_CONDITIONS = ['node', 'default', 'require'];

type ExportsValue =
  | string
  | null
  | ExportsValue[]
  | { [key: string]: ExportsValue };

const matchPatternSubpath = (pattern: string, subpath: string): string | null => {
  // pattern: "./feature/*" or "./feature/*.js" — the * matches one or more chars.
  const starIdx = pattern.indexOf('*');
  if (starIdx === -1) return pattern === subpath ? '' : null;
  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);
  if (!subpath.startsWith(prefix)) return null;
  if (!subpath.endsWith(suffix)) return null;
  if (subpath.length < prefix.length + suffix.length) return null;
  return subpath.slice(prefix.length, subpath.length - suffix.length);
};

const applyPatternTarget = (target: string, capture: string): string => {
  return target.split('*').join(capture);
};

const resolveExportsValue = (
  value: ExportsValue,
  conditions: Set<string>,
): string | null => {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const r = resolveExportsValue(v, conditions);
      if (r !== null) return r;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (conditions.has(key) || key === 'default') {
        const r = resolveExportsValue(value[key]!, conditions);
        if (r !== null) return r;
      }
    }
    return null;
  }
  return null;
};

const resolveExports = (
  pkgJson: { name?: string; exports?: ExportsValue },
  subpath: string,
  conditions: Set<string>,
): string | null => {
  const exp = pkgJson.exports;
  if (exp === undefined) return null;

  // Sugar form: "exports": "./index.js" → equivalent to { ".": "./index.js" }
  if (typeof exp === 'string' || Array.isArray(exp)) {
    if (subpath === '.') return resolveExportsValue(exp, conditions);
    return null;
  }

  if (exp === null) return null;

  if (typeof exp !== 'object') return null;

  // Determine whether this is a subpath map or a conditional map.
  // Subpath map: all keys start with '.'
  const keys = Object.keys(exp);
  const isSubpathMap = keys.length > 0 && keys.every((k) => k.startsWith('.'));

  if (!isSubpathMap) {
    // It's a conditional map at root; only "." subpath allowed.
    if (subpath !== '.') return null;
    return resolveExportsValue(exp, conditions);
  }

  // Exact match first
  if (exp[subpath] !== undefined) {
    return resolveExportsValue(exp[subpath]!, conditions);
  }

  // Pattern match — longest matching prefix wins
  let bestPattern: string | null = null;
  let bestCapture: string | null = null;
  for (const key of keys) {
    if (!key.includes('*')) continue;
    const capture = matchPatternSubpath(key, subpath);
    if (capture === null) continue;
    if (bestPattern === null || key.length > bestPattern.length) {
      bestPattern = key;
      bestCapture = capture;
    }
  }
  if (bestPattern !== null && bestCapture !== null) {
    const target = resolveExportsValue(exp[bestPattern]!, conditions);
    if (target === null) return null;
    return applyPatternTarget(target, bestCapture);
  }

  return null;
};

const parsePackageRequest = (request: string): { pkg: string; subpath: string } => {
  // "@scope/pkg" or "@scope/pkg/sub/path"
  if (request.startsWith('@')) {
    const firstSlash = request.indexOf('/');
    if (firstSlash === -1) return { pkg: request, subpath: '.' };
    const secondSlash = request.indexOf('/', firstSlash + 1);
    if (secondSlash === -1) return { pkg: request, subpath: '.' };
    return {
      pkg: request.slice(0, secondSlash),
      subpath: '.' + request.slice(secondSlash),
    };
  }
  const slash = request.indexOf('/');
  if (slash === -1) return { pkg: request, subpath: '.' };
  return {
    pkg: request.slice(0, slash),
    subpath: '.' + request.slice(slash),
  };
};

const resolveModule = async (fs: FSBackend, request: string, fromDir: string): Promise<string> => {
  const tryFile = async (p: string): Promise<string | null> => {
    const n = norm(p);
    if ((await fs.exists(n)) && (await fs.stat(n)).isFile) return n;
    for (const ext of ['.js', '.json', '.cjs', '.mjs']) if (await fs.exists(n + ext)) return n + ext;
    if ((await fs.exists(n)) && (await fs.stat(n)).isDirectory) {
      if (await fs.exists(n + '/package.json')) {
        const main = (JSON.parse(await fs.readFile(n + '/package.json')) as { main?: string }).main;
        if (main) { const m = await tryFile(n + '/' + main); if (m) return m; }
      }
      const idx = await tryFile(n + '/index');
      if (idx) return idx;
    }
    return null;
  };

  if (request.startsWith('./') || request.startsWith('../') || request.startsWith('/')) {
    const m = await tryFile(request.startsWith('/') ? request : fromDir + '/' + request);
    if (m) return m;
    throw new Error('Cannot find module ' + request);
  }

  // Bare specifier — walk up node_modules, considering exports field
  const { pkg, subpath } = parsePackageRequest(request);
  const conditions = new Set(DEFAULT_CONDITIONS);

  let dir = fromDir;
  while (true) {
    const pkgDir = dir + '/node_modules/' + pkg;
    if (await fs.exists(pkgDir + '/package.json')) {
      const pkgJson = JSON.parse(await fs.readFile(pkgDir + '/package.json')) as {
        name?: string; main?: string; exports?: ExportsValue;
      };

      // Try exports field first if present
      if (pkgJson.exports !== undefined) {
        const target = resolveExports(pkgJson, subpath, conditions);
        if (target !== null) {
          // target is relative like "./dist/index.js"; resolve against pkgDir
          const resolved = pkgDir + '/' + target.replace(/^\.\//, '');
          if (await fs.exists(resolved)) return norm(resolved);
          // Try with extensions in case the target doesn't include one
          const withExt = await tryFile(resolved);
          if (withExt) return withExt;
          throw new Error(`Module ${request}: exports target '${target}' does not exist`);
        }
        // exports field exists but didn't match → strict mode: deny
        throw new Error(`Module ${request}: subpath '${subpath}' is not defined by "exports" in ${pkg}/package.json`);
      }

      // No exports — fall back to legacy resolution
      const subRelative = subpath === '.' ? '' : subpath.replace(/^\.\//, '/');
      const m = await tryFile(pkgDir + subRelative);
      if (m) return m;
    }
    if (dir === '/' || dir === '') break;
    dir = dirname(dir);
  }
  throw new Error('Cannot find module ' + request);
};

export class ProcessManager {
  private fs: FSBackend;
  private netFuncs: FuncTable;
  private binaries = new Map<string, string>();
  private processes = new Map<number, ProcessRecord>();
  private nextPid = 1;
  private socketRegistry: SocketRegistry = createSocketRegistry();
  private streamRegistryImpl: StreamRegistry = createStreamRegistry();

  public get streamRegistry(): StreamRegistry {
    return this.streamRegistryImpl;
  }
  private ptyManager: PtyManager = createPtyManager();
  private dispatchByPid = new Map<number, (js: string) => void>();
  private fdTables = new Map<number, FDTable>();

  private getOrCreateFDTable(pid: number): FDTable {
    let t = this.fdTables.get(pid);
    if (!t) { t = createFDTable(); this.fdTables.set(pid, t); }
    return t;
  }

  // Optional binaries loaded on first spawn. Keeps ~500KB+ of parsed JS
  // off the idle heap when the demo/user never invokes these directly.
  // Note: dsh's built-in `sqlite3` and `python3` commands go through host
  // IPC and DO NOT need /bin/sqlite3 or /bin/python3 — those bundles are
  // only needed if the user explicitly invokes /bin/{sqlite3,python3}.
  private lazyLoaders: Map<string, () => Promise<string>> = new Map();

  constructor(fs: FSBackend, netFuncs: FuncTable = {}, extraFuncs: FuncTable = {}) {
    this.fs = fs;
    this.netFuncs = { ...netFuncs, ...extraFuncs };
    // /bin/dsh (Dusk SHell) is the canonical shell. /bin/sh and /bin/jsh
    // are aliases so scripts using shebang `#!/bin/sh` and existing
    // demos/tests that reference /bin/jsh keep working.
    //
    // Only dsh itself is registered eagerly — that's the one binary the demo
    // spawns on boot. Everything else (node, legacy shell, sqlite3, python3,
    // dpm family) is loaded on demand from a code-split chunk on first spawn.
    // Idle bundles stay small; the first invocation pays a one-time fetch.
    this.registerBinary('/bin/dsh', dshBinarySource);
    this.registerBinary('/bin/sh', dshBinarySource);
    this.registerBinary('/bin/jsh', dshBinarySource);
    // /bin/node — invoked by dsh's `js-exec` fallback, dpm's shebang line,
    // and any explicit `node <script>` at the shell. The eager `dsh` binary
    // has its own in-engine node REPL and doesn't rely on this.
    this.registerLazyBinary('/bin/node', async () =>
      (await import('../binaries/node/binary-entry.ts?worldsrc')).default);
    // /bin/sh.legacy — retained "in case anything explicitly needs it".
    // Nothing in-tree does; loading it costs a Vite dynamic import if
    // someone actually calls it. Remove entirely once dsh proves stable.
    this.registerLazyBinary('/bin/sh.legacy', async () =>
      (await import('../shell/binary-entry.ts?worldsrc')).default);
    // Lazy: sqlite3, python3, python alias, dpm/dpx/npm/npx/pnpm.
    // These get their source fetched from a code-split chunk on first spawn.
    this.registerLazyBinary('/bin/sqlite3', async () =>
      (await import('../binaries/sqlite3/binary-entry.ts?worldsrc')).default);
    const loadPython = async (): Promise<string> =>
      (await import('../binaries/python3/binary-entry.ts?worldsrc')).default;
    this.registerLazyBinary('/bin/python3', loadPython);
    this.registerLazyBinary('/bin/python', loadPython);
    this.registerLazyBinary('/bin/dpm', async () =>
      (await import('./dpm-bundles/dpm-bundle.js?raw')).default);
    this.registerLazyBinary('/bin/dpx', async () =>
      (await import('./dpm-bundles/dpx-bundle.js?raw')).default);
    this.registerLazyBinary('/bin/npm', async () =>
      (await import('./dpm-bundles/npm-bundle.js?raw')).default);
    this.registerLazyBinary('/bin/npx', async () =>
      (await import('./dpm-bundles/npx-bundle.js?raw')).default);
    this.registerLazyBinary('/bin/pnpm', async () =>
      (await import('./dpm-bundles/pnpm-bundle.js?raw')).default);
    for (const [name, src] of Object.entries(BUILTIN_BINARIES)) {
      this.registerBinary(name, src);
    }
  }

  registerBinary(name: string, jsSource: string): void {
    this.binaries.set(name, jsSource);
    this.lazyLoaders.delete(name);
  }

  // Register a binary whose source is fetched on first spawn. Idempotent —
  // once loaded, the source is cached in this.binaries and subsequent
  // spawns are synchronous.
  registerLazyBinary(name: string, loader: () => Promise<string>): void {
    this.lazyLoaders.set(name, loader);
  }

  // JSH-wrapper elision. When someone spawns e.g. `/bin/grep foo bar`, the
  // registered binary is a stub that itself spawns `/bin/dsh -c 'grep foo bar'`
  // — costing TWO SpiderMonkey Workers (the wrapper + dsh) for one command.
  // Since dsh already has all these commands as first-class builtins, we
  // rewrite the spawn to invoke dsh directly, saving one whole SM worker
  // (~100MB peak) per invocation.
  //
  // Called from spawn() and spawnSync(). Returns the rewritten (cmd, args)
  // pair, or the original inputs if no rewrite applies.
  private maybeElideJshWrapper(cmd: string, args: string[]): { cmd: string; args: string[] } {
    if (!JSH_COMMAND_SET.has(cmd)) return { cmd, args };
    // POSIX single-quote each arg. `'` becomes `'\''`.
    const bareName = cmd.slice('/bin/'.length);
    const quoted = args.map((a) => "'" + a.replace(/'/g, "'\\''") + "'").join(' ');
    const script = quoted.length > 0 ? bareName + ' ' + quoted : bareName;
    return { cmd: '/bin/dsh', args: ['-c', script] };
  }

  // Resolve a binary name to its source, forcing a lazy load if needed.
  // Returns undefined if the binary isn't registered at all (caller falls
  // back to reading a script from TFS).
  private async resolveBinary(name: string): Promise<string | undefined> {
    const eager = this.binaries.get(name);
    if (eager !== undefined) return eager;
    const loader = this.lazyLoaders.get(name);
    if (!loader) return undefined;
    const source = await loader();
    this.binaries.set(name, source);
    this.lazyLoaders.delete(name);
    return source;
  }

  getProcess(pid: number): DuskProcessHandle | undefined {
    return this.processes.get(pid)?.handle;
  }

  activePids(): number[] {
    return [...this.processes.keys()];
  }

  listBinaries(): string[] {
    // Include both eagerly-loaded and lazily-registered names so consumers
    // (which command completion, PATH search) see the full set even before
    // the lazy sources have been fetched.
    const names = new Set<string>([...this.binaries.keys(), ...this.lazyLoaders.keys()]);
    return [...names].sort();
  }

  hasBinary(name: string): boolean {
    return this.binaries.has(name) || this.lazyLoaders.has(name);
  }

  getBinarySource(name: string): string | undefined {
    // Sync accessor — returns undefined for lazy binaries that haven't
    // been forced yet. Callers that need the source should go through
    // spawn/spawnSync (which awaits resolveBinary internally).
    return this.binaries.get(name);
  }

  getStreamRegistry(): StreamRegistry {
    return this.streamRegistryImpl;
  }

  getPtyManager(): PtyManager {
    return this.ptyManager;
  }

  getProcessRecord(pid: number): {
    pid: number; ppid: number; pgid: number; argv: string[]; argv0: string; execPath: string;
    env: Record<string, string>; cwd: string; title: string; startTime: number;
  } | undefined {
    const r = this.processes.get(pid);
    if (!r) return undefined;
    return {
      pid: r.pid,
      ppid: r.ppid,
      pgid: r.pgid,
      argv: [...r.argv],
      argv0: r.argv0,
      execPath: r.execPath,
      env: Object.fromEntries(r.env),
      cwd: r.cwd,
      title: r.title,
      startTime: r.startTime,
    };
  }

  _deliverSignal(targetPid: number, signame: string): void {
    // Negative pid means "all processes in pgroup |pid|".
    if (targetPid < 0) {
      const pgid = -targetPid;
      for (const rec of this.processes.values()) {
        if (rec.pgid === pgid) this._deliverSignalToOne(rec, signame);
      }
      return;
    }
    const rec = this.processes.get(targetPid);
    if (!rec) {
      const err = new Error('ESRCH: no such process: ' + targetPid);
      (err as Error & { code?: string }).code = 'ESRCH';
      throw err;
    }
    this._deliverSignalToOne(rec, signame);
  }

  private _deliverSignalToOne(rec: ProcessRecord, signame: string): void {
    // Unmaskable: SIGKILL terminates immediately; SIGSTOP best-effort no-op.
    if (signame === 'SIGKILL') {
      rec.exitSignal = 'SIGKILL';
      try { rec.handle.kill(); } catch { /* */ }
      return;
    }
    if (signame === 'SIGSTOP') {
      // Best-effort: we don't actually pause the worker (would require a host primitive)
      return;
    }
    if (signame === 'SIGCONT') {
      return;
    }
    // Other signals: dispatch envelope into the engine so process.on(signame) fires
    const dispatch = this.dispatchByPid.get(rec.pid);
    if (!dispatch) return;
    const signo = SIGNAL_NUMBERS[signame] ?? 0;
    dispatch(`if (globalThis.__process && globalThis.__process.onSignal) globalThis.__process.onSignal(${JSON.stringify(signame)}, ${signo});`);
  }

  _deliverSignalWithPayload(targetPid: number, signame: string, payload: unknown): void {
    const rec = this.processes.get(targetPid);
    if (!rec) return;
    const dispatch = this.dispatchByPid.get(rec.pid);
    if (!dispatch) return;
    const signo = SIGNAL_NUMBERS[signame] ?? 0;
    dispatch(`if (globalThis.__process && globalThis.__process.onSignal) globalThis.__process.onSignal(${JSON.stringify(signame)}, ${signo}, ${JSON.stringify(payload)});`);
  }

  /**
   * Resize the PTY attached to `pid`. Fires the `onSigwinch` hook on the Pty,
   * which (when the Pty was attached via {@link spawn}) delivers `SIGWINCH`
   * with `{cols, rows}` payload to the process.
   */
  resizePty(pid: number, cols: number, rows: number): void {
    this.ptyManager.resize(pid, cols, rows);
  }

  private _emitChildExit(rec: ProcessRecord, code: number): void {
    // SIGCHLD to parent
    const parent = this.processes.get(rec.ppid);
    if (parent) this._deliverSignalToOne(parent, 'SIGCHLD');
  }

  async createPidZero(
    baseFuncs: FuncTable,
    write: (text: string) => void,
    opts?: { user?: string; hostname?: string },
  ): Promise<EngineInstance> {
    const user = opts?.user ?? 'user';
    const hostname = opts?.hostname ?? 'duskjs';
    const dispatchHolder: DispatchHolder = { dispatch: null };
    const spawnFuncs = this.buildSpawnFuncs(dispatchHolder);
    const consoleFuncs: FuncTable = {
      'console.log': (msg, send) => {
        const text = ((msg['args'] as unknown[]) ?? []).map(String).join(' ') + '\n';
        write(text);
        send({});
      },
      'console.error': (msg, send) => {
        const text = ((msg['args'] as unknown[]) ?? []).map(String).join(' ') + '\n';
        write(text);
        send({});
      },
      // Plan 8 T1 (narrowed to pid 0 / REPL only): the world side asks the
      // host to pump a stream id's chunks to the REPL print sink. This gives
      // process.stdout / process.stderr a real Writable surface (backpressure,
      // event emitter methods) while keeping the mirror-to-write() semantics
      // the REPL host already has via 'proc.write'. Spawned children keep
      // proc.write (see makeProcWriteFallback in world/node-process.ts) so
      // pipeChildToParent isn't double-registered.
      'stream.registerStdioSink': (m, send) => {
        const id = m['id'] as number;
        this.streamRegistryImpl.register({
          id,
          producerPid: 0,
          consumerPid: 0,
          onChunk: (chunk) => {
            write(new TextDecoder().decode(chunk));
            // The REPL print sink drains synchronously — refund the credit
            // immediately and notify the engine producer so it can keep
            // flowing without blocking on the 64KB window.
            this.streamRegistryImpl.grantCredit(id, chunk.byteLength);
            const d = this.dispatchByPid.get(0);
            if (d) d(`if (globalThis.__streams) globalThis.__streams.dispatch(${id}, 'creditGranted');`);
          },
          onEnd: () => { /* stdio sinks never close */ },
          onError: () => { /* stdio errors surface elsewhere */ },
        });
        send({ value: true });
      },
    };
    const writeFunc: FuncTable = {
      'proc.write': (m, send) => {
        const data = m['data'] as number[] | undefined;
        if (data) write(new TextDecoder().decode(new Uint8Array(data)));
        send({});
      },
    };
    const funcs: FuncTable = { ...baseFuncs, ...this.buildFuncs(0), ...consoleFuncs, ...writeFunc, ...spawnFuncs };
    const engine = await createEngine(0, funcs);
    dispatchHolder.dispatch = engine.dispatch;
    this.dispatchByPid.set(0, engine.dispatch);

    // Register pid-0 record so process.bootstrap, env.set, etc. work in the REPL engine
    const home = `/home/${user}`;
    const env = new Map<string, string>([
      ['USER', user],
      ['LOGNAME', user],
      ['HOME', home],
      ['PATH', '/bin'],
      ['PWD', home],
      ['HOSTNAME', hostname],
      ['SHELL', '/bin/sh'],
      ['TERM', 'dumb'],
    ]);
    const zeroHandle: DuskProcessHandle = {
      pid: 0,
      exit: engine.exited.then(() => 0),
      stdin: { write: async () => {}, close: async () => {} },
      stdout: new ReadableStream<Uint8Array>(),
      stderr: new ReadableStream<Uint8Array>(),
      kill: () => { void engine.terminate(); },
    };
    const zeroRec: ProcessRecord = {
      pid: 0, ppid: 0, pgid: 0, sid: 0, engine, handle: zeroHandle,
      stdinBuffer: [], stdinClosed: true,
      argv: ['node'], argv0: 'node', execPath: '/bin/node',
      env, cwd: home, title: hostname, startTime: Date.now(),
    };
    this.processes.set(0, zeroRec);

    return engine;
  }

  async spawn(cmd: string, args: string[] = [], options: SpawnOptions = {}): Promise<DuskProcessHandle> {
    // Fold JSH-wrapper spawns into a direct dsh -c invocation before we
    // allocate a pid or a worker. See maybeElideJshWrapper for rationale.
    ({ cmd, args } = this.maybeElideJshWrapper(cmd, args));
    const pid = this.nextPid++;
    const stdinBytes = normalizeStdin(options.stdin);

    let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let stdoutClosed = false;
    const stdoutBacklog: Uint8Array[] = [];
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        stdoutController = c;
        for (const chunk of stdoutBacklog) c.enqueue(chunk);
        stdoutBacklog.length = 0;
        if (stdoutClosed) { try { c.close(); } catch { /* */ } }
      },
    });
    const enqueueStdout = (chunk: Uint8Array): void => {
      if (stdoutController) { try { stdoutController.enqueue(chunk); } catch { /* closed */ } }
      else stdoutBacklog.push(chunk);
    };
    const closeStdout = (): void => {
      stdoutClosed = true;
      if (stdoutController) { try { stdoutController.close(); } catch { /* */ } }
    };

    let stderrController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let stderrClosed = false;
    const stderrBacklog: Uint8Array[] = [];
    const stderr = new ReadableStream<Uint8Array>({
      start(c) {
        stderrController = c;
        for (const chunk of stderrBacklog) c.enqueue(chunk);
        stderrBacklog.length = 0;
        if (stderrClosed) { try { c.close(); } catch { /* */ } }
      },
    });
    const enqueueStderr = (chunk: Uint8Array): void => {
      if (stderrController) { try { stderrController.enqueue(chunk); } catch { /* closed */ } }
      else stderrBacklog.push(chunk);
    };
    const closeStderr = (): void => {
      stderrClosed = true;
      if (stderrController) { try { stderrController.close(); } catch { /* */ } }
    };

    // Stdin closure state — set up BEFORE PTY attach so PTY hooks can push
    // straight into this buffer (the same one `proc.readStdin` polls).
    const stdinBuffer: Uint8Array[] = [];
    let stdinClosed = false;
    if (stdinBytes) stdinBuffer.push(stdinBytes);

    let recordRef: ProcessRecord | null = null;
    let masterPty: Pty | undefined;
    if (options.pty) {
      const ptyOpts = typeof options.pty === 'object' ? options.pty : {};
      masterPty = this.ptyManager.attach(pid, ptyOpts, {
        // In cooked-mode PTY, `onSlaveStdin` fires with a full LINE (after
        // the user hits Enter). Push into the SAME closure buffer that
        // `proc.readStdin` reads from.
        onSlaveStdin: (chunk) => {
          if (stdinClosed) return;
          stdinBuffer.push(chunk);
        },
        onSignal: (sig) => { this._deliverSignal(pid, sig); },
        onSigwinch: (cols, rows) => { this._deliverSignalWithPayload(pid, 'SIGWINCH', { cols, rows }); },
      });
      // Note on echo: the discipline emits typed characters back through the
      // master (`onMasterData` on `handle.master`). Callers that want a
      // terminal-style UX (visible typing) should wire `handle.master.onMasterData`
      // themselves — we don't auto-route it into `stdout` to avoid duplicating
      // the child's own writes (which also flow through slaveWrite → master).
    }

    // Stdin writer: with PTY, bytes flow through the discipline (echo,
    // ^C/^D handling, line buffering). Without PTY, bytes go straight to
    // the raw stdin buffer.
    const stdinWriter: ProcessStdinWriter = masterPty
      ? {
          write: async (chunk) => {
            if (stdinClosed || !masterPty) return;
            masterPty.masterWrite(chunk);
          },
          close: async () => {
            stdinClosed = true;
            // Also signal EOF to the discipline so it flushes any partial line.
            if (masterPty) masterPty.masterWrite(new Uint8Array([4])); // ^D
          },
        }
      : {
          write: async (chunk) => { if (!stdinClosed) stdinBuffer.push(chunk); },
          close: async () => { stdinClosed = true; },
        };

    const ioFuncs: FuncTable = {
      'console.log': (msg, send) => {
        const text = ((msg['args'] as unknown[]) ?? []).map(String).join(' ') + '\n';
        const bytes = new TextEncoder().encode(text);
        if (masterPty) masterPty.slaveWrite(bytes);
        enqueueStdout(bytes);
        send({});
      },
      'console.error': (msg, send) => {
        const text = ((msg['args'] as unknown[]) ?? []).map(String).join(' ') + '\n';
        const bytes = new TextEncoder().encode(text);
        if (masterPty) masterPty.slaveWrite(bytes);
        enqueueStderr(bytes);
        send({});
      },
      'proc.write': (m, send) => {
        const data = m['data'] as number[] | undefined;
        const fd = (m['fd'] as number | undefined) ?? 1;
        if (data) {
          const bytes = new Uint8Array(data);
          if (masterPty) masterPty.slaveWrite(bytes);
          if (fd === 2) enqueueStderr(bytes);
          else enqueueStdout(bytes);
        }
        send({});
      },
      'proc.readStdin': (_m, send) => {
        const chunk = stdinBuffer.shift();
        if (chunk) send({ value: Array.from(chunk) });
        else if (stdinClosed) send({ value: null });
        else send({ value: [] });
      },
    };

    const dispatchHolder: DispatchHolder = { dispatch: null };

    const funcs: FuncTable = {
      ...this.buildFuncs(pid),
      ...this.netFuncs,
      ...ioFuncs,
      ...this.buildSpawnFuncs(dispatchHolder, pid),
    };

    const engine = await createEngine(pid, funcs);
    dispatchHolder.dispatch = engine.dispatch;
    this.dispatchByPid.set(pid, engine.dispatch);
    const entryJs = await this.buildEntry(cmd, args, options.env ?? {}, options.cwd ?? '/');

    const exitPromise = (async (): Promise<number> => {
      void engine.run(entryJs);
      const code = await engine.exited;
      this.dispatchByPid.delete(pid);
      // engine.exited resolves after the worker has processed all queued messages,
      // so any proc.write from the world before process.exit has already enqueued
      // into the streams via ioFuncs above.
      closeStdout();
      closeStderr();
      if (masterPty) this.ptyManager.detach(pid);
      const rec = this.processes.get(pid);
      if (rec) this._emitChildExit(rec, code);
      const tbl = this.fdTables.get(pid);
      if (tbl) {
        tbl.closeAll((entry) => { void this.fs.closeHandle(entry.backendHandle, { pid }).catch(() => {}); });
        this.fdTables.delete(pid);
      }
      this.processes.delete(pid);
      return code;
    })();

    const handle: DuskProcessHandle = {
      pid,
      exit: exitPromise,
      stdin: stdinWriter,
      stdout,
      stderr,
      kill: () => { void engine.terminate(); },
      ...(masterPty ? { master: masterPty } : {}),
    };

    const env = new Map<string, string>(Object.entries(options.env ?? {}));
    const explicitParent = (options as SpawnOptions & { _parentPid?: number })._parentPid;
    const parentPid = explicitParent !== undefined ? explicitParent : (this.processes.get(0)?.pid ?? 0);
    const record: ProcessRecord = {
      pid, ppid: parentPid, pgid: pid, sid: pid, engine, handle, stdinBuffer, stdinClosed: false,
      argv: [cmd, ...args],
      argv0: cmd,
      execPath: cmd,
      env,
      cwd: options.cwd ?? '/',
      title: cmd,
      startTime: Date.now(),
    };
    this.processes.set(pid, record);
    recordRef = record;

    return handle;
  }

  async spawnSync(cmd: string, args: string[] = [], options: SpawnOptions = {}): Promise<SpawnSyncResult> {
    ({ cmd, args } = this.maybeElideJshWrapper(cmd, args));
    const pid = this.nextPid++;
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    const stdinBuffer: Uint8Array[] = [];
    const stdinClosed = true;
    const stdinBytes = normalizeStdin(options.stdin);
    if (stdinBytes) stdinBuffer.push(stdinBytes);

    const ioFuncs: FuncTable = {
      'console.log': (msg, send) => {
        const text = ((msg['args'] as unknown[]) ?? []).map(String).join(' ') + '\n';
        stdoutChunks.push(new TextEncoder().encode(text));
        send({});
      },
      'console.error': (msg, send) => {
        const text = ((msg['args'] as unknown[]) ?? []).map(String).join(' ') + '\n';
        stderrChunks.push(new TextEncoder().encode(text));
        send({});
      },
      'proc.write': (m, send) => {
        const data = m['data'] as number[] | undefined;
        const fd = (m['fd'] as number | undefined) ?? 1;
        if (data) {
          const bytes = new Uint8Array(data);
          if (fd === 2) stderrChunks.push(bytes);
          else stdoutChunks.push(bytes);
        }
        send({});
      },
      'proc.readStdin': (_m, send) => {
        const chunk = stdinBuffer.shift();
        if (chunk) send({ value: Array.from(chunk) });
        else if (stdinClosed) send({ value: null });
        else send({ value: [] });
      },
    };

    const dispatchHolder: DispatchHolder = { dispatch: null };

    const funcs: FuncTable = {
      ...this.buildFuncs(pid),
      ...this.netFuncs,
      ...ioFuncs,
      ...this.buildSpawnFuncs(dispatchHolder, pid),
    };

    const engine = await createEngine(pid, funcs);
    dispatchHolder.dispatch = engine.dispatch;
    this.dispatchByPid.set(pid, engine.dispatch);
    const entryJs = await this.buildEntry(cmd, args, options.env ?? {}, options.cwd ?? '/');

    // register a minimal ProcessRecord for spawnSync so process.bootstrap works
    const env = new Map<string, string>(Object.entries(options.env ?? {}));
    const syncHandle: DuskProcessHandle = {
      pid,
      exit: engine.exited.then((c) => c),
      stdin: { write: async () => {}, close: async () => {} },
      stdout: new ReadableStream<Uint8Array>(),
      stderr: new ReadableStream<Uint8Array>(),
      kill: () => { void engine.terminate(); },
    };
    const syncRec: ProcessRecord = {
      pid, ppid: 0, pgid: pid, sid: pid, engine, handle: syncHandle, stdinBuffer: [], stdinClosed: true,
      argv: [cmd, ...args], argv0: cmd, execPath: cmd,
      env, cwd: options.cwd ?? '/', title: cmd, startTime: Date.now(),
    };
    this.processes.set(pid, syncRec);

    void engine.run(entryJs);
    const status = await engine.exited;
    const _rec = this.processes.get(pid);
    if (_rec) this._emitChildExit(_rec, status);
    const tbl = this.fdTables.get(pid);
    if (tbl) {
      tbl.closeAll((entry) => { void this.fs.closeHandle(entry.backendHandle, { pid }).catch(() => {}); });
      this.fdTables.delete(pid);
    }
    this.processes.delete(pid);
    this.dispatchByPid.delete(pid);

    const concat = (parts: Uint8Array[]): Uint8Array => {
      const total = parts.reduce((a, c) => a + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of parts) { out.set(c, off); off += c.length; }
      return out;
    };

    return { stdout: concat(stdoutChunks), stderr: concat(stderrChunks), status };
  }

  private buildSpawnFuncs(parentHolder: DispatchHolder, callerPid?: number): FuncTable {
    const pipeChildToParent = (
      child: DuskProcessHandle,
      stdoutStreamId: number,
      stderrStreamId: number,
    ): void => {
      const dispatch = parentHolder.dispatch;
      if (!dispatch) return;

      const pipeStream = (
        source: ReadableStream<Uint8Array>,
        kind: 'stdout' | 'stderr',
        id: number,
      ): void => {

        // The "consumer" of this registry stream is the parent engine; the
        // onChunk callback re-emits via the existing __process.dispatch path
        // so node-child-process.ts on the engine side remains source-compatible.
        let resumeWaiter: (() => void) | null = null;
        this.streamRegistryImpl.register({
          id,
          producerPid: child.pid,
          consumerPid: 0, // parent
          onChunk: (chunk) => {
            const arr = Array.from(chunk);
            dispatch(
              `if (globalThis.__process && globalThis.__process.dispatch) globalThis.__process.dispatch(${child.pid}, ${JSON.stringify(kind)}, ${JSON.stringify(arr)});`,
            );
          },
          onEnd: () => {
            dispatch(
              `if (globalThis.__process && globalThis.__process.dispatch) globalThis.__process.dispatch(${child.pid}, ${JSON.stringify(kind)}, null);`,
            );
          },
          onError: () => { /* errors surface via exit */ },
          onLow: () => { /* awaited via resumeWaiter below */ },
          onResume: () => {
            const w = resumeWaiter;
            resumeWaiter = null;
            if (w) w();
          },
        });

        void (async () => {
          const reader = source.getReader();
          try {
            while (true) {
              const r = await reader.read();
              if (r.done) {
                this.streamRegistryImpl.pushEnd(id);
                break;
              }
              const value = r.value;
              // Chunk according to DISPATCH_CHUNK_SIZE as before.
              let off = 0;
              while (off < value.length) {
                const slice = value.subarray(off, Math.min(off + DISPATCH_CHUNK_SIZE, value.length));
                off += slice.length;
                // Gate on available credit.
                while (this.streamRegistryImpl.availableCredit(id) <= 0) {
                  await new Promise<void>((resolve) => { resumeWaiter = resolve; });
                }
                this.streamRegistryImpl.pushChunk(id, slice);
              }
            }
          } catch (e) {
            this.streamRegistryImpl.pushError(id, formatErr(e));
          }
        })();
      };

      pipeStream(child.stdout, 'stdout', stdoutStreamId);
      pipeStream(child.stderr, 'stderr', stderrStreamId);

      void child.exit.then((code) => {
        dispatch(
          `if (globalThis.__process && globalThis.__process.dispatch) globalThis.__process.dispatch(${child.pid}, 'exit', ${code});`,
        );
      });
    };

    return {
      'process.spawn': (m, send) => {
        void (async () => {
          try {
            const opts = (m['options'] as SpawnOptions) ?? {};
            if (callerPid !== undefined) (opts as SpawnOptions & { _parentPid?: number })._parentPid = callerPid;
            const proc = await this.spawn(
              m['command'] as string,
              (m['args'] as string[]) ?? [],
              opts,
            );
            const stdoutStreamId = this.streamRegistryImpl.allocate();
            const stderrStreamId = this.streamRegistryImpl.allocate();
            send({ value: { pid: proc.pid, stdoutStreamId, stderrStreamId } });
            pipeChildToParent(proc, stdoutStreamId, stderrStreamId);
          } catch (e) { send({ error: formatErr(e) }); }
        })();
      },
      'process.spawnSync': (m, send) => {
        void (async () => {
          try {
            const opts = (m['options'] as SpawnOptions) ?? {};
            if (callerPid !== undefined) (opts as SpawnOptions & { _parentPid?: number })._parentPid = callerPid;
            const r = await this.spawnSync(
              m['command'] as string,
              (m['args'] as string[]) ?? [],
              opts,
            );
            send({ value: { stdout: Array.from(r.stdout), stderr: Array.from(r.stderr), status: r.status } });
          } catch (e) { send({ error: formatErr(e) }); }
        })();
      },
    };
  }

  private buildFuncs(forPid?: number): FuncTable {
    const fs = this.fs;
    const ok = (send: SendFn, value: unknown): void => send({ value });
    const err = (send: SendFn, e: unknown): void => send({ error: formatErr(e) });

    const recOf = (m: Record<string, unknown>): ProcessRecord | undefined => {
      const pid = (m['pid'] as number | undefined) ?? forPid ?? 0;
      return this.processes.get(pid);
    };

    const processFuncs: FuncTable = {
      'process.bootstrap': (m, send) => {
        const rec = recOf(m);
        if (!rec) {
          const pid = (m['pid'] as number | undefined) ?? forPid ?? 0;
          ok(send, {
            pid, ppid: 0, argv: ['node'], argv0: 'node', execArgv: [],
            execPath: '/bin/node', env: {}, cwd: '/', title: 'duskjs',
            uid: 1000, gid: 1000, hostname: 'duskjs', bootTime: Date.now(),
            isTTY: { stdin: false, stdout: false, stderr: false },
          });
          return;
        }
        ok(send, {
          pid: rec.pid,
          ppid: rec.ppid,
          argv: [...rec.argv],
          argv0: rec.argv0,
          execArgv: [],
          execPath: rec.execPath,
          env: Object.fromEntries(rec.env),
          cwd: rec.cwd,
          title: rec.title,
          uid: 1000,
          gid: 1000,
          hostname: 'duskjs',
          bootTime: rec.startTime,
          isTTY: { stdin: false, stdout: false, stderr: false },
        });
      },
      'process.chdir': (m, send) => {
        void (async () => {
          try {
            const rec = recOf(m);
            const requested = m['path'] as string;
            const resolved = requested.startsWith('/')
              ? norm(requested)
              : norm((rec?.cwd ?? '/') + '/' + requested);
            if (!(await fs.exists(resolved))) {
              send({ error: 'ENOENT: no such file or directory: ' + resolved });
              return;
            }
            const st = await fs.stat(resolved);
            if (!st.isDirectory) {
              send({ error: 'ENOTDIR: not a directory: ' + resolved });
              return;
            }
            if (rec) rec.cwd = resolved;
            ok(send, { cwd: resolved });
          } catch (e) { err(send, e); }
        })();
      },
      'process.title.set': (m, send) => {
        const rec = recOf(m);
        const title = String(m['title'] ?? '');
        if (rec) rec.title = title;
        ok(send, true);
      },
      'env.set': (m, send) => {
        const rec = recOf(m);
        const key = m['key'] as string;
        const value = m['value'] as string;
        if (rec) rec.env.set(key, value);
        ok(send, true);
      },
      'env.delete': (m, send) => {
        const rec = recOf(m);
        const key = m['key'] as string;
        if (rec) rec.env.delete(key);
        ok(send, true);
      },
      'env.get': (m, send) => {
        const rec = recOf(m);
        const key = m['key'] as string;
        ok(send, rec?.env.get(key));
      },
      'env.keys': (m, send) => {
        const rec = recOf(m);
        ok(send, rec ? [...rec.env.keys()] : []);
      },
      'process.kill': (m, send) => {
        const pid = m['pid'] as number;
        const signame = (m['signal'] as string | undefined) ?? 'SIGTERM';
        try {
          this._deliverSignal(pid, signame);
          ok(send, true);
        } catch (e) {
          err(send, e);
        }
      },
      'process.setpgid': (m, send) => {
        const pid = (m['pid'] as number) || ((m['pid'] as number) === 0 ? ((m['callerPid'] as number) ?? forPid ?? 0) : 0);
        const pgid = (m['pgid'] as number) || pid;
        const rec = this.processes.get(pid);
        if (!rec) { err(send, new Error('ESRCH: no such process: ' + pid)); return; }
        rec.pgid = pgid;
        ok(send, true);
      },
      'process.getpgid': (m, send) => {
        const pid = (m['pid'] as number) ?? forPid ?? 0;
        const rec = this.processes.get(pid);
        if (!rec) { err(send, new Error('ESRCH: no such process: ' + pid)); return; }
        ok(send, rec.pgid);
      },
    };

    const subtleAvailable = typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined' && typeof crypto.subtle.digest === 'function';

    const cryptoFuncs: FuncTable = {
      'crypto.random': (m, send) => {
        const size = (m['size'] as number) | 0;
        const buf = new Uint8Array(size);
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
        else for (let i = 0; i < size; i++) buf[i] = Math.floor(Math.random() * 256);
        ok(send, Array.from(buf));
      },
      'crypto.digest': (m, send) => {
        if (!subtleAvailable) { err(send, new Error('SubtleCrypto unavailable')); return; }
        void (async () => {
          try {
            const algorithm = (m['algorithm'] as string).toUpperCase();
            const data = m['data'] as number[];
            const buf = await crypto.subtle.digest(algorithm, Uint8Array.from(data));
            ok(send, Array.from(new Uint8Array(buf)));
          } catch (e) { err(send, e); }
        })();
      },
      'crypto.hmac': (m, send) => {
        if (!subtleAvailable) { err(send, new Error('SubtleCrypto unavailable')); return; }
        void (async () => {
          try {
            const algorithm = (m['algorithm'] as string).toUpperCase();
            const keyArr = Uint8Array.from(m['key'] as number[]);
            const data = Uint8Array.from(m['data'] as number[]);
            const key = await crypto.subtle.importKey('raw', keyArr, { name: 'HMAC', hash: algorithm }, false, ['sign']);
            const buf = await crypto.subtle.sign('HMAC', key, data);
            ok(send, Array.from(new Uint8Array(buf)));
          } catch (e) { err(send, e); }
        })();
      },
      'zlib.compress': (m, send) => {
        void (async () => {
          try {
            const format = m['format'] as 'gzip' | 'deflate' | 'deflate-raw';
            const data = Uint8Array.from(m['data'] as number[]);
            const CS = (globalThis as { CompressionStream?: new (f: string) => { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> } }).CompressionStream;
            if (!CS) { err(send, new Error('CompressionStream unavailable')); return; }
            const cs = new CS(format);
            const w = cs.writable.getWriter();
            void w.write(data); void w.close();
            const reader = cs.readable.getReader();
            const chunks: Uint8Array[] = [];
            let total = 0;
            while (true) {
              const r = await reader.read();
              if (r.done) break;
              if (r.value) { chunks.push(r.value); total += r.value.length; }
            }
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { out.set(c, off); off += c.length; }
            ok(send, Array.from(out));
          } catch (e) { err(send, e); }
        })();
      },
      'zlib.decompress': (m, send) => {
        void (async () => {
          try {
            const format = m['format'] as 'gzip' | 'deflate' | 'deflate-raw';
            const data = Uint8Array.from(m['data'] as number[]);
            const DS = (globalThis as { DecompressionStream?: new (f: string) => { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> } }).DecompressionStream;
            if (!DS) { err(send, new Error('DecompressionStream unavailable')); return; }
            const ds = new DS(format);
            const w = ds.writable.getWriter();
            void w.write(data); void w.close();
            const reader = ds.readable.getReader();
            const chunks: Uint8Array[] = [];
            let total = 0;
            while (true) {
              const r = await reader.read();
              if (r.done) break;
              if (r.value) { chunks.push(r.value); total += r.value.length; }
            }
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { out.set(c, off); off += c.length; }
            ok(send, Array.from(out));
          } catch (e) { err(send, e); }
        })();
      },
      'crypto.encrypt': (m, send) => {
        if (!subtleAvailable) { err(send, new Error('SubtleCrypto unavailable')); return; }
        void (async () => {
          try {
            const algName = (m['algorithm'] as string).toLowerCase();
            const keyBytes = Uint8Array.from(m['key'] as number[]);
            const ivBytes = Uint8Array.from(m['iv'] as number[]);
            const plaintext = Uint8Array.from(m['plaintext'] as number[]);
            let subtleAlg: AesCbcParams | AesGcmParams | AesCtrParams;
            if (algName.endsWith('-gcm')) {
              subtleAlg = { name: 'AES-GCM', iv: ivBytes };
              if (m['aad']) (subtleAlg as AesGcmParams).additionalData = Uint8Array.from(m['aad'] as number[]);
            } else if (algName.endsWith('-cbc')) {
              subtleAlg = { name: 'AES-CBC', iv: ivBytes };
            } else if (algName.endsWith('-ctr')) {
              subtleAlg = { name: 'AES-CTR', counter: ivBytes, length: 64 };
            } else {
              err(send, new Error('Unsupported cipher: ' + algName));
              return;
            }
            const key = await crypto.subtle.importKey('raw', keyBytes, subtleAlg.name, false, ['encrypt']);
            const buf = await crypto.subtle.encrypt(subtleAlg, key, plaintext);
            const out = new Uint8Array(buf);
            if (algName.endsWith('-gcm')) {
              const tagLen = 16;
              const ct = out.slice(0, out.length - tagLen);
              const tag = out.slice(out.length - tagLen);
              ok(send, { ciphertext: Array.from(ct), authTag: Array.from(tag) });
            } else {
              ok(send, { ciphertext: Array.from(out) });
            }
          } catch (e) { err(send, e); }
        })();
      },
      'crypto.decrypt': (m, send) => {
        if (!subtleAvailable) { err(send, new Error('SubtleCrypto unavailable')); return; }
        void (async () => {
          try {
            const algName = (m['algorithm'] as string).toLowerCase();
            const keyBytes = Uint8Array.from(m['key'] as number[]);
            const ivBytes = Uint8Array.from(m['iv'] as number[]);
            let ciphertext = Uint8Array.from(m['ciphertext'] as number[]);
            let subtleAlg: AesCbcParams | AesGcmParams | AesCtrParams;
            if (algName.endsWith('-gcm')) {
              subtleAlg = { name: 'AES-GCM', iv: ivBytes };
              if (m['aad']) (subtleAlg as AesGcmParams).additionalData = Uint8Array.from(m['aad'] as number[]);
              if (m['authTag']) {
                const tag = Uint8Array.from(m['authTag'] as number[]);
                const combined = new Uint8Array(ciphertext.length + tag.length);
                combined.set(ciphertext);
                combined.set(tag, ciphertext.length);
                ciphertext = combined;
              }
            } else if (algName.endsWith('-cbc')) {
              subtleAlg = { name: 'AES-CBC', iv: ivBytes };
            } else if (algName.endsWith('-ctr')) {
              subtleAlg = { name: 'AES-CTR', counter: ivBytes, length: 64 };
            } else {
              err(send, new Error('Unsupported cipher: ' + algName));
              return;
            }
            const key = await crypto.subtle.importKey('raw', keyBytes, subtleAlg.name, false, ['decrypt']);
            const buf = await crypto.subtle.decrypt(subtleAlg, key, ciphertext);
            ok(send, { plaintext: Array.from(new Uint8Array(buf)) });
          } catch (e) { err(send, e); }
        })();
      },
      'crypto.pbkdf2': (m, send) => {
        if (!subtleAvailable) { err(send, new Error('SubtleCrypto unavailable')); return; }
        void (async () => {
          try {
            const digest = (m['digest'] as string).toUpperCase();
            const pwd = Uint8Array.from(m['password'] as number[]);
            const salt = Uint8Array.from(m['salt'] as number[]);
            const iterations = m['iterations'] as number;
            const keylen = m['keylen'] as number;
            const baseKey = await crypto.subtle.importKey('raw', pwd, 'PBKDF2', false, ['deriveBits']);
            const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: digest }, baseKey, keylen * 8);
            ok(send, Array.from(new Uint8Array(bits)));
          } catch (e) { err(send, e); }
        })();
      },
      'crypto.generateKeyPair': (m, send) => {
        if (!subtleAvailable) { err(send, new Error('SubtleCrypto unavailable')); return; }
        void (async () => {
          try {
            const type = (m['type'] as string).toLowerCase();
            let algorithm: RsaHashedKeyGenParams | EcKeyGenParams;
            if (type === 'rsa' || type === 'rsa-pss') {
              const modulusLength = (m['modulusLength'] as number) || 2048;
              const hash = (m['hash'] as string | undefined) ?? 'SHA-256';
              const publicExponent = new Uint8Array([0x01, 0x00, 0x01]);
              algorithm = {
                name: type === 'rsa-pss' ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5',
                modulusLength,
                publicExponent,
                hash,
              };
            } else if (type === 'ec' || type === 'ecdsa') {
              const namedCurve = (m['namedCurve'] as string | undefined) ?? 'P-256';
              algorithm = { name: 'ECDSA', namedCurve };
            } else {
              err(send, new Error('Unsupported key type: ' + type));
              return;
            }
            const kp = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
            const pubBuf = await crypto.subtle.exportKey('spki', (kp as CryptoKeyPair).publicKey);
            const privBuf = await crypto.subtle.exportKey('pkcs8', (kp as CryptoKeyPair).privateKey);
            ok(send, {
              publicKey: Array.from(new Uint8Array(pubBuf)),
              privateKey: Array.from(new Uint8Array(privBuf)),
            });
          } catch (e) { err(send, e); }
        })();
      },
      'crypto.sign': (m, send) => {
        if (!subtleAvailable) { err(send, new Error('SubtleCrypto unavailable')); return; }
        void (async () => {
          try {
            const algName = (m['algorithm'] as string).toUpperCase();
            const keyBytes = Uint8Array.from(m['key'] as number[]);
            const data = Uint8Array.from(m['data'] as number[]);
            const keyType = (m['keyType'] as string).toLowerCase();
            // Detect signing algorithm + key import params
            let importAlg: RsaHashedImportParams | EcKeyImportParams;
            let signAlg: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
            const hash = (m['hash'] as string | undefined) ?? 'SHA-256';
            if (keyType === 'rsa') {
              importAlg = { name: 'RSASSA-PKCS1-v1_5', hash };
              signAlg = 'RSASSA-PKCS1-v1_5';
            } else if (keyType === 'rsa-pss') {
              importAlg = { name: 'RSA-PSS', hash };
              signAlg = { name: 'RSA-PSS', saltLength: (m['saltLength'] as number | undefined) ?? 32 };
            } else if (keyType === 'ec' || keyType === 'ecdsa') {
              const namedCurve = (m['namedCurve'] as string | undefined) ?? 'P-256';
              importAlg = { name: 'ECDSA', namedCurve };
              signAlg = { name: 'ECDSA', hash };
            } else {
              err(send, new Error('Unsupported key type for signing: ' + keyType));
              return;
            }
            void algName;
            const key = await crypto.subtle.importKey('pkcs8', keyBytes, importAlg, false, ['sign']);
            const sig = await crypto.subtle.sign(signAlg, key, data);
            ok(send, Array.from(new Uint8Array(sig)));
          } catch (e) { err(send, e); }
        })();
      },
      'crypto.verify': (m, send) => {
        if (!subtleAvailable) { err(send, new Error('SubtleCrypto unavailable')); return; }
        void (async () => {
          try {
            const keyBytes = Uint8Array.from(m['key'] as number[]);
            const data = Uint8Array.from(m['data'] as number[]);
            const signature = Uint8Array.from(m['signature'] as number[]);
            const keyType = (m['keyType'] as string).toLowerCase();
            let importAlg: RsaHashedImportParams | EcKeyImportParams;
            let verifyAlg: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
            const hash = (m['hash'] as string | undefined) ?? 'SHA-256';
            if (keyType === 'rsa') {
              importAlg = { name: 'RSASSA-PKCS1-v1_5', hash };
              verifyAlg = 'RSASSA-PKCS1-v1_5';
            } else if (keyType === 'rsa-pss') {
              importAlg = { name: 'RSA-PSS', hash };
              verifyAlg = { name: 'RSA-PSS', saltLength: (m['saltLength'] as number | undefined) ?? 32 };
            } else if (keyType === 'ec' || keyType === 'ecdsa') {
              const namedCurve = (m['namedCurve'] as string | undefined) ?? 'P-256';
              importAlg = { name: 'ECDSA', namedCurve };
              verifyAlg = { name: 'ECDSA', hash };
            } else {
              err(send, new Error('Unsupported key type for verify: ' + keyType));
              return;
            }
            const key = await crypto.subtle.importKey('spki', keyBytes, importAlg, false, ['verify']);
            const valid = await crypto.subtle.verify(verifyAlg, key, signature, data);
            ok(send, valid);
          } catch (e) { err(send, e); }
        })();
      },
    };

    const parseFsFlags = (raw: string | number): number => {
      if (typeof raw === 'number') return raw;
      switch (raw) {
        case 'r':   return O_RDONLY;
        case 'r+':  return O_RDWR;
        case 'w':   return O_WRONLY | O_CREAT | O_TRUNC;
        case 'wx':  return O_WRONLY | O_CREAT | O_TRUNC | O_EXCL;
        case 'w+':  return O_RDWR   | O_CREAT | O_TRUNC;
        case 'wx+': return O_RDWR   | O_CREAT | O_TRUNC | O_EXCL;
        case 'a':   return O_WRONLY | O_CREAT | O_APPEND;
        case 'ax':  return O_WRONLY | O_CREAT | O_APPEND | O_EXCL;
        case 'a+':  return O_RDWR   | O_CREAT | O_APPEND;
        case 'ax+': return O_RDWR   | O_CREAT | O_APPEND | O_EXCL;
        default: { const e: Error & { code?: string } = new Error('EINVAL: unknown flags ' + raw); e.code = 'EINVAL'; throw e; }
      }
    };

    const fsFuncs: FuncTable = {
      'fs.readFile': (m, send) => { void (async () => { try { ok(send, await fs.readFile(m['path'] as string)); } catch (e) { err(send, e); } })(); },
      'fs.readFileBytes': (m, send) => { void (async () => {
        try {
          const bytes = await fs.readFileBytes(m['path'] as string, { pid: forPid ?? 0 });
          ok(send, Array.from(bytes));
        } catch (e) { err(send, e); }
      })() },
      'fs.writeFile': (m, send) => { void (async () => { try { await fs.writeFile(m['path'] as string, m['data'] as string); ok(send, true); } catch (e) { err(send, e); } })(); },
      'fs.writeFileBytes': (m, send) => { void (async () => {
        try {
          const bytes = Uint8Array.from(m['data'] as number[]);
          await fs.writeFileBytes(m['path'] as string, bytes, { pid: forPid ?? 0 });
          ok(send, true);
        } catch (e) { err(send, e); }
      })() },
      'fs.readdir': (m, send) => { void (async () => { try { ok(send, await fs.readdir(m['path'] as string)); } catch (e) { err(send, e); } })(); },
      'fs.mkdir': (m, send) => { void (async () => { try { await fs.mkdir(m['path'] as string, { recursive: Boolean(m['recursive']) }); ok(send, true); } catch (e) { err(send, e); } })(); },
      'fs.rm': (m, send) => { void (async () => { try { await fs.rm(m['path'] as string, { recursive: Boolean(m['recursive']) }); ok(send, true); } catch (e) { err(send, e); } })(); },
      'fs.exists': (m, send) => { void (async () => { try { ok(send, await fs.exists(m['path'] as string)); } catch (e) { err(send, e); } })(); },
      'fs.stat': (m, send) => { void (async () => { try { ok(send, await fs.stat(m['path'] as string)); } catch (e) { err(send, e); } })(); },
      'fs.rename': (m, send) => { void (async () => { try { await fs.rename(m['from'] as string, m['to'] as string); ok(send, true); } catch (e) { err(send, e); } })(); },
      'fs.symlink': (m, send) => { void (async () => { try { if (!fs.symlink) { err(send, new Error('ENOTSUP: symlink not supported')); return; } await fs.symlink(m['target'] as string, m['path'] as string); ok(send, true); } catch (e) { err(send, e); } })(); },
      'fs.readlink': (m, send) => { void (async () => { try { if (!fs.readlink) { err(send, new Error('EINVAL: readlink not supported')); return; } ok(send, await fs.readlink(m['path'] as string)); } catch (e) { err(send, e); } })(); },
      'fs.lstat': (m, send) => { void (async () => { try { const path = m['path'] as string; if (fs.lstat) { ok(send, await fs.lstat(path)); } else { ok(send, await fs.stat(path)); } } catch (e) { err(send, e); } })(); },

      'fs.open': (m, send) => { void (async () => {
        try {
          const pid = (m['pid'] as number | undefined) ?? forPid ?? 0;
          const flags = parseFsFlags((m['flags'] as string | number | undefined) ?? 'r');
          const { handle, size, appendOnly } = await fs.openHandle(m['path'] as string, flags, { pid });
          const tbl = this.getOrCreateFDTable(pid);
          const fd = tbl.allocate({ backendHandle: handle, path: m['path'] as string, flags, appendOnly, position: appendOnly ? size : 0 });
          ok(send, fd);
        } catch (e) { err(send, e); }
      })(); },

      'fs.read': (m, send) => { void (async () => {
        try {
          const pid = (m['pid'] as number | undefined) ?? forPid ?? 0;
          const fd = m['fd'] as number;
          const length = m['length'] as number;
          const pos = m['position'] as number | null | undefined;
          const tbl = this.getOrCreateFDTable(pid);
          const entry = tbl.get(fd);
          if (!entry) { const e: Error & { code?: string } = new Error('EBADF: bad file descriptor'); e.code = 'EBADF'; throw e; }
          const position = (pos === null || pos === undefined) ? entry.position : pos;
          const res = await fs.readHandle(entry.backendHandle, length, position, { pid });
          if (pos === null || pos === undefined) entry.position = position + res.bytesRead;
          ok(send, { bytes: Array.from(res.bytes), bytesRead: res.bytesRead });
        } catch (e) { err(send, e); }
      })(); },

      'fs.write': (m, send) => { void (async () => {
        try {
          const pid = (m['pid'] as number | undefined) ?? forPid ?? 0;
          const fd = m['fd'] as number;
          const data = Uint8Array.from(m['data'] as number[]);
          const pos = m['position'] as number | null | undefined;
          const tbl = this.getOrCreateFDTable(pid);
          const entry = tbl.get(fd);
          if (!entry) { const e: Error & { code?: string } = new Error('EBADF: bad file descriptor'); e.code = 'EBADF'; throw e; }
          const position = entry.appendOnly ? 0 : ((pos === null || pos === undefined) ? entry.position : pos);
          const res = await fs.writeHandle(entry.backendHandle, data, position, { pid });
          if (!entry.appendOnly && (pos === null || pos === undefined)) entry.position = position + res.bytesWritten;
          else if (entry.appendOnly) entry.position = position + res.bytesWritten;
          ok(send, res.bytesWritten);
        } catch (e) { err(send, e); }
      })(); },

      'fs.close': (m, send) => { void (async () => {
        try {
          const pid = (m['pid'] as number | undefined) ?? forPid ?? 0;
          const fd = m['fd'] as number;
          const tbl = this.getOrCreateFDTable(pid);
          const entry = tbl.get(fd);
          if (!entry) { const e: Error & { code?: string } = new Error('EBADF: bad file descriptor'); e.code = 'EBADF'; throw e; }
          await fs.closeHandle(entry.backendHandle, { pid });
          tbl.release(fd);
          ok(send, true);
        } catch (e) { err(send, e); }
      })(); },

      'fs.fstat': (m, send) => { void (async () => {
        try {
          const pid = (m['pid'] as number | undefined) ?? forPid ?? 0;
          const fd = m['fd'] as number;
          const entry = this.getOrCreateFDTable(pid).get(fd);
          if (!entry) { const e: Error & { code?: string } = new Error('EBADF: bad file descriptor'); e.code = 'EBADF'; throw e; }
          ok(send, await fs.fstatHandle(entry.backendHandle, { pid }));
        } catch (e) { err(send, e); }
      })(); },

      'fs.ftruncate': (m, send) => { void (async () => {
        try {
          const pid = (m['pid'] as number | undefined) ?? forPid ?? 0;
          const fd = m['fd'] as number;
          const length = m['length'] as number;
          const entry = this.getOrCreateFDTable(pid).get(fd);
          if (!entry) { const e: Error & { code?: string } = new Error('EBADF: bad file descriptor'); e.code = 'EBADF'; throw e; }
          await fs.ftruncateHandle(entry.backendHandle, length, { pid });
          ok(send, true);
        } catch (e) { err(send, e); }
      })(); },

      'fs.fsync': (m, send) => { void (async () => {
        try {
          const pid = (m['pid'] as number | undefined) ?? forPid ?? 0;
          const fd = m['fd'] as number;
          const entry = this.getOrCreateFDTable(pid).get(fd);
          if (!entry) { const e: Error & { code?: string } = new Error('EBADF: bad file descriptor'); e.code = 'EBADF'; throw e; }
          await fs.fsyncHandle(entry.backendHandle, { pid });
          ok(send, true);
        } catch (e) { err(send, e); }
      })(); },

      'module.resolve': (m, send) => { void (async () => { try { ok(send, await resolveModule(fs, m['request'] as string, m['fromDir'] as string)); } catch (e) { err(send, e); } })(); },
      'module.readSource': (m, send) => { void (async () => { try { ok(send, await fs.readFile(m['path'] as string)); } catch (e) { err(send, e); } })(); },
    };

    const reg = this.socketRegistry;
    const dispatchByPid = this.dispatchByPid;
    const dispatchTo = (pid: number, js: string): void => {
      const d = dispatchByPid.get(pid);
      if (d) d(js);
    };

    const netFuncs: FuncTable = {
      'net.listen': (m, send) => {
        const host = (m['host'] as string | undefined) ?? '0.0.0.0';
        const port = (m['port'] as number) | 0;
        const callerPid = (m['pid'] as number | undefined) ?? forPid ?? 0;
        const serverId = reg.registerServer(host, port, callerPid, (clientSocketId) => {
          dispatchTo(callerPid, `if (globalThis.__net) globalThis.__net.dispatch('connection', ${serverId}, { clientSocketId: ${clientSocketId} });`);
        });
        send({ value: { serverId } });
      },
      'net.unlisten': (m, send) => {
        reg.unregisterServer(m['serverId'] as number);
        send({ value: true });
      },
      'net.hasLoopback': (m, send) => {
        const host = (m['host'] as string | undefined) ?? '127.0.0.1';
        const port = (m['port'] as number) | 0;
        send({ value: !!reg.findServer(host, port) });
      },
      'net.connect': (m, send) => {
        const host = (m['host'] as string | undefined) ?? '127.0.0.1';
        const port = (m['port'] as number) | 0;
        const srv = reg.findServer(host, port);
        if (!srv) {
          send({ error: 'ECONNREFUSED: connect ' + host + ':' + port });
          return;
        }
        const callerPid = (m['pid'] as number | undefined) ?? forPid ?? 0;
        const clientSocketId = reg.allocateSocketId();
        const serverSocketId = reg.allocateSocketId();

        // Pair: client→server data, server→client data
        const clientToServer: SocketPair = {
          pushToClient: (chunk) => {
            // server pushing back to the client
            dispatchTo(callerPid, `if (globalThis.__net) globalThis.__net.dispatch('data', ${clientSocketId}, ${JSON.stringify(Array.from(chunk))});`);
          },
          closeClient: () => {
            dispatchTo(callerPid, `if (globalThis.__net) globalThis.__net.dispatch('end', ${clientSocketId});`);
          },
          errorClient: (msg) => {
            dispatchTo(callerPid, `if (globalThis.__net) globalThis.__net.dispatch('error', ${clientSocketId}, ${JSON.stringify(msg)});`);
          },
        };
        const serverToClient: SocketPair = {
          pushToClient: (chunk) => {
            dispatchTo(srv.enginePid, `if (globalThis.__net) globalThis.__net.dispatch('data', ${serverSocketId}, ${JSON.stringify(Array.from(chunk))});`);
          },
          closeClient: () => {
            dispatchTo(srv.enginePid, `if (globalThis.__net) globalThis.__net.dispatch('end', ${serverSocketId});`);
          },
          errorClient: (msg) => {
            dispatchTo(srv.enginePid, `if (globalThis.__net) globalThis.__net.dispatch('error', ${serverSocketId}, ${JSON.stringify(msg)});`);
          },
        };
        // clientSocket's outbound data flows to the server-side via serverToClient
        reg.setPair(clientSocketId, serverToClient);
        // serverSocket's outbound data flows to the client-side via clientToServer
        reg.setPair(serverSocketId, clientToServer);

        send({ value: { socketId: clientSocketId, remoteAddress: host, remotePort: port } });

        // After connect resolves, notify the server that a new connection arrived.
        // serverSocketId is what the server-side will use to refer to this connection.
        srv.onConnection(serverSocketId);
      },
      'net.send': (m, send) => {
        const socketId = m['socketId'] as number;
        const data = Uint8Array.from(m['data'] as number[]);
        const pair = reg.getPair(socketId);
        if (pair) pair.pushToClient(data);
        send({ value: true });
      },
      'net.shutdown': (m, send) => {
        const socketId = m['socketId'] as number;
        const pair = reg.getPair(socketId);
        if (pair) pair.closeClient();
        send({ value: true });
      },
      'net.close': (m, send) => {
        const socketId = m['socketId'] as number;
        const pair = reg.getPair(socketId);
        if (pair) pair.closeClient();
        reg.removePair(socketId);
        send({ value: true });
      },
      'http.fetchRequest': (m, send) => {
        void (async () => {
          try {
            const url = m['url'] as string;
            const method = (m['method'] as string | undefined) ?? 'GET';
            const headers = (m['headers'] as Record<string, string> | undefined) ?? {};
            const body = m['body'] as number[] | undefined;
            const opts: RequestInit = { method, headers };
            if (body && body.length > 0 && method !== 'GET' && method !== 'HEAD') {
              opts.body = Uint8Array.from(body);
            }
            const res = await fetch(url, opts);
            const respHeaders: string[] = [];
            res.headers.forEach((value, key) => {
              respHeaders.push(key, value);
            });
            const buf = new Uint8Array(await res.arrayBuffer());
            send({
              value: {
                status: res.status,
                statusText: res.statusText,
                headers: respHeaders,
                body: Array.from(buf),
              },
            });
          } catch (e) { err(send, e); }
        })();
      },
      'worker.spawn': (m, send) => {
        void (async () => {
          try {
            const filename = m['filename'] as string;
            const workerData = m['workerData'];
            const evalMode = m['evalMode'] === true;
            const parentPid = (m['pid'] as number | undefined) ?? forPid ?? 0;
            const workerPid = this.nextPid++;

            // Build worker funcs (subset of spawn's, no spawning-from-worker for now)
            const workerHolder: DispatchHolder = { dispatch: null };
            const workerFuncs: FuncTable = {
              ...this.buildFuncs(workerPid),
              ...this.netFuncs,
              'worker.postToParent': (msg, s) => {
                const data = msg['data'];
                const parentDispatch = dispatchByPid.get(parentPid);
                if (parentDispatch) {
                  parentDispatch(`if (globalThis.__worker) globalThis.__worker.dispatchMessage(${parentPid}, ${workerPid}, ${JSON.stringify(data)});`);
                }
                s({ value: true });
              },
            };
            const workerEngine = await createEngine(workerPid, workerFuncs);
            workerHolder.dispatch = workerEngine.dispatch;
            this.dispatchByPid.set(workerPid, workerEngine.dispatch);

            // Register a minimal record so process.bootstrap works
            const env = new Map<string, string>();
            const workerHandle: DuskProcessHandle = {
              pid: workerPid,
              exit: workerEngine.exited.then((c) => c),
              stdin: { write: async () => {}, close: async () => {} },
              stdout: new ReadableStream<Uint8Array>(),
              stderr: new ReadableStream<Uint8Array>(),
              kill: () => { void workerEngine.terminate(); },
            };
            this.processes.set(workerPid, {
              pid: workerPid, ppid: parentPid, pgid: workerPid, sid: workerPid,
              engine: workerEngine, handle: workerHandle,
              stdinBuffer: [], stdinClosed: true,
              argv: ['node', filename], argv0: 'node', execPath: '/bin/node',
              env, cwd: '/', title: 'worker', startTime: Date.now(),
            });

            // Build worker entry: set globals + load + run
            let body: string;
            if (evalMode) {
              body = filename;
            } else {
              // Read worker source from FS
              body = `(new Function(__fs.readFile(${JSON.stringify(filename)})))();`;
            }
            const workerJs = [
              `globalThis.__DUSK_WORKER_DATA__ = ${JSON.stringify(workerData ?? null)};`,
              `globalThis.__DUSK_PARENT_PID__ = ${parentPid};`,
              `try { ${body} } catch (e) { try { console.error(String(e)); } catch (_) {} try { process.exit(1); } catch (_) {} }`,
            ].join('\n');

            void workerEngine.run(workerJs);
            // Wire exit dispatch back to parent
            void workerEngine.exited.then((code) => {
              this.processes.delete(workerPid);
              this.dispatchByPid.delete(workerPid);
              const parentDispatch = dispatchByPid.get(parentPid);
              if (parentDispatch) {
                parentDispatch(`if (globalThis.__worker) globalThis.__worker.dispatchExit(${workerPid}, ${code});`);
              }
            });

            ok(send, { pid: workerPid });
          } catch (e) { err(send, e); }
        })();
      },
      'worker.postToChild': (m, send) => {
        const pid = m['pid'] as number;
        const data = m['data'];
        const childDispatch = dispatchByPid.get(pid);
        if (childDispatch) {
          childDispatch(`if (globalThis.__worker) globalThis.__worker.dispatchMessage(${pid}, ${(m['pid'] as number | undefined) ?? forPid ?? 0}, ${JSON.stringify(data)});`);
        }
        ok(send, true);
      },
      'worker.terminate': (m, send) => {
        const pid = m['pid'] as number;
        const rec = this.processes.get(pid);
        if (rec) {
          void rec.engine.terminate();
        }
        ok(send, true);
      },
      'stream.allocate': (_m, send) => {
        ok(send, { id: this.streamRegistryImpl.allocate() });
      },
      'stream.registerSink': (m, send) => {
        // The engine that calls this becomes the consumer; chunks arrive via dispatch.
        const id = m['id'] as number;
        const consumerPid = (m['pid'] as number | undefined) ?? forPid ?? 0;
        const producerPid = (m['producerPid'] as number | undefined) ?? 0;
        this.streamRegistryImpl.register({
          id,
          producerPid,
          consumerPid,
          onChunk: (chunk) => {
            const d = this.dispatchByPid.get(consumerPid);
            if (!d) return;
            d(`if (globalThis.__streams) globalThis.__streams.dispatch(${id}, 'chunk', ${JSON.stringify(Array.from(chunk))});`);
          },
          onEnd: () => {
            const d = this.dispatchByPid.get(consumerPid);
            if (d) d(`if (globalThis.__streams) globalThis.__streams.dispatch(${id}, 'end');`);
          },
          onError: (msg) => {
            const d = this.dispatchByPid.get(consumerPid);
            if (d) d(`if (globalThis.__streams) globalThis.__streams.dispatch(${id}, 'error', ${JSON.stringify(msg)});`);
          },
          onConsumerClose: () => {
            // Deliver SIGPIPE to the producer pid. If the producer is already
            // gone, swallow ESRCH.
            try { this._deliverSignal(producerPid, 'SIGPIPE') } catch { /* ESRCH ok */ }
          },
        });
        ok(send, true);
      },
      'stream.pushChunk': (m, send) => {
        const id = m['id'] as number;
        const data = m['data'] as number[];
        this.streamRegistryImpl.pushChunk(id, Uint8Array.from(data));
        // Return the remaining credit so the engine-side producer can park
        // when the host window is exhausted. See engine-streams.ts
        // createStreamWritable.
        send({ value: { credit: this.streamRegistryImpl.availableCredit(id) } });
      },
      'stream.pushEnd': (m, send) => {
        const id = m['id'] as number;
        this.streamRegistryImpl.pushEnd(id);
        ok(send, true);
      },
      'stream.pushError': (m, send) => {
        const id = m['id'] as number;
        this.streamRegistryImpl.pushError(id, (m['message'] as string) ?? '');
        ok(send, true);
      },
      'stream.grantCredit': (m, send) => {
        const id = m['id'] as number;
        const amount = m['amount'] as number;
        this.streamRegistryImpl.grantCredit(id, amount);
        // Notify the producer engine (if registered) that credit is available
        // so any parked `createStreamWritable.write` callbacks can resume.
        const reg = this.streamRegistryImpl.get(id);
        if (reg) {
          const d = this.dispatchByPid.get(reg.producerPid);
          if (d) d(`if (globalThis.__streams) globalThis.__streams.dispatch(${id}, 'creditGranted');`);
        }
        ok(send, true);
      },
      'stream.close': (m, send) => {
        const id = m['id'] as number;
        this.streamRegistryImpl.close(id);
        ok(send, true);
      },
      'tty.isatty': (m, send) => {
        const pid = (m['pid'] as number | undefined) ?? forPid ?? 0;
        const fd = m['fd'] as number;
        const pty = this.ptyManager.get(pid);
        ok(send, !!pty && (fd === 0 || fd === 1 || fd === 2));
      },
      'tty.getWinSize': (m, send) => {
        const pid = (m['pid'] as number | undefined) ?? forPid ?? 0;
        const pty = this.ptyManager.get(pid);
        if (!pty) { ok(send, [80, 24]); return; }
        ok(send, [pty.cols, pty.rows]);
      },
      'tty.setRawMode': (m, send) => {
        const pid = (m['pid'] as number | undefined) ?? forPid ?? 0;
        const raw = m['raw'] as boolean;
        const pty = this.ptyManager.get(pid);
        if (pty) pty.setRawMode(raw);
        ok(send, true);
      },
      'tty.resize': (m, send) => {
        const pid = (m['pid'] as number | undefined) ?? forPid ?? 0;
        const cols = m['cols'] as number;
        const rows = m['rows'] as number;
        this.ptyManager.resize(pid, cols, rows);
        // Emit SIGWINCH to the process with (cols, rows) payload
        this._deliverSignalWithPayload(pid, 'SIGWINCH', { cols, rows });
        ok(send, true);
      },
      'dns.lookup': (m, send) => {
        const hostname = m['hostname'] as string;
        // Best-effort: localhost/127.0.0.1 always resolve to 127.0.0.1.
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') {
          send({ value: '127.0.0.1' });
          return;
        }
        send({ value: hostname });
      },
    };

    return { ...processFuncs, ...cryptoFuncs, ...netFuncs, ...fsFuncs };
  }

  private async buildEntry(cmd: string, args: string[], env: Record<string, string>, cwd: string): Promise<string> {
    const argv = [cmd, ...args];
    const prelude =
      `process.argv = ${JSON.stringify(argv)};\n` +
      `process.env = ${JSON.stringify(env)};\n` +
      `process.chdir(${JSON.stringify(cwd)});\n`;

    const builtin = await this.resolveBinary(cmd);
    let body: string;
    if (builtin !== undefined) {
      body = builtin;
    } else {
      body = `(new Function(__fs.readFile(${JSON.stringify(cmd)})))();`;
    }

    // Wrap body in an async IIFE so bundle code that uses fire-and-forget
    // promises (e.g. `main().then(...)`) gets awaited before we check exitCode.
    // We additionally wait one extra microtask cycle to allow chained .then()
    // resolutions a chance to fire.
    //
    // A body may declare an intent to run long by setting
    // `globalThis.__process._exitReserved = true`. When set, we DO NOT
    // auto-exit 0 after the awaited IIFE returns — instead we await
    // `__process.__mainPromise` (if present) or `__process.__keepAlive`
    // (a never-resolving promise sentinel). The body is expected to call
    // `process.exit(N)` itself when done. This lets interactive binaries
    // (/bin/sh REPL, /bin/node REPL) stay alive across their stdin loops
    // without top-level `await` in the esbuild IIFE bundle output.
    return `${prelude}try { await (async () => { ${body}\n })(); await Promise.resolve(); await Promise.resolve(); const __p = globalThis.__process; if (__p && __p._exitReserved && __p._exitCode === undefined) { await (__p.__mainPromise ?? new Promise(function(){})); } if (typeof process !== 'undefined' && process.exit && !(__p && __p._exitCode !== undefined)) process.exit(0); } catch (e) { try { console.error(String(e)); } catch (_) {} try { process.exit(1); } catch (_) {} }`;
  }
}
