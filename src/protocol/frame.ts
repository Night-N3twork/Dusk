const BYTES_KEY = '\u0000b';
const HEADER_SIZE = 6;

type Holder = Record<string, unknown>;

export const bytesAsArrays = function (this: unknown, key: string, value: unknown): unknown {
  const raw = (this as Holder)[key];
  return raw instanceof Uint8Array ? Array.from(raw) : value;
};

export const toCloneable = (value: unknown, seen: Set<object> = new Set()): unknown => {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'bigint') throw new TypeError('Do not know how to serialize a BigInt');
  if (type !== 'object') return undefined;
  if (value instanceof Uint8Array) return value;
  const object = value as { toJSON?: (key: string) => unknown };
  if (typeof object.toJSON === 'function') return toCloneable(object.toJSON(''), seen);
  if (seen.has(object)) throw new TypeError('Converting circular structure to JSON');
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      return object.map((item) => {
        const converted = toCloneable(item, seen);
        return converted === undefined ? null : converted;
      });
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
      const converted = toCloneable((object as Holder)[key], seen);
      if (converted !== undefined) out[key] = converted;
    }
    return out;
  } finally {
    seen.delete(object);
  }
};

export const encodeFrame = (message: unknown, encoder: TextEncoder, target: Uint8Array): number => {
  const blobs: Uint8Array[] = [];
  let tail = 0;
  const json = JSON.stringify(message, function (this: unknown, key: string, value: unknown): unknown {
    const raw = (this as Holder)[key];
    if (!(raw instanceof Uint8Array)) return value;
    blobs.push(raw);
    const ref = { [BYTES_KEY]: [tail, raw.byteLength] };
    tail += raw.byteLength;
    return ref;
  }) ?? 'null';
  const body = encoder.encode(json);
  if (blobs.length === 0) {
    if (body.length > target.length) throw new RangeError(`IPC response exceeds SERIAL_RES_SIZE limit (${body.length} > ${target.length})`);
    target.set(body, 0);
    return body.length;
  }
  const total = HEADER_SIZE + body.length + tail;
  if (total > target.length) throw new RangeError(`IPC response exceeds SERIAL_RES_SIZE limit (${total} > ${target.length})`);
  target[0] = 0;
  target[1] = 0x42;
  target[2] = body.length & 0xff;
  target[3] = (body.length >>> 8) & 0xff;
  target[4] = (body.length >>> 16) & 0xff;
  target[5] = (body.length >>> 24) & 0xff;
  target.set(body, HEADER_SIZE);
  let offset = HEADER_SIZE + body.length;
  for (const blob of blobs) {
    target.set(blob, offset);
    offset += blob.byteLength;
  }
  return total;
};

export const decodeFrame = (view: Uint8Array, size: number, decoder: TextDecoder): unknown => {
  if (size >= HEADER_SIZE && view[0] === 0 && view[1] === 0x42) {
    const jsonLength = (view[2]! | (view[3]! << 8) | (view[4]! << 16) | (view[5]! << 24)) >>> 0;
    const tailStart = HEADER_SIZE + jsonLength;
    const text = decoder.decode(view.slice(HEADER_SIZE, tailStart));
    return JSON.parse(text, (_key, value: unknown) => {
      if (value === null || typeof value !== 'object') return value;
      const ref = (value as Holder)[BYTES_KEY];
      if (!Array.isArray(ref)) return value;
      const start = tailStart + (ref[0] as number);
      return view.slice(start, start + (ref[1] as number));
    });
  }
  return JSON.parse(decoder.decode(view.slice(0, size)));
};
