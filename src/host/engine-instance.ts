import {
  SERIAL_RES_SIZE,
  type DoneMessage,
  type ExitMessage,
  type FuncMessage,
  type WaitMessage,
  type WorldToHost,
} from '../protocol/messages';
import { resolveSpiderMonkey } from '../engine/spidermonkey';
import { bytesAsArrays, encodeFrame } from '../protocol/frame';
import rollupBrowserWasmUrl from './rollup-browser/bindings_wasm_bg.wasm?url';
import esbuildBrowserUrl from './esbuild-wasm/lib/browser.min.js?url&no-inline';
import esbuildWasmUrl from './esbuild-wasm/esbuild.wasm?url&no-inline';

export type SendFn = (msg: unknown) => void;
export type FuncFn = (msg: Record<string, unknown>, send: SendFn) => void;
export type FuncTable = Record<string, FuncFn>;

export interface EngineInstance {
  pid: number;
  run(js: string): Promise<void>;
  dispatch(js: string): Promise<void>;
  terminate(): Promise<number>;
  readonly exited: Promise<number>;
  stageBytes?(bytes: Uint8Array): string;
}

export type DuskRuntime = 'native' | 'spidermonkey-legacy';
export type EngineFactory = (pid: number, funcs?: FuncTable) => Promise<EngineInstance>;

type WorkerInit = Record<string, unknown>;

let rollupBrowserWasmBytes: Promise<Uint8Array> | undefined;

const loadRollupBrowserWasm = (): Promise<Uint8Array> => {
  rollupBrowserWasmBytes ??= fetch(rollupBrowserWasmUrl).then(async (response) => {
    if (!response.ok) throw new Error(`Failed to load Rollup browser WASM: ${response.status} ${response.statusText}`);
    return new Uint8Array(await response.arrayBuffer());
  });
  return rollupBrowserWasmBytes;
};

const createWorkerEngine = async (pid: number, funcs: FuncTable, worker: Worker, init: WorkerInit, nativeTransport = false, transfer: Transferable[] = []): Promise<EngineInstance> => {
  if (!crossOriginIsolated) throw new Error('DuskJS requires cross-origin isolation (SharedArrayBuffer)');

  const lengthBuffer = new SharedArrayBuffer(4);
  const lengthTyped = new Int32Array(lengthBuffer);
  const valueBuffer = new SharedArrayBuffer(SERIAL_RES_SIZE);
  const valueTyped = new Uint8Array(valueBuffer);
  const encoder = new TextEncoder();

  const queue: string[] = [];
  const dispatchQueue: Array<{ js: string; resolve: () => void }> = [];
  let dispatchResolve: (() => void) | null = null;
  const doneResolvers: Array<() => void> = [];
  let runPending = false;
  let nativeBooted = false;
  let blockingSyncRpc: number | undefined;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let queueResolve: (() => void) | null = null;
  let settled = false;

  const clearTimers = (): void => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };

  const flushNative = (): void => {
    if (!nativeTransport) return;
    if (!runPending && queue.length > 0) {
      runPending = true;
      nativeBooted = true;
      worker.postMessage({ type: 'eval', js: queue.shift()!, primary: true });
    }
    if (blockingSyncRpc !== undefined || !nativeBooted) return;
    while (dispatchQueue.length > 0) {
      const entry = dispatchQueue.shift()!;
      worker.postMessage({ type: 'eval', js: entry.js, primary: false });
      entry.resolve();
    }
  };

  const dispatch = (js: string): Promise<void> => new Promise<void>((resolve) => {
    dispatchQueue.push({ js, resolve });
    if (nativeTransport) flushNative();
    else if (queueResolve) queueResolve();
  });

  funcs['timer.schedule'] = (msg, sendReply) => {
    const id = msg['id'] as number;
    const delay = Math.max(0, Number(msg['delay']) || 0);
    const existing = timers.get(id);
    if (existing) clearTimeout(existing);
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      void dispatch(`globalThis.__duskTimers?.fire(${id});`);
    }, delay));
    sendReply({ value: true });
  };
  funcs['timer.cancel'] = (msg, sendReply) => {
    const timer = timers.get(msg['id'] as number);
    if (timer) clearTimeout(timer);
    timers.delete(msg['id'] as number);
    sendReply({ value: true });
  };

  let exitCode = 0;
  let exitResolve: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => { exitResolve = resolve; });

  // Historically we concatenated the pid prefix onto worldJS here, producing
  // a fresh ~344 KB string on every spawn. That string then went through
  // postMessage (structured-cloned into the worker) — so a single spawn cost
  // TWO copies of the entire world source on the host heap before the source
  // even reached the worker. We now send the pid as a separate field and let
  // the worker do the tiny prefix concat locally against its own already-
  // cloned copy of worldJS. Net saving per spawn: one full copy of worldJS
  // (~344 KB in the current build) on the host heap.

  const send: SendFn = (msg) => {
    let size: number;
    if (nativeTransport) {
      size = encodeFrame(msg, encoder, valueTyped);
    } else {
      const bytes = encoder.encode(JSON.stringify(msg, bytesAsArrays));
      if (bytes.length > SERIAL_RES_SIZE) {
        throw new Error('IPC response exceeds SERIAL_RES_SIZE limit (' + bytes.length + ' > ' + SERIAL_RES_SIZE + ')');
      }
      valueTyped.set(bytes, 0);
      size = bytes.length;
    }
    Atomics.store(lengthTyped, 0, size);
    Atomics.notify(lengthTyped, 0);
  };

  // Fast path for eval messages.
  //
  // The regular send() path does JSON.stringify(msg) → encoder.encode(json)
  // → byte-by-byte SAB writes. For eval envelopes carrying a ~200 KB binary
  // source string, that's three transient copies of the source PLUS the SAB
  // byte fanout, all just to have the worker JSON.parse the envelope and
  // read `.js` back out (see wasi-loader.ts's `reply.startsWith('{"type":"eval'`
  // special-case).
  //
  // Instead we encode the raw JS string once with a 3-byte "JS|" prefix and
  // ship those bytes directly through the SAB. The worker recognizes the
  // prefix and skips the JSON parse entirely. Net savings per eval message:
  //   - No JSON.stringify allocation of the body
  //   - No JSON.parse on the worker side
  //   - encoder.encode runs on the raw JS, not on a JSON-escaped duplicate
  const sendEvalRaw = (js: string): void => {
    // encoder.encodeInto refuses SAB-backed views (spec: "must not be
    // shared") — so we encode into a fresh Uint8Array then copy into
    // the SAB. Still avoids the JSON.stringify hop that the old path did.
    const body = encoder.encode(js);
    const total = 3 + body.length;
    if (total >= SERIAL_RES_SIZE) {
      throw new Error('eval body exceeds SERIAL_RES_SIZE limit (' + total + ' > ' + SERIAL_RES_SIZE + ')');
    }
    valueTyped[0] = 0x4a; // 'J'
    valueTyped[1] = 0x53; // 'S'
    valueTyped[2] = 0x7c; // '|'
    valueTyped.set(body, 3);
    Atomics.store(lengthTyped, 0, total);
    Atomics.notify(lengthTyped, 0);
  };

  const handleWait = async (msg: WaitMessage): Promise<void> => {
    if (!nativeTransport) {
      while (queue.length === 0 && dispatchQueue.length === 0) {
        await new Promise<void>((res) => { queueResolve = res; });
      }
      queueResolve = null;
      const entry = queue.length > 0 ? { js: queue.pop()!, resolve: () => {} } : dispatchQueue.shift()!;
      dispatchResolve = entry.resolve;
      sendEvalRaw(entry.js);
      return;
    }
    const canRun = msg.canRun !== false;
    while ((canRun && !runPending ? queue.length === 0 : true) && dispatchQueue.length === 0) {
      await new Promise<void>((res) => { queueResolve = res; });
    }
    queueResolve = null;
    // Primary run() bodies ALWAYS go first — dispatch envelopes cannot preempt
    // the entry script during engine boot. Otherwise a signal delivered before
    // the body has had a chance to register handlers will run before it and
    // hit the default-terminate branch (see src/world/node-process.ts:426).
    const js = canRun && !runPending && queue.length > 0
      ? (runPending = true, queue.shift()!)
      : (() => {
          const dispatch = dispatchQueue.shift()!;
          dispatchResolve = dispatch.resolve;
          return dispatch.js;
        })();
    sendEvalRaw(js);
  };

  const handleDone = (msg: DoneMessage): void => {
    if (!nativeTransport) {
      dispatchResolve?.();
      dispatchResolve = null;
    }
    if (!nativeTransport || msg.primary === true) {
      runPending = false;
      doneResolvers.shift()?.();
    }
    if (nativeTransport) flushNative();
    send({});
  };

  const finish = (code: number): void => {
    if (settled) return;
    settled = true;
    exitCode = code;
    clearTimers();
    for (const resolve of doneResolvers.splice(0)) resolve();
    worker.terminate();
    exitResolve(exitCode);
  };

  const handleExit = (msg: ExitMessage): void => { finish(msg.exitCode ?? 0); };

  worker.postMessage({ lengthBuffer, valueBuffer, pid, ...init }, transfer);

  const failWorker = (): void => { finish(1); };
  worker.onerror = failWorker;
  worker.onmessageerror = failWorker;

  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data as WorldToHost;
    if (nativeTransport && msg.type === 'sync-rpc-consumed') {
      if (msg.syncRpcSeq === blockingSyncRpc) {
        blockingSyncRpc = undefined;
        flushNative();
      }
      return;
    }
    const sendReply: SendFn = (reply) => {
      send(reply);
      if (nativeTransport && msg.syncRpcSeq !== undefined) {
        blockingSyncRpc = msg.syncRpcSeq;
      }
    };
    if (nativeTransport && msg.syncRpcSeq !== undefined) blockingSyncRpc = msg.syncRpcSeq;
    if (msg.type === 'wait') {
      void handleWait(msg);
      return;
    }
    if (msg.type === 'done') {
      handleDone(msg);
      return;
    }
    if (msg.type === 'exit') {
      handleExit(msg);
      return;
    }
    const func = 'f' in msg ? funcs[msg.f] : undefined;
    // IPC originates in this engine. Network handlers use this private stamp
    // rather than a guest-controlled `pid` field for resource ownership.
    if (func) func({ ...(msg as FuncMessage), __enginePid: pid }, sendReply);
    else sendReply({});
  };

  let nextStagedBytes = 1;
  const stageBytes = (bytes: Uint8Array): string => {
    if (!nativeTransport) return JSON.stringify(Array.from(bytes));
    const id = nextStagedBytes++;
    worker.postMessage({ type: 'bytes', id, data: bytes });
    return `globalThis.__duskTakeBytes(${id})`;
  };

  return {
    pid,
    stageBytes,
      run: (js: string) => new Promise<void>((resolve) => {
        if (settled) {
          resolve();
          return;
        }
        queue.push(js.trim());
        doneResolvers.push(resolve);
       if (nativeTransport) flushNative();
       else if (queueResolve) queueResolve();
    }),
    dispatch,
    terminate: async () => { finish(1); return 1; },
    exited,
  };
};

export const createNativeEngine: EngineFactory = async (pid, funcs = {}) => {
  const worldJS = (await import('../world/world.ts?worldsrc')).default;
  // Transfer a fresh buffer because transferring detaches the sender's copy.
  const rollupWasmBytes = (await loadRollupBrowserWasm()).slice().buffer;
  const worker = new Worker(new URL('../worker/native-loader.ts', import.meta.url), { type: 'module' });
  return createWorkerEngine(pid, funcs, worker, {
    js: worldJS,
    esbuildBrowserUrl,
    esbuildWasmUrl,
    rollupBrowserWasmBytes: rollupWasmBytes,
  }, true, [rollupWasmBytes]);
};

export const createSpiderMonkeyLegacyEngine: EngineFactory = async (pid, funcs = {}) => {
  const { wasmUrl, args, wasmModule } = await resolveSpiderMonkey();
  const worldJS = (await import('../world/world.ts?worldsrc')).default;
  const worker = new Worker(new URL('../worker/wasi-loader.ts', import.meta.url), { type: 'module' });
  return createWorkerEngine(pid, funcs, worker, { js: worldJS, wasmUrl, args, wasmModule });
};

export const createEngineFactory = (runtime: DuskRuntime = 'native'): EngineFactory => {
  if (runtime === 'native') return createNativeEngine;
  if (runtime === 'spidermonkey-legacy') return createSpiderMonkeyLegacyEngine;
  throw new Error(`Unknown Dusk runtime: ${String(runtime)}`);
};

// Backward-compatible alias for callers that previously imported createEngine.
export const createEngine = createNativeEngine;
