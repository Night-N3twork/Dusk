const memory = (): { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } | undefined =>
  (globalThis as { performance?: { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } } }).performance?.memory;

export const getHeapStatistics = (): Record<string, number> => {
  const m = memory();
  const used = m?.usedJSHeapSize ?? 0;
  const total = m?.totalJSHeapSize ?? used;
  const limit = m?.jsHeapSizeLimit ?? 4 * 1024 * 1024 * 1024;
  return {
    total_heap_size: total,
    total_heap_size_executable: 0,
    total_physical_size: total,
    total_available_size: Math.max(0, limit - used),
    used_heap_size: used,
    heap_size_limit: limit,
    malloced_memory: 0,
    peak_malloced_memory: 0,
    does_zap_garbage: 0,
    number_of_native_contexts: 1,
    number_of_detached_contexts: 0,
    total_global_handles_size: 0,
    used_global_handles_size: 0,
    external_memory: 0,
  };
};

export const getHeapSpaceStatistics = (): Array<Record<string, unknown>> => [];
export const getHeapCodeStatistics = (): Record<string, number> => ({
  code_and_metadata_size: 0,
  bytecode_and_metadata_size: 0,
  external_script_source_size: 0,
  cpu_profiler_metadata_size: 0,
});
export const cachedDataVersionTag = (): number => 0;
export const setFlagsFromString = (_flags: string): void => undefined;
export const setHeapSnapshotNearHeapLimit = (_limit: number): void => undefined;
export const isStringOneByteRepresentation = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) > 0xff) return false;
  return true;
};

const TAG = 0xd5;

type Encoded =
  | { t: 'u' }
  | { t: 'j'; v: unknown }
  | { t: 'n'; v: string }
  | { t: 'b'; v: string }
  | { t: 'd'; v: number }
  | { t: 'r'; s: string; f: string }
  | { t: 'm'; v: Array<[Encoded, Encoded]> }
  | { t: 's'; v: Encoded[] }
  | { t: 'a'; v: Encoded[] }
  | { t: 'o'; v: Array<[string, Encoded]> }
  | { t: 'x'; k: string; v: string }
  | { t: 'e'; n: string; m: string; s?: string };

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array => {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

const TYPED: Record<string, new (buffer: ArrayBuffer) => ArrayBufferView> = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView,
};

const encode = (value: unknown, seen: Set<object>): Encoded => {
  if (value === undefined) return { t: 'u' };
  if (typeof value === 'bigint') return { t: 'n', v: value.toString() };
  if (typeof value === 'number' && !Number.isFinite(value)) return { t: 'j', v: String(value) };
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') {
      const error = new Error(`${String(value)} could not be cloned.`);
      error.name = 'DataCloneError';
      throw error;
    }
    return { t: 'j', v: value };
  }
  if (seen.has(value)) throw new TypeError('Cyclic structures are not supported by v8.serialize in Dusk');
  seen.add(value);
  try {
    if (value instanceof Date) return { t: 'd', v: value.getTime() };
    if (value instanceof RegExp) return { t: 'r', s: value.source, f: value.flags };
    if (value instanceof Map) return { t: 'm', v: [...value].map(([k, v]) => [encode(k, seen), encode(v, seen)]) };
    if (value instanceof Set) return { t: 's', v: [...value].map((v) => encode(v, seen)) };
    if (value instanceof ArrayBuffer) return { t: 'b', v: toBase64(new Uint8Array(value)) };
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      const kind = (value as { constructor: { name: string } }).constructor.name;
      return { t: 'x', k: TYPED[kind] ? kind : 'Uint8Array', v: toBase64(bytes) };
    }
    if (value instanceof Error) return { t: 'e', n: value.name, m: value.message, ...(value.stack ? { s: value.stack } : {}) };
    if (Array.isArray(value)) return { t: 'a', v: value.map((v) => encode(v, seen)) };
    return { t: 'o', v: Object.keys(value).map((k) => [k, encode((value as Record<string, unknown>)[k], seen)]) };
  } finally {
    seen.delete(value);
  }
};

const decode = (node: Encoded): unknown => {
  switch (node.t) {
    case 'u': return undefined;
    case 'j': return typeof node.v === 'string' && (node.v === 'NaN' || node.v === 'Infinity' || node.v === '-Infinity') ? Number(node.v) : node.v;
    case 'n': return BigInt(node.v);
    case 'b': return fromBase64(node.v).buffer;
    case 'd': return new Date(node.v);
    case 'r': return new RegExp(node.s, node.f);
    case 'm': return new Map(node.v.map(([k, v]) => [decode(k), decode(v)]));
    case 's': return new Set(node.v.map(decode));
    case 'a': return node.v.map(decode);
    case 'o': return Object.fromEntries(node.v.map(([k, v]) => [k, decode(v)]));
    case 'x': {
      const Ctor = TYPED[node.k] ?? Uint8Array;
      return new Ctor(fromBase64(node.v).buffer as ArrayBuffer);
    }
    case 'e': {
      const ErrorCtor = (globalThis as Record<string, unknown>)[node.n] as (new (message: string) => Error) | undefined;
      const error = typeof ErrorCtor === 'function' ? new ErrorCtor(node.m) : new Error(node.m);
      if (node.s) error.stack = node.s;
      return error;
    }
  }
};

const toBuffer = (bytes: Uint8Array): Uint8Array => {
  const BufferCtor = (globalThis as Record<string, unknown>)['Buffer'] as { from(b: Uint8Array): Uint8Array } | undefined;
  return BufferCtor ? BufferCtor.from(bytes) : bytes;
};

export const serialize = (value: unknown): Uint8Array => {
  const json = new TextEncoder().encode(JSON.stringify(encode(value, new Set())));
  const out = new Uint8Array(json.length + 1);
  out[0] = TAG;
  out.set(json, 1);
  return toBuffer(out);
};

export const deserialize = (buffer: Uint8Array): unknown => {
  if (!(buffer instanceof Uint8Array) || buffer[0] !== TAG) throw new Error('Unable to deserialize cloned data.');
  return decode(JSON.parse(new TextDecoder().decode(buffer.subarray(1))) as Encoded);
};

export class Serializer {
  private value: unknown;
  writeHeader(): void { }
  writeValue(value: unknown): boolean { this.value = value; return true; }
  releaseBuffer(): Uint8Array { return serialize(this.value); }
}

export class Deserializer {
  constructor(private readonly buffer: Uint8Array) { }
  readHeader(): boolean { return true; }
  readValue(): unknown { return deserialize(this.buffer); }
}

export class DefaultSerializer extends Serializer { }
export class DefaultDeserializer extends Deserializer { }

export const writeHeapSnapshot = (): string => {
  const error = new Error('v8.writeHeapSnapshot is not available in the browser');
  (error as Error & { code?: string }).code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
  throw error;
};

export const getHeapSnapshot = writeHeapSnapshot;

export const startupSnapshot = {
  isBuildingSnapshot: (): boolean => false,
  addSerializeCallback: (_callback: (data?: unknown) => void, _data?: unknown): void => undefined,
  addDeserializeCallback: (_callback: (data?: unknown) => void, _data?: unknown): void => undefined,
  setDeserializeMainFunction: (_callback: (data?: unknown) => void, _data?: unknown): void => undefined,
};

export const nodeV8 = {
  startupSnapshot,
  getHeapStatistics,
  getHeapSpaceStatistics,
  getHeapCodeStatistics,
  cachedDataVersionTag,
  setFlagsFromString,
  setHeapSnapshotNearHeapLimit,
  isStringOneByteRepresentation,
  serialize,
  deserialize,
  Serializer,
  Deserializer,
  DefaultSerializer,
  DefaultDeserializer,
  writeHeapSnapshot,
  getHeapSnapshot,
};
