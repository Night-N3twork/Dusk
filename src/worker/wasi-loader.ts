import './polys';
import { WASI } from '@wasmer/wasi';
import browserBindings from '@wasmer/wasi/lib/bindings/browser';
import { WasmFs } from '@wasmer/wasmfs';
import { SERIAL_RES_SIZE, type BufferInit } from '../protocol/messages';

const decoder = new TextDecoder('utf8');
// Worker-side scratch buffer for copying bytes out of the SAB before
// TextDecoder.decode() (which won't accept a SAB-backed view directly on
// older browsers, and slicing avoids the "detached buffer" surprise on
// newer ones). Grown on demand up to SERIAL_RES_SIZE — most IPC messages
// are well under 64KB, so we start small and double as needed. This saves
// ~4MB of resident memory per SpiderMonkey Worker versus the previous
// eager `new Uint8Array(SERIAL_RES_SIZE)` allocation.
let decodeBuffer = new Uint8Array(64 * 1024);
const ensureDecodeCapacity = (needed: number): void => {
  if (needed <= decodeBuffer.length) return;
  let next = decodeBuffer.length;
  while (next < needed) next *= 2;
  if (next > SERIAL_RES_SIZE) next = SERIAL_RES_SIZE;
  decodeBuffer = new Uint8Array(next);
};

let lengthTyped: Int32Array | undefined;
let valueTyped: Uint8Array | undefined;
let js: string | undefined;
let pid: number | undefined;
let wasmUrl: string | undefined;
let args: string[] | undefined;
let preCompiledModule: WebAssembly.Module | undefined;

const ready = new Promise<void>((resolve) => {
  self.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as Partial<BufferInit> & {
      pid?: number;
      wasmUrl?: string;
      args?: string[];
      wasmModule?: WebAssembly.Module;
    };
    if (!lengthTyped && d.lengthBuffer && d.valueBuffer && d.args) {
      lengthTyped = new Int32Array(d.lengthBuffer);
      valueTyped = new Uint8Array(d.valueBuffer);
      js = d.js;
      pid = d.pid;
      wasmUrl = d.wasmUrl;
      args = d.args;
      preCompiledModule = d.wasmModule;
      resolve();
    }
  });
});

const start = async (): Promise<void> => {
  await ready;
  if (!lengthTyped || !valueTyped || js === undefined || !args)
    throw new Error('worker not initialized');
  if (!preCompiledModule && !wasmUrl)
    throw new Error('worker requires either preCompiledModule or wasmUrl');

  const wasmModule = preCompiledModule ?? (await WebAssembly.compileStreaming(fetch(wasmUrl!)));
  const wasmFs = new WasmFs();
  const randomFillSync = <T>(buffer: T, offset = 0, size?: number): T => {
    const view = buffer as unknown as ArrayBufferView;
    const u8 = new Uint8Array(view.buffer, view.byteOffset + offset, size ?? view.byteLength - offset);
    crypto.getRandomValues(u8);
    return buffer;
  };

  const wasi = new WASI({
    args,
    preopens: { '/': '/' },
    env: {},
    bindings: { ...browserBindings, randomFillSync, fs: wasmFs.fs },
  });

  const instance = await WebAssembly.instantiate(wasmModule, wasi.getImports(wasmModule));

  // Prefix the pid injection here (worker-side) rather than on the host.
  // The host now sends worldJS unmodified, avoiding a full extra copy of
  // the ~344 KB world source per spawn. See engine-instance.ts:40 notes.
  const pidPrefix = pid === undefined ? '' : `const __DUSK_PID__ = ${pid};\n`;
  wasmFs.fs.writeFileSync('/input.js', pidPrefix + js);

  const fds = (wasmFs as { volume: { fds: Record<number, { position: number }> } }).volume.fds;
  if (fds[1]) fds[1].position = 0;
  if (fds[2]) fds[2].position = 0;

  wasmFs.fs.writeFileSync('/comm', '');
  wasmFs.fs.writeFileSync('/dev/stdin', '');
  wasmFs.fs.writeFileSync('/dev/stdout', '');
  wasmFs.fs.writeFileSync('/dev/stderr', '');

  let lastStdout = '';
  wasmFs.fs.watch('/dev/stdout', {}, () => {
    const stdout = wasmFs.fs.readFileSync('/dev/stdout', 'utf8') as string;
    const newStdout = stdout.slice(lastStdout.length);
    lastStdout = stdout;
    if (!newStdout) return;

    for (const line of newStdout.split('\n')) {
      if (!line) continue;
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { console.warn(line); continue; }

      Atomics.store(lengthTyped!, 0, 0);
      self.postMessage(msg);
      Atomics.wait(lengthTyped!, 0, 0, Infinity);

      const length = Atomics.load(lengthTyped!, 0);
      ensureDecodeCapacity(length + 1); // +1 for the trailing newline

      // Copy bytes out of the SAB into our non-shared scratch buffer. The
      // Atomics.wait above already established a happens-before edge with
      // the host's Atomics.notify (which the host does AFTER writing all
      // bytes), so a plain typed-array .set() is race-free here.
      decodeBuffer.set(valueTyped!.subarray(0, length));

      // Two fast paths:
      //   (a) Eval fast-path: host sent raw "JS|<js>" bytes (no JSON wrapper).
      //       Detect by the first three bytes 0x4a 0x53 0x7c ('J' 'S' '|').
      //       Write straight to /comm — no string decode, no JSON parse.
      //   (b) Legacy path: JSON envelope. Decode, JSON.parse to strip the
      //       {"type":"eval",...} wrapper for eval messages, then write.
      //       Kept for tiny dispatch envelopes and back-compat.
      const isEvalRaw =
        length >= 3 && decodeBuffer[0] === 0x4a && decodeBuffer[1] === 0x53 && decodeBuffer[2] === 0x7c;

      if (isEvalRaw) {
        // Append a trailing newline in-place and write the whole slice
        // (bytes) directly to /comm. Skips string allocation on the whole
        // eval body — the biggest single copy in the old path.
        decodeBuffer[length] = 0x0a; // '\n'
        wasmFs.fs.writeFileSync('/comm', decodeBuffer.subarray(0, length + 1));
      } else {
        const replyRaw = decoder.decode(decodeBuffer.subarray(0, length));
        let reply = replyRaw;
        if (reply.startsWith('{"type":"eval')) reply = 'JS|' + (JSON.parse(replyRaw) as { js: string }).js;
        wasmFs.fs.writeFileSync('/comm', reply + '\n');
      }
      wasmFs.fs.appendFileSync('/dev/stdin', 'A\n');
    }
  });

  try { wasi.start(instance); } catch (e) { console.error(e); }
};

void start();
