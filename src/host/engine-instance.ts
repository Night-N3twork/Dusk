import { SERIAL_RES_SIZE, type WorldToHost } from '../protocol/messages';
import { resolveSpiderMonkey } from '../engine/spidermonkey';

export type SendFn = (msg: unknown) => void;
export type FuncFn = (msg: Record<string, unknown>, send: SendFn) => void;
export type FuncTable = Record<string, FuncFn>;

export interface EngineInstance {
  pid: number;
  run(js: string): Promise<void>;
  dispatch(js: string): void;
  terminate(): Promise<number>;
  readonly exited: Promise<number>;
}

export const createEngine = async (pid: number, funcs: FuncTable = {}): Promise<EngineInstance> => {
  if (!crossOriginIsolated) throw new Error('DuskJS requires cross-origin isolation (SharedArrayBuffer)');

  const { wasmUrl, args, wasmModule } = await resolveSpiderMonkey();
  const worldJS = (await import('../world/world.ts?worldsrc')).default;

  const worker = new Worker(new URL('../worker/wasi-loader.ts', import.meta.url), { type: 'module' });

  const lengthBuffer = new SharedArrayBuffer(4);
  const lengthTyped = new Int32Array(lengthBuffer);
  const valueBuffer = new SharedArrayBuffer(SERIAL_RES_SIZE);
  const valueTyped = new Uint8Array(valueBuffer);
  const encoder = new TextEncoder();
  void wasmUrl;

  const queue: string[] = [];
  const dispatchQueue: string[] = [];
  let queueResolve: (() => void) | null = null;
  const handlers: Record<string, (msg: WorldToHost & { exitCode?: number }) => void> = {};

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
    const bytes = encoder.encode(JSON.stringify(msg));
    if (bytes.length > SERIAL_RES_SIZE) {
      throw new Error('IPC response exceeds SERIAL_RES_SIZE limit (' + bytes.length + ' > ' + SERIAL_RES_SIZE + ')');
    }
    for (let i = 0; i < bytes.length; i++) Atomics.store(valueTyped, i, bytes[i]!);
    Atomics.store(lengthTyped, 0, bytes.length);
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

  handlers.wait = async () => {
    while (queue.length === 0 && dispatchQueue.length === 0) {
      await new Promise<void>((res) => { queueResolve = res; });
    }
    queueResolve = null;
    // Primary run() bodies ALWAYS go first — dispatch envelopes cannot preempt
    // the entry script during engine boot. Otherwise a signal delivered before
    // the body has had a chance to register handlers will run before it and
    // hit the default-terminate branch (see src/world/node-process.ts:426).
    const js = queue.length > 0 ? queue.pop()! : dispatchQueue.shift()!;
    sendEvalRaw(js);
  };

  handlers.exit = (msg) => {
    exitCode = msg.exitCode ?? 0;
    worker.terminate();
    exitResolve(exitCode);
  };

  worker.postMessage({ lengthBuffer, valueBuffer, js: worldJS, pid, wasmUrl, args, wasmModule });

  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data as WorldToHost & { type?: string; f?: string };
    const handler = msg.type ? handlers[msg.type] : undefined;
    const func = msg.f ? funcs[msg.f] : undefined;
    if (handler) handler(msg);
    else if (func) func(msg as Record<string, unknown>, send);
    else send({});
  };

  return {
    pid,
    run: (js: string) => new Promise<void>((resolve) => {
      queue.push(js.trim());
      if (queueResolve) queueResolve();
      handlers.done = () => { send({}); delete handlers.done; resolve(); };
    }),
    dispatch: (js: string) => { dispatchQueue.push(js); if (queueResolve) queueResolve(); },
    terminate: async () => { worker.terminate(); exitResolve(1); return 1; },
    exited,
  };
};
