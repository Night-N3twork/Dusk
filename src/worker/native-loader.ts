import { SERIAL_RES_SIZE, type BufferInit } from '../protocol/messages';
import { decodeFrame, toCloneable } from '../protocol/frame';
import { createEsbuildWasmAdapter } from './esbuild-wasm-adapter';

const decoder = new TextDecoder();
// Host IPC must remain available while guest code runs under just-bash's
// defense context, which deliberately guards globalThis.Atomics.
const hostAtomics = Atomics;
let syncRpcSeq = 0;
const stagedBytes = new Map<number, Uint8Array>();

self.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as { type?: string; id?: number; data?: Uint8Array };
  if (message?.type === 'bytes' && typeof message.id === 'number' && message.data) stagedBytes.set(message.id, message.data);
});
(globalThis as Record<string, unknown>)['__duskTakeBytes'] = (id: number): Uint8Array => {
  const bytes = stagedBytes.get(id);
  stagedBytes.delete(id);
  return bytes ?? new Uint8Array(0);
};

self.addEventListener('message', async (event: MessageEvent) => {
  const init = event.data as Partial<BufferInit> & { pid?: number };
  if (!init.lengthBuffer || !init.valueBuffer || init.js === undefined) return;

  const length = new Int32Array(init.lengthBuffer);
  const value = new Uint8Array(init.valueBuffer);
  const shell = globalThis as Record<string, unknown>;
  let response = '';

  shell['__DUSK_NATIVE_WORKER__'] = true;
  const exchange = <T>(message: Record<string, unknown>, read: (size: number) => T): T => {
    hostAtomics.store(length, 0, 0);
    const requestSeq = ++syncRpcSeq;
    self.postMessage({ ...message, syncRpcSeq: requestSeq });
    hostAtomics.wait(length, 0, 0, Infinity);
    const size = hostAtomics.load(length, 0);
    try {
      if (size > SERIAL_RES_SIZE) throw new Error('IPC response exceeds SERIAL_RES_SIZE limit');
      return read(size);
    } finally {
      self.postMessage({ type: 'sync-rpc-consumed', syncRpcSeq: requestSeq });
    }
  };
  shell['print'] = (text: unknown): void => {
    let message: unknown;
    try { message = JSON.parse(String(text)); } catch { console.warn(text); return; }
    response = exchange(message as Record<string, unknown>, (size) => (value[0] === 0 ? '{}' : decoder.decode(value.slice(0, size))));
  };
  shell['__duskIpcSend'] = (message: unknown): unknown =>
    exchange(toCloneable(message) as Record<string, unknown>, (size) => decodeFrame(value, size, decoder));
  shell['readline'] = (): string => 'A';
  shell['os'] = {
    file: {
      readFile(path: string): string {
        if (path !== '/comm') throw new Error(`native worker cannot read ${path}`);
        return response;
      },
    },
  };
  try {
    if (init.esbuildBrowserUrl && init.esbuildWasmUrl) {
      shell['__DUSK_ESBUILD_WASM__'] = createEsbuildWasmAdapter({
        browserUrl: init.esbuildBrowserUrl,
        wasmUrl: init.esbuildWasmUrl,
      });
    }
    if (init.rollupBrowserWasmBytes) {
      shell['__DUSK_ROLLUP_BROWSER_WASM_BYTES__'] = init.rollupBrowserWasmBytes;
    }
    // The bundled world is an IIFE and installs itself against the Worker global.
    (0, eval)(`const __DUSK_PID__ = ${init.pid ?? 0};\n${init.js}`);
    self.addEventListener('message', (evalEvent: MessageEvent) => {
      const evalMessage = evalEvent.data as { type?: string; js?: string; primary?: boolean };
      if (evalMessage.type !== 'eval' || typeof evalMessage.js !== 'string') return;
      const enqueue = (globalThis as Record<string, unknown>)['__duskEnqueueEval'];
      if (typeof enqueue === 'function') {
        (enqueue as (js: string, primary: boolean) => void)(evalMessage.js, evalMessage.primary === true);
      }
    });
  } catch (error) {
    self.postMessage({ f: 'console.error', args: [String(error)] });
  }
}, { once: true });
