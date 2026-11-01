import { createNativeEngine, type EngineFactory, type EngineInstance, type FuncTable, type SendFn } from './engine-instance';
import type { FSBackend, FSMutation } from './fs-backend';
import { createFDTable, type FDTable } from './fd-table';
import { norm } from './vfs';
import { createNativePackageRegistry, type NativePackageRegistry, type NativePackageReplacementEntries, type NativePackageReplacementEntry } from './native-package-registry';
import { esbuildWasmReplacementSource } from './esbuild-wasm';
import { rollupBrowserReplacementSource, rollupParseAstReplacementSource } from './rollup-browser';
import { SERIAL_RES_SIZE } from '../protocol/messages';
import dshBinarySource from '../binaries/dsh/binary-entry.ts?worldsrc';
import { loadDpmWasmCommand, type DpmHostCapabilities, type DpmHttpResponse, type DpmWasmCommand } from './dpm-wasm';
import { BUILTIN_BINARIES, JSH_COMMAND_SET } from './builtin-binaries';
import { createSocketRegistry, type SocketRegistry, type SocketPair } from './socket-registry';
import { createStreamRegistry, type StreamRegistry } from './stream-registry';
import { createPtyManager, type PtyManager, type Pty } from './pty';
import { createRelayTlsServer, type RelayListenAuthorizer, type TlsServerConnection } from './relay-tls-server';
import type { TcpProvider, TcpStream } from './tcp';
import { createDnsFuncs, type DnsResolver } from './dns';
import { assertAllowed, type NetworkPolicy } from './network-policy';
import { createCryptoFuncs } from './crypto-funcs';
import { createFsFuncs } from './fs-funcs';
import { formatHostError } from './host-errors';

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8,
  SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
  SIGSTKFLT: 16, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22,
  SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29,
  SIGPWR: 30, SIGSYS: 31,
};

const textEncoder = new TextEncoder();

const INTERRUPTING_SIGNALS = new Set(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGTSTP']);

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

export interface HostBinaryContext {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: Uint8Array;
}

export interface HostBinaryResult {
  status?: number;
  stdout?: string | Uint8Array;
  stderr?: string | Uint8Array;
}

export type HostBinary = (context: HostBinaryContext) => HostBinaryResult | Promise<HostBinaryResult>;

export interface StreamingHostBinaryContext {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: ReadableStream<Uint8Array>;
  stdout(chunk: Uint8Array): Promise<void>;
  stderr(chunk: Uint8Array): Promise<void>;
}

export interface StreamingHostProcess {
  exit: Promise<number>;
  kill(): void;
}

export type StreamingHostBinary = (context: StreamingHostBinaryContext) => StreamingHostProcess | Promise<StreamingHostProcess>;

export interface RelaySocket {
  onData(cb: (data: Uint8Array) => void): () => void;
  onClose(cb: (reason: number) => void): () => void;
  send(data: Uint8Array): void;
  close(reason?: number): void;
}

export interface RelayListener {
  registerListener(host: string, port: number, handler: (socket: RelaySocket) => void): () => void;
  authorizeListen?: RelayListenAuthorizer;
}

/** The narrow MoonBeam surface available to approved host integrations. */
export interface MoonbeamAttachableRelay {
  attach(metadata?: MoonbeamAttachmentMetadata): MessagePort;
}

export interface MoonbeamAttachmentMetadata {
  label?: string;
}

export interface DuskRelayCapability {
  attach(metadata?: MoonbeamAttachmentMetadata): MessagePort;
}

export type SshHostKeyVerification =
  | { knownHosts: readonly string[] }
  | { hostKeyFingerprint: string }
  | { hostKey: string }
  | { insecureSkipHostKeyVerification: true }
  | { trustOnFirstUse: true };

export interface SshWasmSource {
  wasmPath: string;
  wasmExecPath: string;
}

export interface SshAdapterContext {
  relay: DuskRelayCapability;
  readFile(path: string, cwd: string): Promise<string>;
  hostKeyVerification: SshHostKeyVerification;
  wasm: SshWasmSource;
  registerSsh(binary: StreamingHostBinary): void;
}

export interface SshAdapter {
  register(context: SshAdapterContext): void;
}

export interface SshOptions {
  adapter: SshAdapter;
  hostKeyVerification: SshHostKeyVerification;
  wasm: SshWasmSource;
}

export interface ProcessLimits {
  maxProcesses?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ProcessManagerEventMap {
  spawn: { pid: number; ppid: number; command: string; args: string[]; cwd: string };
  exit: { pid: number; code: number; signal?: string };
  stdout: { pid: number; chunk: Uint8Array };
  stderr: { pid: number; chunk: Uint8Array };
}

export interface LoopbackConnection {
  write(chunk: Uint8Array): void;
  end(): void;
  close(): void;
  onData(listener: (chunk: Uint8Array) => void): () => void;
  onEnd(listener: () => void): () => void;
  onError(listener: (message: string) => void): () => void;
}

export interface ProcessManagerOptions {
  limits?: ProcessLimits;
  networkPolicy?: NetworkPolicy;
  relay?: RelayListener;
  relayTls?: {
    Connection: new (certificateChain: string | Uint8Array, privateKey: string | Uint8Array, options?: unknown) => TlsServerConnection;
    authorize: RelayListenAuthorizer;
  };
  cleanupNetworkForPid?: (pid: number) => void;
  /** Generic outbound TCP transport available to guest node:net clients. */
  tcpProvider?: TcpProvider;
  engineFactory?: EngineFactory;
  dpmWasm?: DpmWasmCommand;
  dpmFetch?: (url: string) => Promise<DpmHttpResponse>;
  dpmFetchBytes?: (url: string) => Promise<Uint8Array>;
  nativePackageReplacements?: NativePackageReplacementEntries;
  /** Enables a host-supplied SSH bridge over the configured MoonBeam relay. */
  ssh?: SshOptions;
  dns?: DnsResolver;
}

export type { DpmWasmCommand } from './dpm-wasm';

interface RelaySocketRecord {
  socket: RelaySocket;
  serverId: number;
  pid: number;
  offData: () => void;
  offClose: () => void;
}

interface RelayServerRecord {
  pid: number;
  dispose: () => void;
  socketIds: Set<number>;
}

interface ExternalTcpSocketRecord {
  pid: number;
  stream?: TcpStream;
  closed: boolean;
  connected: boolean;
  pendingWrites: Uint8Array[];
  shutdownRequested: boolean;
  pendingEvents: Array<{ kind: 'data' | 'end' | 'error'; payload?: unknown }>;
}

interface ProcessRecord {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  engine?: EngineInstance;
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
  signalListeners: Set<string>;
  exitSignal?: string;
  interruptStdinWait?: (signal: string) => void;
}



interface DispatchHolder {
  dispatch: ((js: string) => void) | null;
}

interface InternalSpawnOptions extends SpawnOptions {
  _parentPid?: number;
  _processGroup?: number;
  _onChildExit?: (emit: () => void) => void;
}

const formatErr = formatHostError;

const normalizeStdin = (stdin: unknown): Uint8Array | undefined => {
  if (stdin === undefined || stdin === null) return undefined;
  if (stdin instanceof Uint8Array) return stdin;
  if (Array.isArray(stdin)) return Uint8Array.from(stdin as number[]);
  if (typeof stdin === 'string') return textEncoder.encode(stdin);
  if (typeof stdin === 'object') {
    const vals = Object.values(stdin as Record<string, unknown>);
    if (vals.every((v) => typeof v === 'number')) return Uint8Array.from(vals as number[]);
  }
  return undefined;
};

export class ProcessManager {
  private fs: FSBackend;
  private netFuncs: FuncTable;
  private binaries = new Map<string, string>();
  private hostBinaries = new Map<string, HostBinary>();
  private streamingHostBinaries = new Map<string, StreamingHostBinary>();
  private aliases = new Map<string, { target: string; args: string[] }>();
  private processes = new Map<number, ProcessRecord>();
  private nextPid = 1;
  private socketRegistry: SocketRegistry = createSocketRegistry();
  private relay: RelayListener | undefined;
  private relayGeneration = 0;
  private closed = false;
  private relayTls: ProcessManagerOptions['relayTls'];
  private networkCleanup: ((pid: number) => void) | undefined;
  private relayServers = new Map<number, RelayServerRecord>();
  private relaySockets = new Map<number, RelaySocketRecord>();
  private externalTcpSockets = new Map<number, ExternalTcpSocketRecord>();
  private readonly tcpProvider: TcpProvider | undefined;
  private streamRegistryImpl: StreamRegistry = createStreamRegistry();

  public get streamRegistry(): StreamRegistry {
    return this.streamRegistryImpl;
  }
  private ptyManager: PtyManager = createPtyManager();
  private dispatchByPid = new Map<number, (js: string) => void>();
  private stagerByPid = new Map<number, (bytes: Uint8Array) => string>();

  private bytesExpr(pid: number, bytes: Uint8Array): string {
    const stage = this.stagerByPid.get(pid);
    return stage ? stage(bytes) : JSON.stringify(Array.from(bytes));
  }

  private trackEngine(pid: number, engine: EngineInstance): void {
    this.dispatchByPid.set(pid, engine.dispatch);
    if (engine.stageBytes) this.stagerByPid.set(pid, engine.stageBytes);
  }

  private untrackEngine(pid: number): void {
    this.dispatchByPid.delete(pid);
    this.stagerByPid.delete(pid);
  }
  private fdTables = new Map<number, FDTable>();
  private fsWatchSubscriptions = new Map<number, Map<number, () => void>>();
  private nextFSWatchSubscription = 1;
  private pendingFSWatchMutations = new Map<number, Map<number, Map<string, FSMutation>>>();
  private fsWatchDispatchScheduled = new Set<number>();

  private clearFSWatchSubscriptions(pid: number): void {
    const subscriptions = this.fsWatchSubscriptions.get(pid);
    if (!subscriptions) return;
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    this.fsWatchSubscriptions.delete(pid);
    this.pendingFSWatchMutations.delete(pid);
    this.fsWatchDispatchScheduled.delete(pid);
  }

  private queueFSWatchMutation(pid: number, id: number, event: FSMutation): void {
    let bySubscription = this.pendingFSWatchMutations.get(pid);
    if (!bySubscription) {
      bySubscription = new Map();
      this.pendingFSWatchMutations.set(pid, bySubscription);
    }
    let events = bySubscription.get(id);
    if (!events) {
      events = new Map();
      bySubscription.set(id, events);
    }
    events.set(`${event.type}\0${event.path}\0${event.previousPath ?? ''}`, event);
    if (this.fsWatchDispatchScheduled.has(pid)) return;
    this.fsWatchDispatchScheduled.add(pid);
    setTimeout(() => {
      this.fsWatchDispatchScheduled.delete(pid);
      const pending = this.pendingFSWatchMutations.get(pid);
      this.pendingFSWatchMutations.delete(pid);
      const dispatch = this.dispatchByPid.get(pid);
      if (!pending || !dispatch) return;
      for (const [subscriptionId, mutations] of pending) {
        for (const mutation of mutations.values()) {
          dispatch(`globalThis.__fsWatch?.dispatch(${subscriptionId}, ${JSON.stringify(mutation)});`);
        }
      }
    }, 0);
  }

  private getOrCreateFDTable(pid: number): FDTable {
    let t = this.fdTables.get(pid);
    if (!t) { t = createFDTable(); this.fdTables.set(pid, t); }
    return t;
  }

  // Optional binaries loaded on first spawn. Keeps ~500KB+ of parsed JS
  // off the idle heap when the demo/user never invokes these directly.
  // Note: dsh's built-in python3 command goes through host IPC and does not
  // need /bin/python3. Optional extensions register their own binaries.
  private lazyLoaders: Map<string, () => Promise<string>> = new Map();
  private readonly engineFactory: EngineFactory;
  private readonly dpmWasm: DpmWasmCommand | undefined;
  private readonly dpmFetch: ((url: string) => Promise<DpmHttpResponse>) | undefined;
  private readonly dpmFetchBytes: ((url: string) => Promise<Uint8Array>) | undefined;
  private dpmTransactions = new Map<string, Promise<void>>();
  private nextDpmTransactionId = 0;
  private readonly nativePackageRegistry: NativePackageRegistry;
  private readonly dnsFuncs: FuncTable;
  private readonly limits: ProcessLimits;
  private readonly networkPolicy: NetworkPolicy | undefined;
  private pendingSpawns = 0;
  private disposed = false;
  private eventListeners = new Map<keyof ProcessManagerEventMap, Set<(payload: never) => void>>();

  on<K extends keyof ProcessManagerEventMap>(event: K, listener: (payload: ProcessManagerEventMap[K]) => void): () => void {
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => this.off(event, listener);
  }

  off<K extends keyof ProcessManagerEventMap>(event: K, listener: (payload: ProcessManagerEventMap[K]) => void): void {
    this.eventListeners.get(event)?.delete(listener as (payload: never) => void);
  }

  private emitEvent<K extends keyof ProcessManagerEventMap>(event: K, payload: ProcessManagerEventMap[K]): void {
    const set = this.eventListeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as (payload: ProcessManagerEventMap[K]) => void)(payload);
      } catch (error) {
        queueMicrotask(() => { throw error; });
      }
    }
  }

  private assertCanSpawn(): void {
    if (this.disposed) throw new Error('ProcessManager has been disposed');
    const max = this.limits.maxProcesses;
    if (max === undefined) return;
    let active = this.pendingSpawns;
    for (const pid of this.processes.keys()) if (pid !== 0) active++;
    if (active >= max) {
      const error = new Error(`EAGAIN: process limit reached (${max})`);
      (error as Error & { code?: string }).code = 'EAGAIN';
      throw error;
    }
  }

  private watchProcess(pid: number, cmd: string, args: string[], options: SpawnOptions, handle: DuskProcessHandle): void {
    const record = this.processes.get(pid);
    this.emitEvent('spawn', { pid, ppid: record?.ppid ?? 0, command: cmd, args: [...args], cwd: options.cwd ?? '/' });
    const timeoutMs = this.limits.timeoutMs;
    if (timeoutMs === undefined) return;
    const timer = setTimeout(() => {
      const rec = this.processes.get(pid);
      if (rec) rec.exitSignal = 'SIGKILL';
      handle.kill();
    }, timeoutMs);
    void handle.exit.finally(() => clearTimeout(timer));
  }

  connectLoopback(port: number, host = 'localhost'): LoopbackConnection {
    const server = this.socketRegistry.findServer(host, port);
    if (!server) {
      const error = new Error(`ECONNREFUSED: connect ECONNREFUSED ${host}:${port}`);
      (error as Error & { code?: string }).code = 'ECONNREFUSED';
      throw error;
    }
    const reg = this.socketRegistry;
    const clientSocketId = reg.allocateSocketId();
    const serverSocketId = reg.allocateSocketId();
    const dataListeners = new Set<(chunk: Uint8Array) => void>();
    const endListeners = new Set<() => void>();
    const errorListeners = new Set<(message: string) => void>();
    let closed = false;
    const dispatchServer = (js: string): void => { this.dispatchByPid.get(server.enginePid)?.(js); };
    const toServer: SocketPair = {
      pushToClient: (chunk) => dispatchServer(`if (globalThis.__net) globalThis.__net.dispatch('data', ${serverSocketId}, ${this.bytesExpr(server.enginePid, chunk)});`),
      closeClient: () => dispatchServer(`if (globalThis.__net) globalThis.__net.dispatch('end', ${serverSocketId});`),
      errorClient: (message) => dispatchServer(`if (globalThis.__net) globalThis.__net.dispatch('error', ${serverSocketId}, ${JSON.stringify(message)});`),
    };
    const toHost: SocketPair = {
      pushToClient: (chunk) => { for (const listener of dataListeners) listener(chunk.slice()); },
      closeClient: () => { for (const listener of endListeners) listener(); },
      errorClient: (message) => { for (const listener of errorListeners) listener(message); },
    };
    reg.setPair(clientSocketId, toServer);
    reg.setPair(serverSocketId, toHost);
    server.onConnection(serverSocketId);
    const subscribe = <T>(set: Set<T>, listener: T): (() => void) => {
      set.add(listener);
      return () => set.delete(listener);
    };
    return {
      write: (chunk) => { if (!closed) toServer.pushToClient(chunk); },
      end: () => { if (!closed) toServer.closeClient(); },
      close: () => {
        if (closed) return;
        closed = true;
        toServer.closeClient();
        reg.removePair(clientSocketId);
        reg.removePair(serverSocketId);
        dataListeners.clear();
        endListeners.clear();
        errorListeners.clear();
      },
      onData: (listener) => subscribe(dataListeners, listener),
      onEnd: (listener) => subscribe(endListeners, listener),
      onError: (listener) => subscribe(errorListeners, listener),
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const exits: Promise<unknown>[] = [];
    for (const record of this.processes.values()) {
      if (record.pid === 0) continue;
      exits.push(record.handle.exit.catch(() => undefined));
      try { record.handle.kill(); } catch { }
    }
    await Promise.race([Promise.all(exits), new Promise((resolve) => setTimeout(resolve, 2000))]);
    const zero = this.processes.get(0);
    if (zero?.engine) await zero.engine.terminate().catch(() => 0);
    this.close();
    for (const pid of [...this.fsWatchSubscriptions.keys()]) this.clearFSWatchSubscriptions(pid);
    for (const [pid, table] of this.fdTables) {
      table.closeAll((entry) => { void this.fs.closeHandle(entry.backendHandle, { pid }).catch(() => {}); });
    }
    this.fdTables.clear();
    this.processes.clear();
    this.dispatchByPid.clear();
    this.stagerByPid.clear();
    this.eventListeners.clear();
  }

  constructor(
    fs: FSBackend,
    netFuncs: FuncTable = {},
    extraFuncs: FuncTable = {},
    options: ProcessManagerOptions = {},
  ) {
    this.fs = fs;
    this.netFuncs = { ...netFuncs, ...extraFuncs };
    this.relay = options.relay;
    this.relayTls = options.relayTls;
    this.networkCleanup = options.cleanupNetworkForPid;
    this.tcpProvider = options.tcpProvider;
    this.engineFactory = options.engineFactory ?? createNativeEngine;
    this.dpmWasm = options.dpmWasm;
    this.dpmFetch = options.dpmFetch;
    this.dpmFetchBytes = options.dpmFetchBytes;
    this.limits = options.limits ?? {};
    this.networkPolicy = options.networkPolicy;
    this.dnsFuncs = createDnsFuncs({
      ...(options.dns ? { resolver: options.dns } : {}),
      isLocalHost: (hostname) => this.socketRegistry.hasHost(hostname),
    });
    const defaultNativePackageReplacements: readonly NativePackageReplacementEntry[] = [
      ['esbuild', esbuildWasmReplacementSource],
      ['rollup', rollupBrowserReplacementSource, { packageVersion: '4.20.0', packagePathSuffix: '/node_modules/vite/node_modules/rollup', packageEntryPath: 'dist/rollup.js' }],
      ['rollup/parseAst', rollupParseAstReplacementSource, { packageVersion: '4.20.0', packagePathSuffix: '/node_modules/vite/node_modules/rollup' }],
    ];
    const callerEntries: readonly NativePackageReplacementEntry[] = !options.nativePackageReplacements
      ? []
      : Array.isArray(options.nativePackageReplacements)
        ? options.nativePackageReplacements
        : Object.entries(options.nativePackageReplacements).map(([specifier, source]) => [specifier, source]);
    const replacementEntries = new Map<string, NativePackageReplacementEntry>();
    for (const entry of defaultNativePackageReplacements) replacementEntries.set(entry[0], entry);
    for (const entry of callerEntries) replacementEntries.set(entry[0], entry);
    this.nativePackageRegistry = createNativePackageRegistry([...replacementEntries.values()]);
    // /bin/dsh (Dusk SHell) is the canonical shell. /bin/sh and /bin/jsh
    // are aliases so scripts using shebang `#!/bin/sh` and existing
    // demos/tests that reference /bin/jsh keep working.
    //
    // Only dsh itself is registered eagerly — that's the one binary the demo
    // spawns on boot. Everything else (node, legacy shell, python3,
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
    this.registerLazyBinary('/bin/tsx', async () =>
      (await import('../binaries/tsx/binary-entry.ts?worldsrc')).default);
    this.registerLazyBinary('/bin/git', async () =>
      (await import('../binaries/git/binary-entry.ts?worldsrc')).default);
    // Lazy: python3, python alias, dpm/dpx/npm/npx/pnpm.
    // These get their source fetched from a code-split chunk on first spawn.
    const loadPython = async (): Promise<string> =>
      (await import('../binaries/python3/binary-entry.ts?worldsrc')).default;
    this.registerLazyBinary('/bin/python3', loadPython);
    this.registerLazyBinary('/bin/python', loadPython);
    const runDpm = async ({ args, cwd, env, stdin }: HostBinaryContext) => {
      const result = await this.withDpmProjectLock(cwd, async () => {
      const transactionId = this.nextDpmTransactionId++;
      const command = this.dpmWasm ?? await loadDpmWasmCommand();
      const capabilities: DpmHostCapabilities = {
        read: (path) => this.fs.readFile(path),
        atomicWrite: async (path, content) => {
          const temporary = `${path}.dpm-tmp-${transactionId}`;
          await this.fs.writeFile(temporary, content);
          await this.fs.rename(temporary, path);
        },
        remove: (path) => this.fs.rm(path),
        exists: (path) => this.fs.exists(path),
        mkdir: (path) => this.fs.mkdir(path, { recursive: true }),
        fetch: (url) => this.dpmFetch ? this.dpmFetch(url) : Promise.reject(new Error('network capability is unavailable')),
        fetchBytes: (url) => this.dpmFetchBytes ? this.dpmFetchBytes(url) : Promise.reject(new Error('binary network capability is unavailable')),
        readBytes: (path) => this.fs.readFileBytes(path),
        readDir: (path) => this.fs.readdir(path),
        stat: async (path) => {
          const lstat = this.fs.lstat ? await this.fs.lstat(path) : undefined;
          if (lstat?.isSymlink) return 'symlink';
          const stat = lstat ?? await this.fs.stat(path);
          return stat.isDirectory ? 'directory' : 'file';
        },
        atomicWriteBytes: async (path, content) => {
          const temporary = `${path}.dpm-tmp-${transactionId}`;
          await this.fs.writeFileBytes(temporary, content);
          await this.fs.rename(temporary, path);
        },
        stdout: async () => {},
        stderr: async () => {},
      };
        return command.execute(args, capabilities, cwd, { env, ...(stdin ? { stdin: Array.from(stdin) } : {}) });
      });
      if (!result.plan) return result;
      const execution = await this.spawnSync(result.plan.command, result.plan.args, {
        cwd,
        env: result.plan.env,
        ...(result.plan.stdin ? { stdin: result.plan.stdin } : {}),
      });
      return execution;
    };
    this.registerHostBinary('/bin/dpm', runDpm);
    this.registerHostBinary('/bin/npm', (context) => runDpm({ ...context, args: ['npm', ...context.args] }));
    this.registerHostBinary('/bin/pnpm', (context) => runDpm({
      ...context,
      args: ['npm', ...(context.args[0] === 'add' ? ['install', ...context.args.slice(1)] : context.args[0] === 'dlx' ? ['exec', ...context.args.slice(1)] : context.args)],
    }));
    this.registerHostBinary('/bin/npx', (context) => runDpm({ ...context, args: ['npm', 'exec', ...context.args] }));
    this.registerHostBinary('/bin/dpx', (context) => runDpm({ ...context, args: ['npm', 'exec', ...context.args] }));
    for (const [name, src] of Object.entries(BUILTIN_BINARIES)) {
      this.registerBinary(name, src);
    }
  }

  private async withDpmProjectLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
    const project = norm(cwd);
    const previous = this.dpmTransactions.get(project) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => next);
    this.dpmTransactions.set(project, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.dpmTransactions.get(project) === tail) this.dpmTransactions.delete(project);
    }
  }

  private closeRelaySocket(socketId: number, closeTransport: boolean, reason?: number): void {
    const record = this.relaySockets.get(socketId);
    if (!record) return;
    this.relaySockets.delete(socketId);
    this.relayServers.get(record.serverId)?.socketIds.delete(socketId);
    this.socketRegistry.removePair(socketId);
    record.offData();
    record.offClose();
    if (closeTransport) record.socket.close(reason);
  }

  private closeExternalTcpSocket(socketId: number, closeTransport: boolean): void {
    const record = this.externalTcpSockets.get(socketId);
    if (!record || record.closed) return;
    record.closed = true;
    this.externalTcpSockets.delete(socketId);
    if (closeTransport) {
      try { record.stream?.close(); } catch { /* best-effort shutdown */ }
    }
  }

  private unregisterRelayServer(serverId: number): void {
    const record = this.relayServers.get(serverId);
    if (!record) return;
    this.relayServers.delete(serverId);
    record.dispose();
    for (const socketId of [...record.socketIds]) this.closeRelaySocket(socketId, true);
  }

  private releaseRelayServers(): void {
    for (const [serverId] of [...this.relayServers]) {
      this.unregisterRelayServer(serverId);
      this.socketRegistry.unregisterServer(serverId);
    }
  }

  private cleanupNetworkForPid(pid: number): void {
    try { this.networkCleanup?.(pid); } catch { /* best-effort shutdown */ }
    for (const [serverId, record] of [...this.relayServers]) {
      if (record.pid === pid) {
        this.unregisterRelayServer(serverId);
        this.socketRegistry.unregisterServer(serverId);
      }
    }
    for (const [socketId, record] of [...this.relaySockets]) {
      if (record.pid === pid) this.closeRelaySocket(socketId, true);
    }
    for (const [socketId, record] of [...this.externalTcpSockets]) {
      if (record.pid === pid) this.closeExternalTcpSocket(socketId, true);
    }
  }

  /**
   * Returns an attach-only view of the current MoonBeam relay. The view is
   * invalidated when the relay changes or this manager closes.
   */
  relayCapability(): DuskRelayCapability {
    const relay = this.relay as (RelayListener & Partial<MoonbeamAttachableRelay>) | undefined;
    const generation = this.relayGeneration;
    return {
      attach: (metadata = {}): MessagePort => {
        if (this.closed || this.relayGeneration !== generation || this.relay !== relay) {
          throw new Error('Dusk relay capability is no longer active');
        }
        if (typeof relay?.attach !== 'function') {
          throw new Error('Dusk relay does not support attach()');
        }
        return relay.attach(metadata);
      },
    };
  }

  /** Replaces the host-owned relay and invalidates previously issued capabilities. */
  setRelay(relay: RelayListener | undefined): void {
    if (this.closed) throw new Error('ProcessManager is closed');
    if (this.relay === relay) return;
    this.releaseRelayServers();
    this.relay = relay;
    this.relayGeneration++;
  }

  /** Invalidates host relay capabilities when the manager is torn down. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.relayGeneration++;
    this.releaseRelayServers();
    for (const socketId of [...this.externalTcpSockets.keys()]) this.closeExternalTcpSocket(socketId, true);
  }

  registerBinary(name: string, jsSource: string): void {
    this.binaries.set(name, jsSource);
    this.lazyLoaders.delete(name);
  }

  registerHostBinary(name: string, binary: HostBinary): void {
    this.hostBinaries.set(name, binary);
  }

  registerStreamingHostBinary(name: string, binary: StreamingHostBinary): void {
    this.streamingHostBinaries.set(name, binary);
  }

  registerAlias(name: string, target: string, args: string[] = []): void {
    this.aliases.set(name, { target, args: [...args] });
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

  private resolveAlias(cmd: string, args: string[]): { cmd: string; args: string[] } {
    const alias = this.aliases.get(cmd);
    return alias ? { cmd: alias.target, args: [...alias.args, ...args] } : { cmd, args };
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

  dispatch(pid: number, js: string): void {
    this.dispatchByPid.get(pid)?.(js);
  }

  activePids(): number[] {
    return [...this.processes.keys()];
  }

  listBinaries(): string[] {
    // Include both eagerly-loaded and lazily-registered names so consumers
    // (which command completion, PATH search) see the full set even before
    // the lazy sources have been fetched.
    const names = new Set<string>([...this.binaries.keys(), ...this.lazyLoaders.keys(), ...this.hostBinaries.keys(), ...this.streamingHostBinaries.keys(), ...this.aliases.keys()]);
    return [...names].sort();
  }

  hasBinary(name: string): boolean {
    return this.binaries.has(name) || this.lazyLoaders.has(name) || this.hostBinaries.has(name) || this.streamingHostBinaries.has(name) || this.aliases.has(name);
  }

  getBinarySource(name: string): string | undefined {
    // Sync accessor — returns undefined for lazy binaries that haven't
    // been forced yet. Callers that need the source should go through
    // spawn/spawnSync (which awaits resolveBinary internally).
    return this.binaries.get(name);
  }

  async loadBinarySource(name: string): Promise<string | undefined> {
    return this.resolveBinary(name);
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
    if (INTERRUPTING_SIGNALS.has(signame)) rec.interruptStdinWait?.(signame);
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
    // SIGCHLD is ignored by default, so do not create a secondary eval for
    // parents that have not subscribed to it.
    const parent = this.processes.get(rec.ppid);
    if (parent?.signalListeners.has('SIGCHLD')) this._deliverSignalToOne(parent, 'SIGCHLD');
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
    const sinkDecoder = new TextDecoder();
    const writeDecoder = new TextDecoder();
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
      // pid 0 only: the world side asks the
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
            write(sinkDecoder.decode(chunk, { stream: true }));
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
        const data = m['data'] as Uint8Array | number[] | undefined;
        if (data) write(writeDecoder.decode(data instanceof Uint8Array ? data : new Uint8Array(data), { stream: true }));
        send({});
      },
    };
    const funcs: FuncTable = { ...baseFuncs, ...this.buildFuncs(0), ...consoleFuncs, ...writeFunc, ...spawnFuncs };
    const engine = await this.engineFactory(0, funcs);
    const terminate = engine.terminate.bind(engine);
    engine.terminate = async (): Promise<number> => {
      this.cleanupNetworkForPid(0);
      this.clearFSWatchSubscriptions(0);
      return terminate();
    };
    dispatchHolder.dispatch = engine.dispatch;
    this.trackEngine(0, engine);

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
      env, cwd: home, title: hostname, startTime: Date.now(), signalListeners: new Set(),
    };
    this.processes.set(0, zeroRec);

    return engine;
  }

  async spawn(cmd: string, args: string[] = [], options: SpawnOptions = {}): Promise<DuskProcessHandle> {
    this.assertCanSpawn();
    this.pendingSpawns++;
    try {
      return await this.spawnProcess(cmd, args, options);
    } finally {
      this.pendingSpawns--;
    }
  }

  private async spawnProcess(cmd: string, args: string[], options: SpawnOptions): Promise<DuskProcessHandle> {
    ({ cmd, args } = this.resolveAlias(cmd, args));
    // Fold JSH-wrapper spawns into a direct dsh -c invocation before we
    // allocate a pid or a worker. See maybeElideJshWrapper for rationale.
    ({ cmd, args } = this.maybeElideJshWrapper(cmd, args));
    const pid = this.nextPid++;
    const stdinBytes = normalizeStdin(options.stdin);
    let outputBytes = 0;
    let onOutputLimit: (() => void) | undefined;
    const observeOutput = (stream: 'stdout' | 'stderr', chunk: Uint8Array): boolean => {
      outputBytes += chunk.byteLength;
      const limit = this.limits.maxOutputBytes;
      if (limit !== undefined && outputBytes > limit) {
        onOutputLimit?.();
        return false;
      }
      this.emitEvent(stream, { pid, chunk });
      return true;
    };

    let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let stdoutClosed = false;
    const stdoutBacklog: Uint8Array[] = [];
    const stdoutHostWrites: { chunk: Uint8Array; resolve: () => void }[] = [];
    const drainStdoutHostWrites = (): void => {
      while (stdoutController && stdoutHostWrites.length > 0 && (stdoutController.desiredSize ?? 0) > 0) {
        const write = stdoutHostWrites.shift()!;
        stdoutController.enqueue(write.chunk);
        write.resolve();
      }
    };
    const flushStdoutHostWrites = (): void => {
      while (stdoutController && stdoutHostWrites.length > 0) {
        const write = stdoutHostWrites.shift()!;
        try { stdoutController.enqueue(write.chunk); } catch { /* closed */ }
        write.resolve();
      }
    };
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        stdoutController = c;
        for (const chunk of stdoutBacklog) c.enqueue(chunk);
        stdoutBacklog.length = 0;
        if (stdoutClosed) { try { c.close(); } catch { /* */ } }
      },
      pull() { drainStdoutHostWrites(); },
    });
    const enqueueStdout = (chunk: Uint8Array): void => {
      if (!observeOutput('stdout', chunk)) return;
      if (stdoutController) { try { stdoutController.enqueue(chunk); } catch { /* closed */ } }
      else stdoutBacklog.push(chunk);
    };
    const closeStdout = (): void => {
      stdoutClosed = true;
      while (stdoutHostWrites.length > 0) stdoutHostWrites.shift()!.resolve();
      if (stdoutController) { try { stdoutController.close(); } catch { /* */ } }
    };
    const writeStdout = (chunk: Uint8Array): Promise<void> => new Promise((resolve) => {
      if (stdoutClosed || !observeOutput('stdout', chunk)) { resolve(); return; }
      stdoutHostWrites.push({ chunk, resolve });
      drainStdoutHostWrites();
    });

    let stderrController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let stderrClosed = false;
    const stderrBacklog: Uint8Array[] = [];
    const stderrHostWrites: { chunk: Uint8Array; resolve: () => void }[] = [];
    const drainStderrHostWrites = (): void => {
      while (stderrController && stderrHostWrites.length > 0 && (stderrController.desiredSize ?? 0) > 0) {
        const write = stderrHostWrites.shift()!;
        stderrController.enqueue(write.chunk);
        write.resolve();
      }
    };
    const flushStderrHostWrites = (): void => {
      while (stderrController && stderrHostWrites.length > 0) {
        const write = stderrHostWrites.shift()!;
        try { stderrController.enqueue(write.chunk); } catch { /* closed */ }
        write.resolve();
      }
    };
    const stderr = new ReadableStream<Uint8Array>({
      start(c) {
        stderrController = c;
        for (const chunk of stderrBacklog) c.enqueue(chunk);
        stderrBacklog.length = 0;
        if (stderrClosed) { try { c.close(); } catch { /* */ } }
      },
      pull() { drainStderrHostWrites(); },
    });
    const enqueueStderr = (chunk: Uint8Array): void => {
      if (!observeOutput('stderr', chunk)) return;
      if (stderrController) { try { stderrController.enqueue(chunk); } catch { /* closed */ } }
      else stderrBacklog.push(chunk);
    };
    const closeStderr = (): void => {
      stderrClosed = true;
      while (stderrHostWrites.length > 0) stderrHostWrites.shift()!.resolve();
      if (stderrController) { try { stderrController.close(); } catch { /* */ } }
    };
    const writeStderr = (chunk: Uint8Array): Promise<void> => new Promise((resolve) => {
      if (stderrClosed || !observeOutput('stderr', chunk)) { resolve(); return; }
      stderrHostWrites.push({ chunk, resolve });
      drainStderrHostWrites();
    });

    const streamingHostBinary = this.streamingHostBinaries.get(cmd);
    if (streamingHostBinary) {
      let stdinController!: ReadableStreamDefaultController<Uint8Array>;
      let stdinClosed = false;
      const stdinWrites: { chunk: Uint8Array; resolve: () => void }[] = [];
      const drainStdinWrites = (): void => {
        while (stdinWrites.length > 0 && (stdinController.desiredSize ?? 0) > 0) {
          const write = stdinWrites.shift()!;
          stdinController.enqueue(write.chunk);
          write.resolve();
        }
      };
      const stdin = new ReadableStream<Uint8Array>({
        start(controller) { stdinController = controller; },
        pull() { drainStdinWrites(); },
      });
      const closeStdin = (): void => {
        if (stdinClosed) return;
        stdinClosed = true;
        while (stdinWrites.length > 0) stdinWrites.shift()!.resolve();
        try { stdinController.close(); } catch { /* already closed */ }
      };
      if (stdinBytes) stdinWrites.push({ chunk: stdinBytes, resolve: () => {} });
      drainStdinWrites();

      let process: StreamingHostProcess | undefined;
      let settled = false;
      let resolveExit!: (status: number) => void;
      const exit = new Promise<number>((resolve) => { resolveExit = resolve; });
      const pendingHostWrites = new Set<Promise<void>>();
      const trackHostWrite = (write: Promise<void>): Promise<void> => {
        pendingHostWrites.add(write);
        void write.finally(() => pendingHostWrites.delete(write));
        return write;
      };
      const finish = (status: number, discardOutput = false): void => {
        if (settled) return;
        settled = true;
        closeStdin();
        if (discardOutput) {
          closeStdout();
          closeStderr();
        } else {
          flushStdoutHostWrites();
          flushStderrHostWrites();
        }
        void (async () => {
          while (pendingHostWrites.size > 0) await Promise.all([...pendingHostWrites]);
          closeStdout();
          closeStderr();
          this.cleanupNetworkForPid(pid);
          this.clearFSWatchSubscriptions(pid);
          const record = this.processes.get(pid);
          if (record) this._emitChildExit(record, status);
          this.processes.delete(pid);
          this.emitEvent('exit', { pid, code: status, ...(record?.exitSignal ? { signal: record.exitSignal } : {}) });
          resolveExit(status);
        })();
      };
      const handle: DuskProcessHandle = {
        pid,
        exit,
        stdin: {
          write: async (chunk) => {
            if (stdinClosed) return;
            await new Promise<void>((resolve) => {
              stdinWrites.push({ chunk, resolve });
              drainStdinWrites();
            });
          },
          close: async () => { closeStdin(); },
        },
        stdout,
        stderr,
        kill: () => {
          if (settled) return;
          try { process?.kill(); } catch { /* best-effort termination */ }
          finish(137, true);
        },
      };
      const env = new Map<string, string>(Object.entries(options.env ?? {}));
      const explicitParent = (options as InternalSpawnOptions)._parentPid;
      const parentPid = explicitParent !== undefined ? explicitParent : (this.processes.get(0)?.pid ?? 0);
      this.processes.set(pid, {
        pid, ppid: parentPid, pgid: (options as InternalSpawnOptions)._processGroup ?? pid, sid: pid, handle,
        stdinBuffer: [], stdinClosed: false,
        argv: [cmd, ...args], argv0: cmd, execPath: cmd,
        env, cwd: options.cwd ?? '/', title: cmd, startTime: Date.now(), signalListeners: new Set(),
      });
      onOutputLimit = () => {
        const record = this.processes.get(pid);
        if (record) record.exitSignal = 'SIGXFSZ';
        handle.kill();
      };
      this.watchProcess(pid, cmd, args, options, handle);
      void Promise.resolve().then(() => streamingHostBinary({
        args,
        cwd: options.cwd ?? '/',
        env: options.env ?? {},
        stdin,
        stdout: (chunk) => trackHostWrite(writeStdout(chunk)),
        stderr: (chunk) => trackHostWrite(writeStderr(chunk)),
      })).then((hostProcess) => {
        if (settled) {
          try { hostProcess.kill(); } catch { /* best-effort termination */ }
          return;
        }
        process = hostProcess;
        void hostProcess.exit.then(finish, () => finish(1));
      }, () => finish(1));
      return handle;
    }

    // Stdin closure state — set up BEFORE PTY attach so PTY hooks can push
    // straight into this buffer (the same one `proc.readStdin` polls).
    const stdinBuffer: Uint8Array[] = [];
    let stdinClosed = false;
    if (stdinBytes) stdinBuffer.push(stdinBytes);
    const stdinWaiters: Array<(signal?: string) => void> = [];
    const wakeStdinReaders = (signal?: string): void => {
      for (const wake of stdinWaiters.splice(0)) wake(signal);
    };
    const pushStdin = (chunk: Uint8Array): void => {
      stdinBuffer.push(chunk);
      wakeStdinReaders();
    };
    const closeStdinBuffer = (): void => {
      stdinClosed = true;
      wakeStdinReaders();
    };

    let masterPty: Pty | undefined;
    if (options.pty) {
      const ptyOpts = typeof options.pty === 'object' ? options.pty : {};
      masterPty = this.ptyManager.attach(pid, ptyOpts, {
        // In cooked-mode PTY, `onSlaveStdin` fires with a full LINE (after
        // the user hits Enter). Push into the SAME closure buffer that
        // `proc.readStdin` reads from.
        onSlaveStdin: (chunk) => {
          if (stdinClosed) return;
          pushStdin(chunk);
        },
        onSignal: (sig) => { this._deliverSignal(-(this.processes.get(pid)?.pgid ?? pid), sig); },
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
            if (masterPty) masterPty.masterWrite(new Uint8Array([4]));
            closeStdinBuffer();
          },
        }
      : {
          write: async (chunk) => { if (!stdinClosed) pushStdin(chunk); },
          close: async () => { closeStdinBuffer(); },
        };

    const ioFuncs: FuncTable = {
      'console.log': (msg, send) => {
        const text = ((msg['args'] as unknown[]) ?? []).map(String).join(' ') + '\n';
        const bytes = textEncoder.encode(text);
        if (masterPty) masterPty.slaveWrite(bytes);
        enqueueStdout(bytes);
        send({});
      },
      'console.error': (msg, send) => {
        const text = ((msg['args'] as unknown[]) ?? []).map(String).join(' ') + '\n';
        const bytes = textEncoder.encode(text);
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
      'proc.readStdin': (m, send) => {
        const reply = (signal?: string): void => {
          if (signal) { send({ value: [], signal }); return; }
          const chunk = stdinBuffer.shift();
          if (chunk) send({ value: chunk });
          else if (stdinClosed) send({ value: null });
          else send({ value: [] });
        };
        if (m['wait'] === true && stdinBuffer.length === 0 && !stdinClosed) stdinWaiters.push(reply);
        else reply();
      },
    };

    const dispatchHolder: DispatchHolder = { dispatch: null };

    const funcs: FuncTable = {
      ...this.buildFuncs(pid),
      ...this.netFuncs,
      ...ioFuncs,
      ...this.buildSpawnFuncs(dispatchHolder, pid),
    };

    const engine = await this.engineFactory(pid, funcs);
    dispatchHolder.dispatch = engine.dispatch;
    this.trackEngine(pid, engine);
    const entryJs = await this.buildEntry(cmd, args, options.env ?? {}, options.cwd ?? '/');

    const exitPromise = (async (): Promise<number> => {
      void engine.run(entryJs);
      const code = await engine.exited;
      this.cleanupNetworkForPid(pid);
      this.clearFSWatchSubscriptions(pid);
      this.untrackEngine(pid);
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
      this.emitEvent('exit', { pid, code, ...(rec?.exitSignal ? { signal: rec.exitSignal } : {}) });
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
    const explicitParent = (options as InternalSpawnOptions)._parentPid;
    const parentPid = explicitParent !== undefined ? explicitParent : (this.processes.get(0)?.pid ?? 0);
    const record: ProcessRecord = {
      pid, ppid: parentPid, pgid: (options as InternalSpawnOptions)._processGroup ?? pid, sid: pid, engine, handle, stdinBuffer, stdinClosed: false,
      argv: [cmd, ...args],
      argv0: cmd,
      execPath: cmd,
      env,
      cwd: options.cwd ?? '/',
      title: cmd,
      startTime: Date.now(),
      signalListeners: new Set(),
      interruptStdinWait: (signal) => wakeStdinReaders(signal),
    };
    this.processes.set(pid, record);
    onOutputLimit = () => {
      record.exitSignal = 'SIGXFSZ';
      handle.kill();
    };
    this.watchProcess(pid, cmd, args, options, handle);

    return handle;
  }

  async spawnSync(cmd: string, args: string[] = [], options: SpawnOptions = {}): Promise<SpawnSyncResult> {
    this.assertCanSpawn();
    this.pendingSpawns++;
    try {
      return await this.spawnSyncProcess(cmd, args, options);
    } finally {
      this.pendingSpawns--;
    }
  }

  private async spawnSyncProcess(cmd: string, args: string[], options: SpawnOptions): Promise<SpawnSyncResult> {
    ({ cmd, args } = this.resolveAlias(cmd, args));
    ({ cmd, args } = this.maybeElideJshWrapper(cmd, args));
    const hostBinary = this.hostBinaries.get(cmd);
    if (hostBinary) {
      const context: HostBinaryContext = {
        args,
        cwd: options.cwd ?? '/',
        env: options.env ?? {},
      };
      const stdin = normalizeStdin(options.stdin);
      if (stdin) context.stdin = stdin;
      const result = await hostBinary(context);
      const toBytes = (data: string | Uint8Array | undefined): Uint8Array =>
        data instanceof Uint8Array ? data : textEncoder.encode(data ?? '');
      return {
        status: result.status ?? 0,
        stdout: toBytes(result.stdout),
        stderr: toBytes(result.stderr),
      };
    }
    const pid = this.nextPid++;
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    const stdinBuffer: Uint8Array[] = [];
    const stdinClosed = true;
    const stdinBytes = normalizeStdin(options.stdin);
    if (stdinBytes) stdinBuffer.push(stdinBytes);
    let outputBytes = 0;
    let onOutputLimit: (() => void) | undefined;
    const pushOutput = (stream: 'stdout' | 'stderr', bytes: Uint8Array): void => {
      outputBytes += bytes.byteLength;
      const limit = this.limits.maxOutputBytes;
      if (limit !== undefined && outputBytes > limit) {
        onOutputLimit?.();
        return;
      }
      (stream === 'stderr' ? stderrChunks : stdoutChunks).push(bytes);
      this.emitEvent(stream, { pid, chunk: bytes });
    };

    const ioFuncs: FuncTable = {
      'console.log': (msg, send) => {
        const text = ((msg['args'] as unknown[]) ?? []).map(String).join(' ') + '\n';
        pushOutput('stdout', textEncoder.encode(text));
        send({});
      },
      'console.error': (msg, send) => {
        const text = ((msg['args'] as unknown[]) ?? []).map(String).join(' ') + '\n';
        pushOutput('stderr', textEncoder.encode(text));
        send({});
      },
      'proc.write': (m, send) => {
        const data = m['data'] as number[] | undefined;
        const fd = (m['fd'] as number | undefined) ?? 1;
        if (data) pushOutput(fd === 2 ? 'stderr' : 'stdout', new Uint8Array(data));
        send({});
      },
      'proc.readStdin': (_m, send) => {
        const chunk = stdinBuffer.shift();
        if (chunk) send({ value: chunk });
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

    const engine = await this.engineFactory(pid, funcs);
    dispatchHolder.dispatch = engine.dispatch;
    this.trackEngine(pid, engine);
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
    const requestedParentPid = (options as InternalSpawnOptions)._parentPid;
    const parentPid = requestedParentPid !== undefined && this.processes.get(requestedParentPid)?.signalListeners.has('SIGCHLD')
      ? requestedParentPid
      : 0;
    const syncRec: ProcessRecord = {
      pid, ppid: parentPid, pgid: (options as InternalSpawnOptions)._processGroup ?? pid, sid: pid, engine, handle: syncHandle, stdinBuffer: [], stdinClosed: true,
      argv: [cmd, ...args], argv0: cmd, execPath: cmd,
      env, cwd: options.cwd ?? '/', title: cmd, startTime: Date.now(), signalListeners: new Set(),
    };
    this.processes.set(pid, syncRec);
    onOutputLimit = () => {
      syncRec.exitSignal = 'SIGXFSZ';
      syncHandle.kill();
    };
    this.watchProcess(pid, cmd, args, options, syncHandle);

    void engine.run(entryJs);
    const status = await engine.exited;
    this.cleanupNetworkForPid(pid);
    this.clearFSWatchSubscriptions(pid);
    const emitChildExit = (): void => this._emitChildExit(syncRec, status);
    const onChildExit = (options as InternalSpawnOptions)._onChildExit;
    if (onChildExit) onChildExit(emitChildExit);
    else emitChildExit();
    const tbl = this.fdTables.get(pid);
    if (tbl) {
      tbl.closeAll((entry) => { void this.fs.closeHandle(entry.backendHandle, { pid }).catch(() => {}); });
      this.fdTables.delete(pid);
    }
    this.processes.delete(pid);
    this.untrackEngine(pid);
    this.emitEvent('exit', { pid, code: status, ...(syncRec.exitSignal ? { signal: syncRec.exitSignal } : {}) });

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
            dispatch(
              `if (globalThis.__process && globalThis.__process.dispatch) globalThis.__process.dispatch(${child.pid}, ${JSON.stringify(kind)}, ${this.bytesExpr(callerPid ?? 0, chunk)});`,
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
            const opts = (m['options'] as InternalSpawnOptions) ?? {};
            if (callerPid !== undefined) {
              opts._parentPid = callerPid;
              const group = this.processes.get(callerPid)?.pgid;
              if (group !== undefined) opts._processGroup = group;
            }
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
            const opts = ((m['options'] as SpawnOptions) ?? {}) as InternalSpawnOptions;
            const group = callerPid !== undefined ? this.processes.get(callerPid)?.pgid : undefined;
            if (group !== undefined) opts._processGroup = group;
            const notifyParent = callerPid !== undefined && this.processes.get(callerPid)?.signalListeners.has('SIGCHLD');
            if (notifyParent) opts._parentPid = callerPid;
            let emitChildExit: (() => void) | undefined;
            if (notifyParent) opts._onChildExit = (emit) => { emitChildExit = emit; };
            const r = await this.spawnSync(
              m['command'] as string,
              (m['args'] as string[]) ?? [],
              opts,
            );
            send({ value: { stdout: r.stdout, stderr: r.stderr, status: r.status } });
            // Let the SAB caller consume its result before a child-exit
            // dispatch can start a secondary evaluation in that same engine.
            if (emitChildExit) setTimeout(emitChildExit, 0);
          } catch (e) { send({ error: formatErr(e) }); }
        })();
      },
      'process.stdinWrite': (m, send) => {
        const child = this.processes.get(m['pid'] as number);
        if (!child || (callerPid !== undefined && child.ppid !== callerPid)) {
          send({ error: 'ESRCH: no such child process' });
          return;
        }
        const data = m['data'];
        if (!(data instanceof Uint8Array) && !Array.isArray(data)) {
          send({ error: 'EINVAL: stdin data must be a byte array' });
          return;
        }
        void child.handle.stdin.write(data instanceof Uint8Array ? data : Uint8Array.from(data as number[])).then(() => send({ value: true }), (error) => send({ error: formatErr(error) }));
      },
      'process.stdinClose': (m, send) => {
        const child = this.processes.get(m['pid'] as number);
        if (!child || (callerPid !== undefined && child.ppid !== callerPid)) {
          send({ error: 'ESRCH: no such child process' });
          return;
        }
        void child.handle.stdin.close().then(() => send({ value: true }), (error) => send({ error: formatErr(error) }));
      },
    };
  }

  private buildFuncs(forPid?: number): FuncTable {
    const fs = this.fs;
    const ok = (send: SendFn, value: unknown): void => send({ value });
    const err = (send: SendFn, e: unknown): void => send({ error: formatErr(e) });
    // Process-bound IPC handlers must not let guest message data replace their owner.
    const callerPid = (m: Record<string, unknown>): number => forPid ?? (m['pid'] as number | undefined) ?? 0;

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
      'process.signal.listen': (m, send) => {
        const signal = m['signal'] as string;
        if (signal === 'SIGCHLD') recOf(m)?.signalListeners.add(signal);
        ok(send, true);
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

    const cryptoFuncs = createCryptoFuncs();

    const fsFuncs: FuncTable = {
      'fs.watch.subscribe': (_m, send) => {
        const pid = forPid ?? 0;
        const id = this.nextFSWatchSubscription++;
        let subscriptions = this.fsWatchSubscriptions.get(pid);
        if (!subscriptions) {
          subscriptions = new Map();
          this.fsWatchSubscriptions.set(pid, subscriptions);
        }
        const unsubscribe = fs.subscribe((event: FSMutation) => {
          this.queueFSWatchMutation(pid, id, event);
        });
        subscriptions.set(id, unsubscribe);
        ok(send, id);
      },
      'fs.watch.unsubscribe': (m, send) => {
        const pid = forPid ?? 0;
        const id = m['id'] as number;
        const subscriptions = this.fsWatchSubscriptions.get(pid);
        subscriptions?.get(id)?.();
        subscriptions?.delete(id);
        this.pendingFSWatchMutations.get(pid)?.delete(id);
        if (subscriptions?.size === 0) this.fsWatchSubscriptions.delete(pid);
        ok(send, true);
      },
      ...createFsFuncs({
        fs,
        pid: forPid ?? 0,
        fdTable: (pid) => this.getOrCreateFDTable(pid),
        nativePackageRegistry: this.nativePackageRegistry,
      }),
    };

    const reg = this.socketRegistry;
    const dispatchByPid = this.dispatchByPid;
    const dispatchTo = (pid: number, js: string): void => {
      const d = dispatchByPid.get(pid);
      if (d) d(js);
    };

    const netFuncs: FuncTable = {
      'net.tls.capability': (_m, send) => {
        send({ value: !!this.relay && !!this.relayTls });
      },
      'net.tls.listen': (m, send) => {
        const host = (m['host'] as string | undefined) ?? '0.0.0.0';
        const port = (m['port'] as number) | 0;
        const callerPid = (m['pid'] as number | undefined) ?? forPid ?? 0;
        if (!this.relay || !this.relayTls) {
          send({ error: 'Nova TLS server capability is not supported by the active relay host' });
          return;
        }
        let serverId = -1;
        try {
          const registered = reg.registerServer(host, port, callerPid, (clientSocketId) => {
            dispatchTo(callerPid, `if (globalThis.__net) globalThis.__net.dispatch('connection', ${serverId}, { clientSocketId: ${clientSocketId} });`);
          });
          serverId = registered.id;
          const boundHost = registered.host;
          const boundPort = registered.port;
          const relayRecord: RelayServerRecord = { pid: callerPid, dispose: () => {}, socketIds: new Set() };
          relayRecord.dispose = createRelayTlsServer(this.relay, {
            host: boundHost,
            port: boundPort,
            pid: callerPid,
            certificateChain: typeof m['cert'] === 'string' ? m['cert'] : Uint8Array.from(m['cert'] as number[]),
            privateKey: typeof m['key'] === 'string' ? m['key'] : Uint8Array.from(m['key'] as number[]),
            Connection: this.relayTls.Connection,
            authorize: this.relayTls.authorize,
            onTlsClientError: (error) => {
              dispatchTo(callerPid, `if (globalThis.__net) globalThis.__net.dispatch('tlsClientError', ${serverId}, ${JSON.stringify(error.message)});`);
            },
            onSecureConnection: (plaintext) => {
              const socketId = reg.allocateSocketId();
              const record: RelaySocketRecord = {
                socket: plaintext as unknown as RelaySocket,
                serverId,
                pid: callerPid,
                offData: () => {},
                offClose: () => {},
              };
              record.offData = plaintext.onData((data) => {
                dispatchTo(callerPid, `if (globalThis.__net) globalThis.__net.dispatch('data', ${socketId}, ${this.bytesExpr(callerPid, data)});`);
              });
              record.offClose = plaintext.onClose(() => {
                dispatchTo(callerPid, `if (globalThis.__net) globalThis.__net.dispatch('end', ${socketId});`);
                this.closeRelaySocket(socketId, false);
              });
              this.relaySockets.set(socketId, record);
              relayRecord.socketIds.add(socketId);
              reg.setPair(socketId, {
                pushToClient: (data) => plaintext.write(data),
                closeClient: () => this.closeRelaySocket(socketId, true),
                errorClient: () => this.closeRelaySocket(socketId, true, 1),
              });
              const server = reg.findServer(boundHost, boundPort);
              if (server) server.onConnection(socketId);
              else plaintext.close();
            },
          }).close;
          this.relayServers.set(serverId, relayRecord);
          send({ value: { serverId, address: boundHost, port: boundPort } });
        } catch (error) {
          if (serverId !== -1) reg.unregisterServer(serverId);
          send({ error: error instanceof Error ? error.message : String(error) });
        }
      },
      'net.tls.unlisten': (m, send) => {
        const serverId = m['serverId'] as number;
        this.unregisterRelayServer(serverId);
        reg.unregisterServer(serverId);
        send({ value: true });
      },
      'net.listen': (m, send) => {
        const host = (m['host'] as string | undefined) ?? '0.0.0.0';
        const port = (m['port'] as number) | 0;
        const callerPid = (m['pid'] as number | undefined) ?? forPid ?? 0;
        let serverId = -1;
        try {
          const registered = reg.registerServer(host, port, callerPid, (clientSocketId) => {
            dispatchTo(callerPid, `if (globalThis.__net) globalThis.__net.dispatch('connection', ${serverId}, { clientSocketId: ${clientSocketId} });`);
          });
          serverId = registered.id;
          const boundHost = registered.host;
          const boundPort = registered.port;
          const relayEligible = this.relay
            && boundHost !== '0.0.0.0'
            && boundHost !== '127.0.0.1'
            && boundHost !== 'localhost'
            && boundHost !== '::1';
          if (relayEligible) {
            if (!this.relay!.authorizeListen?.({ hostname: boundHost, port: boundPort, pid: callerPid, tls: false })) {
              throw new Error('relay listen authorization denied');
            }
            const relayRecord: RelayServerRecord = { pid: callerPid, dispose: () => {}, socketIds: new Set() };
            relayRecord.dispose = this.relay!.registerListener(boundHost, boundPort, (socket) => {
              const server = reg.findServer(boundHost, boundPort);
              if (!server) {
                socket.close();
                return;
              }
              const socketId = reg.allocateSocketId();
              const record: RelaySocketRecord = {
                socket,
                serverId,
                pid: callerPid,
                offData: () => {},
                offClose: () => {},
              };
              record.offData = socket.onData((data) => {
                dispatchTo(callerPid, `if (globalThis.__net) globalThis.__net.dispatch('data', ${socketId}, ${this.bytesExpr(callerPid, data)});`);
              });
              record.offClose = socket.onClose((_reason) => {
                // The relay contract has no separate error callback. Any remote
                // close reason therefore maps to one orderly node:net end event.
                dispatchTo(callerPid, `if (globalThis.__net) globalThis.__net.dispatch('end', ${socketId});`);
                this.closeRelaySocket(socketId, false);
              });
              this.relaySockets.set(socketId, record);
              relayRecord.socketIds.add(socketId);
              reg.setPair(socketId, {
                pushToClient: (data) => socket.send(data),
                closeClient: () => this.closeRelaySocket(socketId, true),
                errorClient: () => this.closeRelaySocket(socketId, true, 1),
              });
              server.onConnection(socketId);
            });
            this.relayServers.set(serverId, relayRecord);
          }
          send({ value: { serverId, address: boundHost, port: boundPort } });
        } catch (e) {
          if (serverId !== -1) reg.unregisterServer(serverId);
          send({ error: e instanceof Error ? e.message : String(e) });
        }
      },
      'net.unlisten': (m, send) => {
        const serverId = m['serverId'] as number;
        this.unregisterRelayServer(serverId);
        reg.unregisterServer(serverId);
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
          const pid = callerPid(m);
          try {
            assertAllowed(this.networkPolicy, { protocol: 'tcp:', host: host.toLowerCase(), port });
          } catch (error) {
            send({ error: formatErr(error) });
            return;
          }
          if (this.tcpProvider) {
            const socketId = reg.allocateSocketId();
            const record: ExternalTcpSocketRecord = {
              pid,
              closed: false,
              connected: false,
              pendingWrites: [],
              shutdownRequested: false,
              pendingEvents: [],
            };
            this.externalTcpSockets.set(socketId, record);
            // node:net records the returned id first, then awaits this connect event.
            send({ value: { socketId } });
            void this.tcpProvider.open(host, port).then((stream) => {
              if (record.closed || this.externalTcpSockets.get(socketId) !== record) {
                try { stream.close(); } catch { /* best-effort shutdown */ }
                return;
              }
              record.stream = stream;
              const dispatchEvent = (kind: 'data' | 'end' | 'error', payload?: unknown): void => {
                if (record.closed) return;
                if (!record.connected) {
                  record.pendingEvents.push({ kind, payload });
                  return;
                }
                if (kind === 'data') {
                  dispatchTo(pid, `if (globalThis.__net) globalThis.__net.dispatch('data', ${socketId}, ${this.bytesExpr(pid, payload as Uint8Array)});`);
                  return;
                }
                if (kind === 'end') {
                  dispatchTo(pid, `if (globalThis.__net) globalThis.__net.dispatch('end', ${socketId});`);
                } else {
                  dispatchTo(pid, `if (globalThis.__net) globalThis.__net.dispatch('error', ${socketId}, ${JSON.stringify(payload)});`);
                }
                this.closeExternalTcpSocket(socketId, false);
              };
              stream.onData((data) => {
                dispatchEvent('data', data);
              });
              stream.onEnd(() => {
                dispatchEvent('end');
              });
              stream.onError((error) => {
                dispatchEvent('error', formatErr(error));
              });
              if (record.closed || this.externalTcpSockets.get(socketId) !== record) return;
              dispatchTo(pid, `if (globalThis.__net) globalThis.__net.dispatch('connect', ${socketId}, ${JSON.stringify({ remoteAddress: host, remotePort: port })});`);
              if (record.closed || this.externalTcpSockets.get(socketId) !== record) return;
              for (const data of record.pendingWrites) stream.write(data);
              record.pendingWrites = [];
              if (record.shutdownRequested) stream.end();
              record.connected = true;
              const pendingEvents = record.pendingEvents;
              record.pendingEvents = [];
              for (const event of pendingEvents) dispatchEvent(event.kind, event.payload);
            }).catch((error) => {
              if (!record.closed) dispatchTo(pid, `if (globalThis.__net) globalThis.__net.dispatch('error', ${socketId}, ${JSON.stringify(formatErr(error))});`);
              this.closeExternalTcpSocket(socketId, false);
            });
            return;
          }
          const openExternal = this.netFuncs['net.tcp.open'];
          if (openExternal) {
            openExternal({ ...m, host, port, pid }, send);
            return;
          }
          send({ error: 'ECONNREFUSED: connect ' + host + ':' + port });
          return;
        }
        const pid = callerPid(m);
        const clientSocketId = reg.allocateSocketId();
        const serverSocketId = reg.allocateSocketId();

        // Pair: client→server data, server→client data
        const clientToServer: SocketPair = {
          pushToClient: (chunk) => {
            // server pushing back to the client
            dispatchTo(pid, `if (globalThis.__net) globalThis.__net.dispatch('data', ${clientSocketId}, ${this.bytesExpr(pid, chunk)});`);
          },
          closeClient: () => {
            dispatchTo(pid, `if (globalThis.__net) globalThis.__net.dispatch('end', ${clientSocketId});`);
          },
          errorClient: (msg) => {
            dispatchTo(pid, `if (globalThis.__net) globalThis.__net.dispatch('error', ${clientSocketId}, ${JSON.stringify(msg)});`);
          },
        };
        const serverToClient: SocketPair = {
          pushToClient: (chunk) => {
            dispatchTo(srv.enginePid, `if (globalThis.__net) globalThis.__net.dispatch('data', ${serverSocketId}, ${this.bytesExpr(srv.enginePid, chunk)});`);
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
        const external = this.externalTcpSockets.get(socketId);
        if (external) {
          if (external.pid !== callerPid(m)) { send({ error: 'resource belongs to another process' }); return; }
          if (!external.closed) {
            if (external.stream) external.stream.write(data);
            else external.pendingWrites.push(data);
          }
          send({ value: true });
          return;
        }
        const pair = reg.getPair(socketId);
        if (pair) pair.pushToClient(data);
        send({ value: true });
      },
      'net.shutdown': (m, send) => {
        const socketId = m['socketId'] as number;
        const external = this.externalTcpSockets.get(socketId);
        if (external) {
          if (external.pid !== callerPid(m)) { send({ error: 'resource belongs to another process' }); return; }
          if (!external.closed && !external.shutdownRequested) {
            external.shutdownRequested = true;
            external.stream?.end();
          }
          send({ value: true });
          return;
        }
        const pair = reg.getPair(socketId);
        if (pair) pair.closeClient();
        send({ value: true });
      },
      'net.close': (m, send) => {
        const socketId = m['socketId'] as number;
        const external = this.externalTcpSockets.get(socketId);
        if (external) {
          if (external.pid !== callerPid(m)) { send({ error: 'resource belongs to another process' }); return; }
          this.closeExternalTcpSocket(socketId, true);
          send({ value: true });
          return;
        }
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
            const workerEngine = await this.engineFactory(workerPid, workerFuncs);
            workerHolder.dispatch = workerEngine.dispatch;
            this.trackEngine(workerPid, workerEngine);

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
              env, cwd: '/', title: 'worker', startTime: Date.now(), signalListeners: new Set(),
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
              this.cleanupNetworkForPid(workerPid);
              this.clearFSWatchSubscriptions(workerPid);
              this.processes.delete(workerPid);
              this.untrackEngine(workerPid);
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
          void rec.engine?.terminate();
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
            d(`if (globalThis.__streams) globalThis.__streams.dispatch(${id}, 'chunk', ${this.bytesExpr(consumerPid, chunk)});`);
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
    };

    return { ...processFuncs, ...cryptoFuncs, ...netFuncs, ...fsFuncs, ...this.dnsFuncs };
  }

  private async buildEntry(cmd: string, args: string[], env: Record<string, string>, cwd: string): Promise<string> {
    const dpmCli = /^\/bin\/(?:dpm|dpx|npm|npx|pnpm)$/.test(cmd);
    // Bundled DPM CLIs parse Node's executable, script, arguments contract.
    const argv = dpmCli ? ['/bin/node', cmd, ...args] : [cmd, ...args];
    const prelude =
      `process.argv = ${JSON.stringify(argv)};\n` +
      `process.env = ${JSON.stringify(env)};\n` +
      `process.chdir(${JSON.stringify(cwd)});\n` +
      '';

    const builtin = await this.resolveBinary(cmd);
    let body: string;
    if (builtin !== undefined) {
      body = builtin;
    } else {
      body = `(new Function(__fs.readFile(${JSON.stringify(cmd)})))();`;
    }
    if (body.startsWith('#!')) body = body.slice(body.indexOf('\n') + 1);

    // Wrap body in an async IIFE so bundle code that uses fire-and-forget
    // promises (e.g. `main().then(...)`) gets awaited before we check exitCode.
    // We additionally wait one extra microtask cycle to allow chained .then()
    // resolutions a chance to fire.
    //
    // A reserved entry without an explicit main promise is an interactive
    // keep-alive; only a later process.exit can complete it.
    return `${prelude}try { await (async () => { ${body}\n })(); await Promise.resolve(); await Promise.resolve(); const __p = globalThis.__process; if (__p && __p._exitCode === undefined && __p.__duskLifecycle) { await (__p._exitReserved ? (__p.__mainPromise ?? new Promise(function(){})) : __p.__duskLifecycle.whenIdle()); } if (typeof process !== 'undefined' && process.exit && !(__p && __p._exitCode !== undefined)) process.exit(); } catch (e) { try { console.error(String(e)); } catch (_) {} try { process.exit(1); } catch (_) {} }`;
  }
}
