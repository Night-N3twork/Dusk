const encodeUtf8 = (str: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) { out.push(c); }
    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }
  return out;
};

const decodeUtf8 = (bytes: Uint8Array | number[], start = 0, end?: number): string => {
  const len = end ?? bytes.length;
  let s = '';
  for (let i = start; i < len; ) {
    const b1 = bytes[i++]!;
    if (b1 < 0x80) { s += String.fromCharCode(b1); continue; }
    if (b1 < 0xc0) { s += '\ufffd'; continue; }
    if (b1 < 0xe0) {
      const b2 = bytes[i++];
      if (b2 === undefined) { s += '\ufffd'; continue; }
      s += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f));
      continue;
    }
    if (b1 < 0xf0) {
      const b2 = bytes[i++]; const b3 = bytes[i++];
      if (b2 === undefined || b3 === undefined) { s += '\ufffd'; continue; }
      s += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
      continue;
    }
    const b2 = bytes[i++]; const b3 = bytes[i++]; const b4 = bytes[i++];
    if (b2 === undefined || b3 === undefined || b4 === undefined) { s += '\ufffd'; continue; }
    const cp = ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
    const off = cp - 0x10000;
    s += String.fromCharCode(0xd800 | (off >> 10), 0xdc00 | (off & 0x3ff));
  }
  return s;
};

const HEX = '0123456789abcdef';

const hexEncode = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    s += HEX[(b >> 4) & 0xf]! + HEX[b & 0xf]!;
  }
  return s;
};

const hexDecode = (str: string): Uint8Array => {
  const clean = str.replace(/[^0-9a-fA-F]/g, '');
  const len = clean.length >>> 1;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const b64Encode = (bytes: Uint8Array, alphabet: string = B64, pad: boolean = true): string => {
  let s = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const b0 = bytes[i]!, b1 = bytes[i + 1]!, b2 = bytes[i + 2]!;
    s += alphabet[b0 >> 2]! + alphabet[((b0 & 3) << 4) | (b1 >> 4)]! + alphabet[((b1 & 15) << 2) | (b2 >> 6)]! + alphabet[b2 & 63]!;
  }
  if (i < bytes.length) {
    const b0 = bytes[i]!;
    if (i + 1 < bytes.length) {
      const b1 = bytes[i + 1]!;
      s += alphabet[b0 >> 2]! + alphabet[((b0 & 3) << 4) | (b1 >> 4)]! + alphabet[(b1 & 15) << 2]!;
      if (pad) s += '=';
    } else {
      s += alphabet[b0 >> 2]! + alphabet[(b0 & 3) << 4]!;
      if (pad) s += '==';
    }
  }
  return s;
};

const b64Decode = (str: string, alphabet: string = B64): Uint8Array => {
  const clean = str.replace(/=+$/, '').replace(/\s+/g, '');
  const lookup = new Int8Array(256);
  lookup.fill(-1);
  for (let i = 0; i < alphabet.length; i++) lookup[alphabet.charCodeAt(i)] = i;
  if (alphabet === B64URL) {
    lookup['+'.charCodeAt(0)] = 62;
    lookup['/'.charCodeAt(0)] = 63;
  } else {
    lookup['-'.charCodeAt(0)] = 62;
    lookup['_'.charCodeAt(0)] = 63;
  }

  const outLen = Math.floor((clean.length * 6) / 8);
  const out = new Uint8Array(outLen);
  let bits = 0, accum = 0, oi = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = lookup[clean.charCodeAt(i)];
    if (v === undefined || v < 0) continue;
    accum = (accum << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[oi++] = (accum >> bits) & 0xff;
    }
  }
  return out.subarray(0, oi);
};

export type Encoding =
  | 'utf8' | 'utf-8'
  | 'hex'
  | 'base64' | 'base64url'
  | 'ascii' | 'binary' | 'latin1'
  | 'ucs2' | 'ucs-2' | 'utf16le' | 'utf-16le';

const isEncoding = (s: unknown): s is Encoding => {
  if (typeof s !== 'string') return false;
  switch (s.toLowerCase()) {
    case 'utf8': case 'utf-8':
    case 'hex':
    case 'base64': case 'base64url':
    case 'ascii': case 'binary': case 'latin1':
    case 'ucs2': case 'ucs-2': case 'utf16le': case 'utf-16le':
      return true;
    default:
      return false;
  }
};

const fromString = (str: string, encoding: Encoding = 'utf8'): Uint8Array => {
  switch (encoding.toLowerCase()) {
    case 'utf8':
    case 'utf-8':
      return Uint8Array.from(encodeUtf8(str));
    case 'hex':
      return hexDecode(str);
    case 'base64':
      return b64Decode(str, B64);
    case 'base64url':
      return b64Decode(str, B64URL);
    case 'ascii':
    case 'binary':
    case 'latin1': {
      const out = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
      return out;
    }
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le': {
      const out = new Uint8Array(str.length * 2);
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        out[i * 2] = c & 0xff;
        out[i * 2 + 1] = (c >> 8) & 0xff;
      }
      return out;
    }
    default:
      throw new TypeError(`Unknown encoding: ${encoding}`);
  }
};

const bytesToString = (bytes: Uint8Array, encoding: Encoding, start: number, end: number): string => {
  switch (encoding.toLowerCase()) {
    case 'utf8':
    case 'utf-8':
      return decodeUtf8(bytes, start, end);
    case 'hex':
      return hexEncode(bytes.subarray(start, end));
    case 'base64':
      return b64Encode(bytes.subarray(start, end), B64, true);
    case 'base64url':
      return b64Encode(bytes.subarray(start, end), B64URL, false);
    case 'ascii': {
      let s = '';
      for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]! & 0x7f);
      return s;
    }
    case 'binary':
    case 'latin1': {
      let s = '';
      for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]!);
      return s;
    }
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le': {
      let s = '';
      for (let i = start; i + 1 < end; i += 2) {
        s += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8));
      }
      return s;
    }
    default:
      throw new TypeError(`Unknown encoding: ${encoding}`);
  }
};

const byteLengthOf = (input: string | Uint8Array | ArrayBuffer | ArrayBufferView, encoding: Encoding = 'utf8'): number => {
  if (typeof input === 'string') {
    switch (encoding.toLowerCase()) {
      case 'utf8': case 'utf-8': return encodeUtf8(input).length;
      case 'hex': return Math.floor(input.length / 2);
      case 'base64': case 'base64url': {
        const cleaned = input.replace(/=+$/, '').replace(/\s+/g, '');
        return Math.floor((cleaned.length * 6) / 8);
      }
      case 'ascii': case 'binary': case 'latin1': return input.length;
      case 'ucs2': case 'ucs-2': case 'utf16le': case 'utf-16le': return input.length * 2;
      default: return input.length;
    }
  }
  if (input instanceof ArrayBuffer) return input.byteLength;
  if (ArrayBuffer.isView(input)) return input.byteLength;
  return 0;
};

export class Buffer extends Uint8Array {
  constructor(size: number);
  constructor(array: ArrayLike<number>);
  constructor(buffer: ArrayBufferLike, byteOffset?: number, length?: number);
  constructor(a: number | ArrayLike<number> | ArrayBufferLike, b?: number, c?: number) {
    if (typeof a === 'number') {
      super(a);
    } else if (a instanceof ArrayBuffer) {
      super(a, b, c);
    } else if (typeof SharedArrayBuffer !== 'undefined' && a instanceof SharedArrayBuffer) {
      super(a as unknown as ArrayBuffer, b, c);
    } else {
      super(a as ArrayLike<number>);
    }
  }

  static override from(value: string, encoding?: Encoding): Buffer;
  static override from(value: ArrayLike<number> | Iterable<number>): Buffer;
  static override from(value: ArrayBuffer | SharedArrayBuffer, byteOffset?: number, length?: number): Buffer;
  static override from(value: Buffer): Buffer;
  static override from(value: unknown, b?: unknown, c?: unknown): Buffer {
    if (typeof value === 'string') {
      const enc = (b as Encoding | undefined) ?? 'utf8';
      const bytes = fromString(value, enc);
      return Buffer.fromBytes(bytes);
    }
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
      const buf = new Buffer(value as ArrayBufferLike, b as number | undefined, c as number | undefined);
      return buf;
    }
    if (value instanceof Uint8Array) {
      const out = new Buffer(value.length);
      out.set(value);
      return out;
    }
    if (ArrayBuffer.isView(value)) {
      const v = value as ArrayBufferView;
      const u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      const out = new Buffer(u8.length);
      out.set(u8);
      return out;
    }
    if (Array.isArray(value)) {
      const out = new Buffer(value.length);
      for (let i = 0; i < value.length; i++) out[i] = value[i] & 0xff;
      return out;
    }
    if (value && typeof (value as Iterable<number>)[Symbol.iterator] === 'function') {
      const arr: number[] = [];
      for (const x of value as Iterable<number>) arr.push(x);
      const out = new Buffer(arr.length);
      for (let i = 0; i < arr.length; i++) out[i] = arr[i]! & 0xff;
      return out;
    }
    throw new TypeError('First argument must be a string, Buffer, ArrayBuffer, Array, or array-like object');
  }

  private static fromBytes(bytes: Uint8Array): Buffer {
    const out = new Buffer(bytes.length);
    out.set(bytes);
    return out;
  }

  static alloc(size: number, fill?: string | number | Buffer, encoding?: Encoding): Buffer {
    if (typeof size !== 'number' || size < 0 || !Number.isInteger(size)) {
      throw new RangeError(`"size" argument must be a non-negative integer`);
    }
    const buf = new Buffer(size);
    if (fill !== undefined && fill !== 0) {
      buf.fill(fill as never, 0, size, encoding as never);
    }
    return buf;
  }

  static allocUnsafe(size: number): Buffer {
    if (typeof size !== 'number' || size < 0 || !Number.isInteger(size)) {
      throw new RangeError(`"size" argument must be a non-negative integer`);
    }
    return new Buffer(size);
  }

  static allocUnsafeSlow(size: number): Buffer {
    return Buffer.allocUnsafe(size);
  }

  static isBuffer(v: unknown): v is Buffer {
    return v instanceof Buffer;
  }

  static isEncoding(s: unknown): boolean {
    return isEncoding(s);
  }

  static byteLength(input: string | Uint8Array | ArrayBuffer | ArrayBufferView, encoding?: Encoding): number {
    return byteLengthOf(input, encoding);
  }

  static concat(list: ReadonlyArray<Uint8Array>, totalLength?: number): Buffer {
    if (!Array.isArray(list)) throw new TypeError('list must be an array');
    let total = 0;
    if (totalLength === undefined) {
      for (const b of list) total += b.length;
    } else {
      total = totalLength;
    }
    const out = new Buffer(total);
    let off = 0;
    for (const b of list) {
      if (off >= total) break;
      const room = total - off;
      if (b.length <= room) {
        out.set(b, off);
        off += b.length;
      } else {
        out.set(b.subarray(0, room), off);
        off += room;
      }
    }
    return out;
  }

  static compare(a: Uint8Array, b: Uint8Array): -1 | 0 | 1 {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const av = a[i]!, bv = b[i]!;
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    if (a.length < b.length) return -1;
    if (a.length > b.length) return 1;
    return 0;
  }

  override toString(encoding: Encoding = 'utf8', start = 0, end: number = this.length): string {
    const s = Math.max(0, Math.min(start, this.length));
    const e = Math.max(s, Math.min(end, this.length));
    if (!isEncoding(encoding)) throw new TypeError(`Unknown encoding: ${encoding}`);
    return bytesToString(this, encoding, s, e);
  }

  override slice(begin?: number, end?: number): Buffer {
    return this.subarray(begin, end) as Buffer;
  }

  override subarray(begin?: number, end?: number): Buffer {
    const u = super.subarray(begin, end);
    Object.setPrototypeOf(u, Buffer.prototype);
    return u as Buffer;
  }

  equals(other: Uint8Array): boolean {
    if (this.length !== other.length) return false;
    for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
    return true;
  }

  compare(other: Uint8Array): -1 | 0 | 1 {
    return Buffer.compare(this, other);
  }

  copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.length): number {
    const slice = this.subarray(sourceStart, Math.min(sourceEnd, this.length));
    const writeLen = Math.min(slice.length, target.length - targetStart);
    target.set(slice.subarray(0, writeLen), targetStart);
    return writeLen;
  }

  write(string: string, offset = 0, length?: number, encoding: Encoding = 'utf8'): number {
    if (typeof offset === 'string') { encoding = offset as Encoding; offset = 0; }
    const bytes = fromString(string, encoding);
    const writeLen = length ?? bytes.length;
    const actual = Math.min(writeLen, bytes.length, this.length - offset);
    this.set(bytes.subarray(0, actual), offset);
    return actual;
  }

  override fill(value: string | number | Buffer, start: number = 0, end: number = this.length, encoding: Encoding = 'utf8'): this {
    if (typeof value === 'number') {
      super.fill(value & 0xff, start, end);
      return this;
    }
    const bytes = typeof value === 'string' ? fromString(value, encoding) : value as Uint8Array;
    if (bytes.length === 0) return this;
    for (let i = start; i < end; ) {
      const room = end - i;
      const copy = Math.min(room, bytes.length);
      this.set(bytes.subarray(0, copy), i);
      i += copy;
    }
    return this;
  }

  readUInt8(offset = 0): number {
    return this[offset]!;
  }
  readInt8(offset = 0): number {
    const b = this[offset]!;
    return b > 0x7f ? b - 0x100 : b;
  }
  readUInt16LE(offset = 0): number {
    return this[offset]! | (this[offset + 1]! << 8);
  }
  readUInt16BE(offset = 0): number {
    return (this[offset]! << 8) | this[offset + 1]!;
  }
  readUInt32LE(offset = 0): number {
    return (this[offset]! | (this[offset + 1]! << 8) | (this[offset + 2]! << 16) | (this[offset + 3]! << 24)) >>> 0;
  }
  readUInt32BE(offset = 0): number {
    return ((this[offset]! << 24) | (this[offset + 1]! << 16) | (this[offset + 2]! << 8) | this[offset + 3]!) >>> 0;
  }

  writeUInt8(value: number, offset = 0): number {
    this[offset] = value & 0xff;
    return offset + 1;
  }
  writeInt8(value: number, offset = 0): number {
    this[offset] = value & 0xff;
    return offset + 1;
  }
  writeUInt16LE(value: number, offset = 0): number {
    this[offset] = value & 0xff;
    this[offset + 1] = (value >> 8) & 0xff;
    return offset + 2;
  }
  writeUInt16BE(value: number, offset = 0): number {
    this[offset] = (value >> 8) & 0xff;
    this[offset + 1] = value & 0xff;
    return offset + 2;
  }
  writeUInt32LE(value: number, offset = 0): number {
    this[offset] = value & 0xff;
    this[offset + 1] = (value >> 8) & 0xff;
    this[offset + 2] = (value >> 16) & 0xff;
    this[offset + 3] = (value >> 24) & 0xff;
    return offset + 4;
  }
  writeUInt32BE(value: number, offset = 0): number {
    this[offset] = (value >> 24) & 0xff;
    this[offset + 1] = (value >> 16) & 0xff;
    this[offset + 2] = (value >> 8) & 0xff;
    this[offset + 3] = value & 0xff;
    return offset + 4;
  }
}

export const nodeBuffer = {
  Buffer,
  Blob: globalThis.Blob,
  File: (globalThis as { File?: unknown }).File,
  atob: globalThis.atob,
  btoa: globalThis.btoa,
  default: Buffer,
  constants: {
    MAX_LENGTH: 0x7fffffff,
    MAX_STRING_LENGTH: 0x1fffffe8,
  },
  kMaxLength: 0x7fffffff,
  kStringMaxLength: 0x1fffffe8,
  INSPECT_MAX_BYTES: 50,
};
