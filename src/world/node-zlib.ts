// node:zlib — backed by host SubtleCrypto-style IPC into CompressionStream / DecompressionStream.
// Provides sync helpers (gzipSync / gunzipSync / deflateSync / inflateSync / deflateRawSync / inflateRawSync)
// and async helpers + Transform-style classes.

import { Transform } from './node-stream';

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const __call = (f: string, extra: Record<string, unknown> = {}): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) throw new Error(r.error);
  return r.value;
};

const toBytes = (data: unknown): Uint8Array => {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return new Uint8Array(0);
};

const bytesToBuffer = (b: Uint8Array): Uint8Array => {
  const g = globalThis as Record<string, unknown>;
  const Buffer = g['Buffer'] as undefined | { from(b: Uint8Array): Uint8Array };
  return Buffer ? Buffer.from(b) : b;
};

// Format: 'gzip' | 'deflate' | 'deflate-raw'
const callOp = (op: 'compress' | 'decompress', format: 'gzip' | 'deflate' | 'deflate-raw', data: Uint8Array): Uint8Array => {
  const arr = __call(`zlib.${op}`, { format, data }) as number[] | undefined;
  if (!arr) throw new Error(`zlib ${op} returned no data`);
  return bytesToBuffer(Uint8Array.from(arr));
};

// Sync helpers
export const gzipSync = (data: unknown): Uint8Array => callOp('compress', 'gzip', toBytes(data));
export const gunzipSync = (data: unknown): Uint8Array => callOp('decompress', 'gzip', toBytes(data));
export const deflateSync = (data: unknown): Uint8Array => callOp('compress', 'deflate', toBytes(data));
export const inflateSync = (data: unknown): Uint8Array => callOp('decompress', 'deflate', toBytes(data));
export const deflateRawSync = (data: unknown): Uint8Array => callOp('compress', 'deflate-raw', toBytes(data));
export const inflateRawSync = (data: unknown): Uint8Array => callOp('decompress', 'deflate-raw', toBytes(data));

// Async (callback) helpers
const asyncOp = (op: 'compress' | 'decompress', format: 'gzip' | 'deflate' | 'deflate-raw') =>
  (data: unknown, optsOrCb?: unknown, maybeCb?: (err: Error | null, result?: Uint8Array) => void): void => {
    const cb = typeof optsOrCb === 'function' ? optsOrCb as (err: Error | null, result?: Uint8Array) => void : maybeCb;
    if (!cb) throw new TypeError('callback required');
    Promise.resolve().then(() => {
      try { cb(null, callOp(op, format, toBytes(data))); }
      catch (e) { cb(e as Error); }
    });
  };

export const gzip = asyncOp('compress', 'gzip');
export const gunzip = asyncOp('decompress', 'gzip');
export const deflate = asyncOp('compress', 'deflate');
export const inflate = asyncOp('decompress', 'deflate');
export const deflateRaw = asyncOp('compress', 'deflate-raw');
export const inflateRaw = asyncOp('decompress', 'deflate-raw');

// Transform streams: buffer all input, compress/decompress at flush.
// Not true streaming (no incremental output) — matches Node's semantics for
// most common usage but loses memory efficiency for very large inputs.
const makeTransform = (op: 'compress' | 'decompress', format: 'gzip' | 'deflate' | 'deflate-raw'): Transform => {
  const chunks: Uint8Array[] = [];
  return new Transform({
    transform(chunk, _enc, cb) {
      chunks.push(toBytes(chunk));
      cb();
    },
    flush(cb) {
      try {
        let total = 0;
        for (const c of chunks) total += c.length;
        const combined = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { combined.set(c, off); off += c.length; }
        const result = callOp(op, format, combined);
        cb(null, result);
      } catch (e) { cb(e as Error); }
    },
  });
};

export const createGzip = (): Transform => makeTransform('compress', 'gzip');
export const createGunzip = (): Transform => makeTransform('decompress', 'gzip');
export const createDeflate = (): Transform => makeTransform('compress', 'deflate');
export const createInflate = (): Transform => makeTransform('decompress', 'deflate');
export const createDeflateRaw = (): Transform => makeTransform('compress', 'deflate-raw');
export const createInflateRaw = (): Transform => makeTransform('decompress', 'deflate-raw');

export const constants = Object.freeze({
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_DEFAULT_COMPRESSION: -1,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_STRATEGY: 0,
  Z_FILTERED: 1,
  Z_HUFFMAN_ONLY: 2,
  Z_RLE: 3,
  Z_FIXED: 4,
  DEFLATE: 1,
  INFLATE: 2,
  GZIP: 3,
  GUNZIP: 4,
  DEFLATERAW: 5,
  INFLATERAW: 6,
});

export const nodeZlib = {
  gzip, gunzip, deflate, inflate, deflateRaw, inflateRaw,
  gzipSync, gunzipSync, deflateSync, inflateSync, deflateRawSync, inflateRawSync,
  createGzip, createGunzip, createDeflate, createInflate, createDeflateRaw, createInflateRaw,
  constants,
};
