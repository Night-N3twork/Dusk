// DuskJS in-engine world (runs inside js.wasm). No DOM. Loaded as raw text.
import { installNodeGlobals } from './node-globals';
import { installRequire } from './require';
import { installESM } from './esm';
import { installNet } from './net';
import { bytesAsArrays } from '../protocol/frame';

{
  const g = globalThis as Record<string, unknown>;
  if (typeof g['global'] === 'undefined') g['global'] = globalThis;
}

// Timer polyfills for the SpiderMonkey shell. The shell provides a synchronous
// `setTimeout` (fires during drainJobQueue with no real delay) but nothing
// else in the timer family. Third-party libraries (just-bash, sprintf-js
// chains, Node stdlib re-exports) assume the full pair exists — undefined
// `clearTimeout` in particular crashes anything that stores a handle for
// later cancellation. Install no-op fallbacks BEFORE any engine module
// installs its own wrappers.
{
  const g = globalThis as Record<string, unknown>;
  if (typeof g['clearTimeout'] === 'undefined') {
    g['clearTimeout'] = (_id?: unknown): void => { /* no-op — fake setTimeout is synchronous */ };
  }
  if (typeof g['clearInterval'] === 'undefined') {
    g['clearInterval'] = (_id?: unknown): void => { /* no-op */ };
  }
  if (typeof g['setInterval'] === 'undefined') {
    // Fire once synchronously (matches the fake setTimeout semantics) and
    // return a nominal handle so clearInterval(id) is symmetric.
    g['setInterval'] = (fn: () => void, _ms?: number): number => {
      try { fn(); } catch { /* */ }
      return 0;
    };
  }
  if (typeof g['setImmediate'] === 'undefined') {
    g['setImmediate'] = (fn: () => void, ...args: unknown[]): number => {
      Promise.resolve().then(() => { try { (fn as (...a: unknown[]) => void)(...args); } catch { /* */ } });
      return 0;
    };
  }
  if (typeof g['clearImmediate'] === 'undefined') {
    g['clearImmediate'] = (_id?: unknown): void => { /* no-op */ };
  }
  if (typeof g['queueMicrotask'] === 'undefined') {
    g['queueMicrotask'] = (fn: () => void): void => {
      Promise.resolve().then(fn).catch(() => { /* */ });
    };
  }
}

// TextEncoder / TextDecoder polyfills — third-party code (just-bash, most
// npm libraries) assumes these exist. SpiderMonkey shell doesn't ship them.
// Minimal spec-close implementations: UTF-8 only, no BOM handling, no
// stream state on decode(). Sufficient for library interop.
{
  const g = globalThis as Record<string, unknown>;
  if (typeof g['TextEncoder'] === 'undefined') {
    class PolyTextEncoder {
      readonly encoding = 'utf-8';
      encode(input: string = ''): Uint8Array {
        const bytes: number[] = [];
        for (let i = 0; i < input.length; i++) {
          let c = input.charCodeAt(i);
          // Handle surrogate pairs
          if (c >= 0xd800 && c <= 0xdbff && i + 1 < input.length) {
            const low = input.charCodeAt(i + 1);
            if (low >= 0xdc00 && low <= 0xdfff) {
              c = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
              i++;
            }
          }
          if (c < 0x80) {
            bytes.push(c);
          } else if (c < 0x800) {
            bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
          } else if (c < 0x10000) {
            bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
          } else {
            bytes.push(
              0xf0 | (c >> 18),
              0x80 | ((c >> 12) & 0x3f),
              0x80 | ((c >> 6) & 0x3f),
              0x80 | (c & 0x3f),
            );
          }
        }
        return new Uint8Array(bytes);
      }
      encodeInto(source: string, dest: Uint8Array): { read: number; written: number } {
        const encoded = this.encode(source);
        const written = Math.min(encoded.length, dest.length);
        for (let i = 0; i < written; i++) dest[i] = encoded[i]!;
        return { read: source.length, written };
      }
    }
    g['TextEncoder'] = PolyTextEncoder;
  }
  // Minimal `globalThis.crypto` shim so third-party libs (just-bash's
  // sha256sum, uuid packages, etc.) can call the standard WebCrypto API.
  // Routes through the host's crypto.digest / crypto.random funcs.
  const gc = g['crypto'] as Record<string, unknown> | undefined;
  if (!gc ||
    typeof (gc['subtle'] as Record<string, unknown> | undefined)?.['digest'] !== 'function' ||
    typeof gc['getRandomValues'] !== 'function' ||
    typeof gc['randomUUID'] !== 'function') {
    const cryptoCall = (fname: string, extra: Record<string, unknown>): unknown => {
      const ipc2 = (globalThis as { ipc?: { send: (m: unknown) => { value?: unknown; error?: string } } }).ipc;
      if (!ipc2) throw new Error('crypto: ipc not available');
      const r = ipc2.send({ f: fname, ...extra });
      if (r.error) throw new Error(r.error);
      return r.value;
    };
    const bytesFrom = (input: unknown): Uint8Array => {
      if (input instanceof Uint8Array) return input;
      if (input instanceof ArrayBuffer) return new Uint8Array(input);
      if (ArrayBuffer.isView(input as ArrayBufferView)) {
        const v = input as ArrayBufferView;
        return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      }
      throw new TypeError('crypto: expected BufferSource');
    };
    const subtle = {
      async digest(algorithm: string | { name: string }, data: BufferSource): Promise<ArrayBuffer> {
        const algo = typeof algorithm === 'string' ? algorithm : algorithm.name;
        const bytes = bytesFrom(data);
        const result = cryptoCall('crypto.digest', {
          algorithm: algo,
          data: bytes,
        }) as number[];
        return Uint8Array.from(result).buffer;
      },
      async importKey(_format: string, keyData: BufferSource, algo: { name: string; hash?: string | { name: string } }, extractable: boolean, usages: string[]): Promise<unknown> {
        return { _raw: bytesFrom(keyData), algo, extractable, usages };
      },
      async sign(algorithm: string | { name: string }, key: { _raw: Uint8Array; algo: { hash?: string | { name: string } } }, data: BufferSource): Promise<ArrayBuffer> {
        const bytes = bytesFrom(data);
        const hashAlgo = typeof key.algo.hash === 'string' ? key.algo.hash : key.algo.hash?.name ?? 'SHA-256';
        const result = cryptoCall('crypto.hmac', {
          algorithm: hashAlgo,
          key: key._raw,
          data: bytes,
        }) as number[];
        void algorithm;
        return Uint8Array.from(result).buffer;
      },
    };
    const isIntegerTypedArray = (value: unknown): value is Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array =>
      value instanceof Int8Array ||
      value instanceof Uint8Array ||
      value instanceof Uint8ClampedArray ||
      value instanceof Int16Array ||
      value instanceof Uint16Array ||
      value instanceof Int32Array ||
      value instanceof Uint32Array;
    const cryptoShim = {
      subtle,
      getRandomValues<T extends ArrayBufferView>(buf: T): T {
        if (!isIntegerTypedArray(buf)) throw new TypeError('crypto.getRandomValues expects an integer typed array');
        if (buf.byteLength > 65_536) {
          const error = new Error('The requested length exceeds 65,536 bytes');
          error.name = 'QuotaExceededError';
          throw error;
        }
        const view = buf as ArrayBufferView;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        const rand = cryptoCall('crypto.random', { size: bytes.length }) as number[];
        for (let i = 0; i < bytes.length && i < rand.length; i++) bytes[i] = rand[i]!;
        return buf;
      },
      randomUUID(): string {
        const b = new Uint8Array(16);
        (this as { getRandomValues: (b: Uint8Array) => Uint8Array }).getRandomValues(b);
        b[6] = (b[6]! & 0x0f) | 0x40;
        b[8] = (b[8]! & 0x3f) | 0x80;
        const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
        return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
      },
    };
    // Merge if partial crypto exists; else set fresh.
    if (gc) {
      if (!gc['subtle']) gc['subtle'] = subtle;
      if (!gc['getRandomValues']) gc['getRandomValues'] = cryptoShim.getRandomValues;
      if (!gc['randomUUID']) gc['randomUUID'] = cryptoShim.randomUUID;
    } else {
      g['crypto'] = cryptoShim;
    }
  }

  if (typeof g['TextDecoder'] === 'undefined') {
    class PolyTextDecoder {
      readonly encoding: string;
      readonly fatal: boolean;
      readonly ignoreBOM: boolean;
      constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }) {
        this.encoding = (label ?? 'utf-8').toLowerCase();
        this.fatal = options?.fatal ?? false;
        this.ignoreBOM = options?.ignoreBOM ?? false;
        // We only support UTF-8-like encodings. latin1 also passes through
        // because a well-formed latin1 byte < 0x80 or between 0xa0-0xff
        // decodes to the same charCode in single-byte-per-char mode.
        if (this.encoding !== 'utf-8' && this.encoding !== 'utf8'
            && this.encoding !== 'latin1' && this.encoding !== 'iso-8859-1') {
          // Accept but treat as utf-8; libraries rarely branch on encoding.
        }
      }
      decode(input?: ArrayBufferView | ArrayBuffer, _options?: { stream?: boolean }): string {
        if (input === undefined) return '';
        let bytes: Uint8Array;
        if (input instanceof Uint8Array) bytes = input;
        else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
        else bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        // Latin1 fast path
        if (this.encoding === 'latin1' || this.encoding === 'iso-8859-1') {
          let s = '';
          for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
          return s;
        }
        // UTF-8 decode
        let s = '';
        let i = 0;
        while (i < bytes.length) {
          const b0 = bytes[i]!;
          if (b0 < 0x80) {
            s += String.fromCharCode(b0);
            i++;
          } else if ((b0 & 0xe0) === 0xc0 && i + 1 < bytes.length) {
            const b1 = bytes[i + 1]!;
            s += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
            i += 2;
          } else if ((b0 & 0xf0) === 0xe0 && i + 2 < bytes.length) {
            const b1 = bytes[i + 1]!;
            const b2 = bytes[i + 2]!;
            s += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
            i += 3;
          } else if ((b0 & 0xf8) === 0xf0 && i + 3 < bytes.length) {
            const b1 = bytes[i + 1]!;
            const b2 = bytes[i + 2]!;
            const b3 = bytes[i + 3]!;
            const cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
            if (cp >= 0x10000) {
              const off = cp - 0x10000;
              s += String.fromCharCode(0xd800 + (off >> 10), 0xdc00 + (off & 0x3ff));
            } else {
              s += String.fromCharCode(cp);
            }
            i += 4;
          } else {
            // Malformed byte — fatal mode throws, else emit replacement char.
            if (this.fatal) throw new TypeError('The encoded data was not valid.');
            s += '\ufffd';
            i++;
          }
        }
        return s;
      }
    }
    g['TextDecoder'] = PolyTextDecoder;
  }
}

const isNativeWorker = (globalThis as Record<string, unknown>)['__DUSK_NATIVE_WORKER__'] === true;
const hostEval = globalThis.eval;

if (typeof (globalThis as { ipc?: unknown }).ipc === 'undefined') {
  if (isNativeWorker) {
    const nativeSend = (globalThis as Record<string, unknown>)['__duskIpcSend'] as ((msg: unknown) => unknown) | undefined;
    (globalThis as Record<string, unknown>).ipc = {
      send: nativeSend ?? ((msg: unknown) => {
        print(JSON.stringify(msg, bytesAsArrays));
        return JSON.parse(os.file.readFile('/comm'));
      }),
    };
  } else {
  (globalThis as Record<string, unknown>).evalQueue = [];
  (globalThis as Record<string, unknown>).ipc = {
    send: (msg: unknown, ignoreEval = true) => {
      print(JSON.stringify(msg, bytesAsArrays));
      return (globalThis as { ipc: { recv: (i: boolean) => unknown } }).ipc.recv(ignoreEval);
    },
    recv: (ignoreEval: boolean) => {
      while (true) {
        const read = readline();
        if (!read) continue;
        const str = os.file.readFile('/comm');
        let msg: { type?: string; js?: string };
        if (str.startsWith('JS|')) msg = { type: 'eval', js: str.slice(3) };
        else msg = JSON.parse(str);
        if (msg.type === 'eval') {
          (globalThis as { evalQueue: unknown[] }).evalQueue.push(msg);
          if (ignoreEval) continue;
        }
        return msg;
      }
    },
  };
  }
}

declare const drainJobQueue: (() => void) | undefined;

const ipc = (globalThis as { ipc: { send: (m: unknown, i?: boolean) => { js?: string } } }).ipc;

const worldGlobal = globalThis as Record<string, unknown>;
// Preserve the Worker task scheduler before the Node timer shim replaces it
// with host-backed timers. Native evals must yield to browser tasks.
const scheduleNativeTask = isNativeWorker ? globalThis.setTimeout.bind(globalThis) : undefined;

if (!worldGlobal['__process']) {
  worldGlobal['__process'] = {
    _exitCode: undefined as number | undefined,
    dispatch: (_pid: number, _event: string, _data: unknown) => {
    },
  };
}

interface DuskLifecycle {
  retain(): () => void;
  whenIdle(): Promise<void>;
  active(): number;
  whenAtMost(count: number): Promise<void>;
}

const processRecord = worldGlobal['__process'] as Record<string, unknown>;
if (isNativeWorker && !processRecord['__duskLifecycle']) {
  let count = 0;
  const waiters: Array<{ limit: number; resolve: () => void }> = [];
  const settle = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]!;
      if (count <= waiter.limit) {
        waiters.splice(i, 1);
        waiter.resolve();
      }
    }
  };
  const whenAtMost = (limit: number): Promise<void> => {
    if (count <= limit) return Promise.resolve();
    return new Promise<void>((resolve) => { waiters.push({ limit, resolve }); });
  };
  const lifecycle: DuskLifecycle = {
    retain: (): (() => void) => {
      count++;
      let released = false;
      return (): void => {
        if (released) return;
        released = true;
        count--;
        settle();
      };
    },
    whenIdle: (): Promise<void> => whenAtMost(0),
    active: (): number => count,
    whenAtMost,
  };
  processRecord['__duskLifecycle'] = lifecycle;
}

if (isNativeWorker) {
  type TimerRecord = { callback: Function; args: unknown[]; interval: number | null; refed: boolean; release: (() => void) | undefined };
  interface TimerHandle {
    ref(): TimerHandle;
    unref(): TimerHandle;
    hasRef(): boolean;
    valueOf(): number;
  }
  const timers = new Map<number, TimerRecord>();
  let nextTimerId = 1;
  const schedule = (id: number, delay: number): void => { ipc.send({ f: 'timer.schedule', id, delay }); };
  const cancel = (id: number): void => { ipc.send({ f: 'timer.cancel', id }); };
  const timerId = (value: unknown): number => typeof value === 'number' ? value : Number(value);
  const updateLifetime = (timer: TimerRecord): void => {
    const lifecycle = ((globalThis as Record<string, unknown>)['__process'] as { __duskLifecycle?: DuskLifecycle } | undefined)?.__duskLifecycle;
    if (timer.refed && !timer.release) timer.release = lifecycle?.retain();
    if (!timer.refed && timer.release) {
      timer.release();
      timer.release = undefined;
    }
  };
  const create = (callback: Function, delay: number | undefined, args: unknown[], interval: number | null): TimerHandle => {
    const id = nextTimerId++;
    const record: TimerRecord = { callback, args, interval, refed: true, release: undefined };
    timers.set(id, record);
    updateLifetime(record);
    schedule(id, delay ?? 0);
    const handle: TimerHandle = {
      ref: (): TimerHandle => { record.refed = true; updateLifetime(record); return handle; },
      unref: (): TimerHandle => { record.refed = false; updateLifetime(record); return handle; },
      hasRef: (): boolean => record.refed,
      valueOf: (): number => id,
    };
    return handle;
  };
  const g = globalThis as Record<string, unknown>;
  g['setTimeout'] = (callback: Function, delay?: number, ...args: unknown[]): TimerHandle => create(callback, delay, args, null);
  g['setInterval'] = (callback: Function, delay?: number, ...args: unknown[]): TimerHandle => create(callback, delay, args, delay ?? 0);
  g['clearTimeout'] = (value: unknown): void => {
    const id = timerId(value);
    const timer = timers.get(id);
    timers.delete(id);
    timer?.release?.();
    if (timer) timer.release = undefined;
    cancel(id);
  };
  g['clearInterval'] = g['clearTimeout'];
  g['setImmediate'] = (callback: Function, ...args: unknown[]): TimerHandle => create(callback, 0, args, null);
  g['clearImmediate'] = g['clearTimeout'];
  g['__duskTimers'] = {
    fire(id: number): void {
      const timer = timers.get(id);
      if (!timer) return;
      if (timer.interval === null) timers.delete(id);
      try { timer.callback(...timer.args); } catch (error) { print(JSON.stringify({ f: 'console.error', args: [String(error)] })); }
      if (timer.interval !== null && timers.has(id)) schedule(id, timer.interval);
      if (timer.interval === null && timer.release) {
        timer.release();
        timer.release = undefined;
      }
    },
  };
}

installNodeGlobals();
installRequire();
installESM();
installNet();

if (isNativeWorker) {
  const evalQueue: Array<{ js: string; primary: boolean }> = [];
  let scheduled = false;
  let exited = false;

  const execute = async ({ js, primary }: { js: string; primary: boolean }): Promise<void> => {
    try {
      await hostEval('(async () => {' + js.replace(/\bimport\s*\(/g, '__import__(') + '\n})()');
    } catch (e) {
      print(JSON.stringify({ f: 'console.error', args: [String(e)] }));
    }
    const proc = worldGlobal['__process'] as { _exitCode?: number } | undefined;
    if (proc?._exitCode !== undefined) {
      if (!exited) {
        exited = true;
        ipc.send({ type: 'exit', exitCode: proc._exitCode });
      }
      return;
    }
    ipc.send({ type: 'done', primary });
  };

  const drain = (): void => {
    scheduled = false;
    const entry = evalQueue.shift();
    if (!entry || exited) return;
    // Start one evaluation per Worker task so host events and Promise jobs
    // can interleave with a primary async continuation.
    void execute(entry);
    if (evalQueue.length > 0) schedule();
  };
  const schedule = (): void => {
    if (scheduled || exited) return;
    scheduled = true;
    scheduleNativeTask!(drain, 0);
  };
  worldGlobal['__duskEnqueueEval'] = (js: string, primary: boolean): void => {
    evalQueue.push({ js, primary });
    schedule();
  };
} else {
  while (true) {
    const reply = ipc.send({ type: 'wait' }, false);
    const js = (reply.js ?? '').replace(/\bimport\s*\(/g, '__import__(');
    try { hostEval('(async () => {' + js + '\n})()'); if (typeof drainJobQueue === 'function') drainJobQueue(); } catch (e) { print(JSON.stringify({ f: 'console.error', args: [String(e)] })); }
    const proc = (globalThis as Record<string, unknown>)['__process'] as { _exitCode?: number } | undefined;
    if (proc?._exitCode !== undefined) {
      ipc.send({ type: 'exit', exitCode: proc._exitCode });
      break;
    }
    ipc.send({ type: 'done' });
  }
}
