import {
  ProcessManager,
  type DuskProcessHandle,
  type RelayListener,
  type SshOptions,
} from './host/process-manager';
import { createNet, type LibCurl, type NetHost } from './host/net';
import { createWispTcpProvider, createWispTlsTcpProvider, type TcpProvider, type TcpRelayAttachment } from './host/tcp';
import type { RelayListenAuthorizer, TlsServerConnection } from './host/relay-tls-server';
import { createMemoryBackend, createTfsBackend, type FSBackend } from './host/fs-backend';
import { createLayoutBackend } from './host/fs-layout';
import { createMountBackend } from './host/fs-mount';
import { createFileSystemAccessBackend } from './host/fs-access';
import { exportSnapshot, importSnapshot, type SnapshotExportOptions, type SnapshotImportOptions } from './host/snapshot';
import { createPythonFuncs } from './host/python';
import { loadDuskExtensions, type DuskExtensionHost } from './host/extensions';
import { startRepl, type DuskRepl } from './repl/repl';
import { createEngineFactory, type DuskRuntime, type EngineInstance, type FuncTable } from './host/engine-instance';
import type { NativePackageReplacementEntries } from './host/native-package-registry';
import type { DnsResolver } from './host/dns';
import { toNetworkPolicy, type NetworkPolicy } from './host/network-policy';
import type { ProcessLimits } from './host/process-manager';

export { createRunner } from './host/runner';
export { createEngine } from './host/engine-instance';
export { createEngineFactory, createNativeEngine, createSpiderMonkeyLegacyEngine } from './host/engine-instance';
export type { DuskRuntime, EngineFactory } from './host/engine-instance';
export { ProcessManager } from './host/process-manager';
export type { DuskRelayCapability, MoonbeamAttachableRelay, MoonbeamAttachmentMetadata, RelayListener, RelaySocket, SshAdapter, SshAdapterContext, SshHostKeyVerification, SshOptions, SshWasmSource, StreamingHostBinary, StreamingHostBinaryContext, StreamingHostProcess } from './host/process-manager';
export { startRepl } from './repl/repl';
export { createMemoryBackend, createTfsBackend } from './host/fs-backend';
export type { FSBackend } from './host/fs-backend';
export type { FuncTable } from './host/engine-instance';
export { createLayoutBackend } from './host/fs-layout';
export { createMountBackend } from './host/fs-mount';
export type { MountableBackend } from './host/fs-mount';
export { createFileSystemAccessBackend } from './host/fs-access';
export { exportSnapshot, importSnapshot, snapshotFromUrl, snapshotToUrl } from './host/snapshot';
export type { SnapshotExportOptions, SnapshotImportOptions } from './host/snapshot';
export { createRelayTlsServer } from './host/relay-tls-server';
export type { RelayListenAuthorizer, RelayListenRequest, RelayTlsPlaintextSocket, RelayTlsServer, RelayTlsServerOptions, TlsServerConnection } from './host/relay-tls-server';
export { initEnginePool, isPoolWarm } from './host/engine-pool';
export { prewarmEngine } from './engine/spidermonkey';
export { createNativePackageRegistry } from './host/native-package-registry';
export type { NativePackageRegistry, NativePackageReplacementEntries } from './host/native-package-registry';
export { createTcpProvider, createWispTcpProvider, createWispTlsTcpProvider } from './host/tcp';
export { loadDuskExtensions } from './host/extensions';
export type { DuskExtensionHost, DuskExtensionManifest } from './host/extensions';
export type { TcpOpenOptions, TcpProvider, TcpRelayAttachment, TcpStream, WispTlsTcpProviderOptions } from './host/tcp';
export { createDohResolver } from './host/dns';
export { createAllowList } from './host/network-policy';
export { fetchLoopback, startPreview } from './host/preview';
export type { LoopbackRequest, LoopbackResponse, PreviewHandle, PreviewOptions } from './host/preview';
export type { LoopbackConnection } from './host/process-manager';
export { default as previewServiceWorkerSource } from './preview/preview-sw.js?raw';
export type { NetworkPolicy, NetworkTarget } from './host/network-policy';
export type { ProcessLimits, ProcessManagerEventMap } from './host/process-manager';
export type { DnsAnswer, DnsRecordType, DnsResolver } from './host/dns';

export type BootReplNetOptions = BootReplNetTransportOptions & { dns?: DnsResolver; allow?: NetworkPolicy | readonly string[] };

type BootReplNetTransportOptions =
  | { loadLibcurl: () => Promise<LibCurl>; proxyUrl: string; relay?: RelayListener & Partial<TcpRelayAttachment>; relayTls?: RelayTlsHostCapability; tcp?: boolean; tcpProvider?: TcpProvider }
  | { relay: RelayListener; relayTls?: RelayTlsHostCapability; loadLibcurl?: never; proxyUrl?: never; tcp?: boolean; tcpProvider?: TcpProvider }
  | { tcpProvider: TcpProvider; relay?: RelayListener & Partial<TcpRelayAttachment>; relayTls?: RelayTlsHostCapability; loadLibcurl?: never; proxyUrl?: never; tcp?: boolean };

export interface RelayTlsHostCapability {
  Connection: new (certificateChain: string | Uint8Array, privateKey: string | Uint8Array, options?: unknown) => TlsServerConnection;
  authorize: RelayListenAuthorizer;
}

export interface BootReplOptions {
  runtime?: DuskRuntime;
  net?: BootReplNetOptions;
  seed?: Record<string, string>;
  fs?: 'tfs' | 'memory';
  user?: string;
  hostname?: string;
  layout?: boolean;
  /**
   * Routing for `feed(line)`:
   * - 'startRepl' (default): dispatch wrapped JS through the pid-0 engine via startRepl().
   * - 'node': spawn `/bin/node` (no args, no PTY) as a child; feed writes to its stdin
   *   and the child's stdout/stderr are decoded and forwarded to `write`.
   */
  via?: 'startRepl' | 'node';
  /**
   * Skip creating the pid-0 engine entirely. Saves ~100MB of RAM (a full
   * SpiderMonkey Worker) for callers that never use `feed()` and only spawn
   * child processes via `processManager.spawn(...)`. When set:
   *   - `.feed()` becomes a no-op that logs a warning
   *   - `.engine` is a lightweight stub that only implements `.terminate()`
   * Demo pages that spawn `/bin/dsh` interactively should set this.
   * Default: false (creates pid-0 for backwards compat).
   */
  skipPidZero?: boolean;
  /** Exact native-dependent package specifiers replaced by host-owned browser source. */
  nativePackageReplacements?: NativePackageReplacementEntries;
  /** Host-supplied SSH bridge over the active MoonBeam relay. */
  ssh?: SshOptions;
  /** Explicit host extensions activated from packages already installed by DPM. */
  extensions?: readonly DuskExtensionHost[];
  /** Project whose DPM lockfile authorizes the requested extensions. */
  extensionCwd?: string;
  limits?: ProcessLimits;
}

export interface BootReplResult extends DuskRepl {
  processManager: ProcessManager;
  /** Dusk's configured raw/TLS provider, suitable for NodeWorker's Dusk adapter. */
  tcpProvider?: TcpProvider;
  /** pid-0 engine. Present unless `skipPidZero: true`, in which case it's a stub. */
  engine: EngineInstance;
  /** Present when `via: 'node'` — the spawned /bin/node child handle. */
  node?: DuskProcessHandle;
  registerWispTransport(name: string, factory: unknown): void;
  mount(path: string, target: FSBackend | FileSystemDirectoryHandle): void;
  unmount(path: string): boolean;
  exportSnapshot(options?: SnapshotExportOptions): Promise<Uint8Array>;
  importSnapshot(data: Uint8Array, options?: SnapshotImportOptions): Promise<string[]>;
  dispose(): Promise<void>;
}

export const bootRepl = async (
  write: (text: string) => void,
  options?: BootReplOptions,
): Promise<BootReplResult> => {
  const user = options?.user ?? 'user';
  const hostname = options?.hostname ?? 'duskjs';
  const useLayout = options?.layout !== false;
  const runtime = options?.runtime ?? 'native';
  const engineFactory = createEngineFactory(runtime);

  if (runtime === 'spidermonkey-legacy') {
    const { initEnginePool } = await import('./host/engine-pool');
    initEnginePool();
  }

  const persistent: FSBackend = (options?.fs ?? 'tfs') === 'memory'
    ? createMemoryBackend()
    : await createTfsBackend();

  const engineHolder: { engine: EngineInstance | null } = { engine: null };
  let pm!: ProcessManager;
  let netFuncs: FuncTable = {};
  let net: NetHost | undefined;
  let cleanupNetworkForPid: ((pid: number) => void) | undefined;
  const netOptions = options?.net;
  const networkPolicy = toNetworkPolicy(netOptions?.allow);
  const configuredRelay = netOptions?.relay;
  const tcpRelay = configuredRelay && typeof (configuredRelay as Partial<TcpRelayAttachment>).attach === 'function'
    ? configuredRelay as RelayListener & TcpRelayAttachment
    : undefined;
  const tcpProvider = netOptions?.tcpProvider
    ?? (netOptions?.tcp !== false && (netOptions?.proxyUrl || tcpRelay)
      ? netOptions?.loadLibcurl && netOptions.proxyUrl
        ? createWispTlsTcpProvider({ proxyUrl: netOptions.proxyUrl, loadLibcurl: netOptions.loadLibcurl })
        : createWispTcpProvider({
          ...(tcpRelay ? { relay: tcpRelay } : {}),
          ...(netOptions?.proxyUrl ? { proxyUrl: netOptions.proxyUrl } : {}),
        })
      : undefined);
  if (options?.net?.loadLibcurl) {
    net = createNet(
      options.net.loadLibcurl,
      (js, pid) => {
        if (pid === undefined || pid === 0) engineHolder.engine?.dispatch(js);
        else pm.dispatch(pid, js);
      },
      options.net.proxyUrl,
      networkPolicy,
    );
    netFuncs = net.funcs;
    cleanupNetworkForPid = net.cleanupForPid;
  }
  const registerWispTransport = (name: string, factory: unknown): void => {
    if (!net) throw new Error('bootRepl: registerWispTransport requires net.loadLibcurl');
    net.registerWispTransport(name, factory);
  };

  let backend: FSBackend;
  let mountable: ReturnType<typeof createMountBackend>;
  const processManagerOptions = {
    ...(options?.net?.relay ? { relay: options.net.relay } : {}),
    ...(options?.net?.relayTls ? { relayTls: options.net.relayTls } : {}),
    ...(cleanupNetworkForPid ? { cleanupNetworkForPid } : {}),
    ...(tcpProvider ? { tcpProvider } : {}),
    ...(net ? { dpmFetch: net.fetch, dpmFetchBytes: net.fetchBytes } : {}),
    ...(options?.nativePackageReplacements ? { nativePackageReplacements: options.nativePackageReplacements } : {}),
    ...(options?.ssh ? { ssh: options.ssh } : {}),
    ...(options?.net?.dns ? { dns: options.net.dns } : {}),
    ...(networkPolicy ? { networkPolicy } : {}),
    ...(options?.limits ? { limits: options.limits } : {}),
  };
  // Host bridges get the same FSBackend the process manager sees.
  // We build them AFTER pm construction (see below) once `backend` is bound.
  let extraFuncs: FuncTable = {};
  if (useLayout) {
    const ephemeral = createMemoryBackend();
    // Build pm with persistent first (so binaries get registered), then swap to layout
    pm = new ProcessManager(persistent, netFuncs, {}, { ...processManagerOptions, engineFactory });
    mountable = createMountBackend(await createLayoutBackend({
      ephemeral,
      persistent,
      processManager: pm,
      user,
      hostname,
    }));
    backend = mountable;
    (pm as unknown as { fs: FSBackend }).fs = backend;
  } else {
    mountable = createMountBackend(persistent);
    backend = mountable;
    pm = new ProcessManager(backend, netFuncs, {}, { ...processManagerOptions, engineFactory });
  }
  const files = {
    mount: (path: string, target: FSBackend | FileSystemDirectoryHandle): void => {
      mountable.mount(path, 'kind' in target && target.kind === 'directory'
        ? createFileSystemAccessBackend(target as FileSystemDirectoryHandle)
        : target as FSBackend);
    },
    unmount: (path: string): boolean => mountable.unmount(path),
    exportSnapshot: (snapshotOptions?: SnapshotExportOptions): Promise<Uint8Array> => exportSnapshot(backend, snapshotOptions),
    importSnapshot: (data: Uint8Array, snapshotOptions?: SnapshotImportOptions): Promise<string[]> => importSnapshot(backend, data, snapshotOptions),
  };
  for (const [path, contents] of Object.entries(options?.seed ?? {})) {
    const segs = path.split('/').filter(Boolean);
    segs.pop();
    let cur = '';
    for (const s of segs) { cur += '/' + s; if (!(await backend.exists(cur))) await backend.mkdir(cur); }
    await backend.writeFile(path, contents);
  }

  // Register Python and explicitly authorized extension bridges.
  // Merge into the pm's netFuncs bag so all subsequent spawns see them.
  extraFuncs = { ...createPythonFuncs(backend) };
  const extensions = await loadDuskExtensions(backend, options?.extensionCwd ?? `/home/${user}`, options?.extensions ?? []);
  for (const extension of extensions) {
    Object.assign(extraFuncs, extension.funcs);
    for (const [path, source] of Object.entries(extension.binaries)) pm.registerBinary(path, source);
  }
  (pm as unknown as { netFuncs: FuncTable }).netFuncs = {
    ...(pm as unknown as { netFuncs: FuncTable }).netFuncs,
    ...extraFuncs,
  };

  // Optionally skip pid-0 — saves ~100MB of RAM by not spawning an entire
  // SpiderMonkey Worker for the `feed()` path. Only meaningful for callers
  // that will never call `.feed()` and only use `processManager.spawn(...)`.
  let engine: EngineInstance;
  if (options?.skipPidZero) {
    // Lightweight stub: satisfies .engine.terminate() from tests and demo,
    // ignores everything else. Any actual dispatch attempt will throw.
    let terminated = false;
    engine = {
      pid: 0,
      run: async (): Promise<void> => {
        throw new Error('bootRepl: pid-0 engine skipped (skipPidZero:true); use processManager.spawn instead');
      },
      dispatch: async (): Promise<void> => {
        throw new Error('bootRepl: pid-0 engine skipped (skipPidZero:true)');
      },
      terminate: async (): Promise<number> => { terminated = true; return 0; },
      get exited(): Promise<number> {
        return terminated ? Promise.resolve(0) : new Promise<number>(() => {});
      },
    };
  } else {
    engine = await pm.createPidZero(netFuncs, write, { user, hostname });
    engineHolder.engine = engine;
  }

  const dispose = async (): Promise<void> => {
    await pm.dispose();
    if (engine.pid === 0) await engine.terminate().catch(() => 0);
  };

  if (options?.via === 'node') {
    // Spawn /bin/node with no args → enters REPL mode. No PTY: readline goes via
    // proc.readStdin polling in main.ts's startRepl (see binaries/node/main.ts).
    const home = `/home/${user}`;
    const nodeHandle = await pm.spawn('/bin/node', [], {
      env: { USER: user, HOME: home, PATH: '/bin', PWD: home, HOSTNAME: hostname, SHELL: '/bin/sh', TERM: 'dumb' },
      cwd: home,
    });
    // Reader loop: decode child stdout/stderr → write().
    const decoder = new TextDecoder();
    const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const reader = stream.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length) write(decoder.decode(value, { stream: true }));
        }
        const tail = decoder.decode();
        if (tail) write(tail);
      } catch { /* stream closed */ }
    };
    void pump(nodeHandle.stdout);
    void pump(nodeHandle.stderr);

    const encoder = new TextEncoder();
    const feed = async (line: string): Promise<void> => {
      await nodeHandle.stdin.write(encoder.encode(line + '\n'));
    };
    return { feed, processManager: pm, engine, node: nodeHandle, ...(tcpProvider ? { tcpProvider } : {}), registerWispTransport, ...files, dispose };
  }

  if (options?.skipPidZero) {
    // No pid-0 → no startRepl. Provide a feed() that clearly errors so
    // misuse surfaces immediately rather than silently no-oping.
    const feed = async (): Promise<void> => {
      throw new Error('bootRepl: feed() unavailable when skipPidZero:true. Spawn a shell via processManager.spawn(\'/bin/dsh\', ...) and write to its stdin.');
    };
    return { feed, processManager: pm, engine, ...(tcpProvider ? { tcpProvider } : {}), registerWispTransport, ...files, dispose };
  }

  const repl = startRepl(engine, write);
  return { feed: repl.feed, processManager: pm, engine, ...(tcpProvider ? { tcpProvider } : {}), registerWispTransport, ...files, dispose };
};
