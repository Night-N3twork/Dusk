declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };
import { codes, errnoError } from './node-errors';
import {
  OID, bigintFromBytes, bitString, bytesFromBigint, derToP1363, ecPrivateScalar, encodeOid, integer, keyMaterial,
  octetString, p1363ToDer, pkcs1PrivateToPkcs8, pkcs1PublicToSpki, sequence,
} from './crypto-der';
import { curveName, decodePoint, ecdsaSign, ecdsaVerify, encodePoint, getCurve, modPow, publicPoint, randomScalar, sharedSecret, type Curve } from './crypto-ec';
import { KeyObject, createPrivateKey, createPublicKey, createSecretKey, ecKeyPair, keyOptions, keyPairFromDer } from './crypto-keys';
import { MODP_GROUPS } from './crypto-groups';

const __call = (f: string, extra: Record<string, unknown> = {}): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) {
    const m = /^([A-Z_]+):/.exec(r.error);
    const code = m && m[1] ? m[1] : 'UNKNOWN';
    // Crypto host errors are usually ERR_CRYPTO_* style; if we recognize one, use the factory.
    const factory = codes[code];
    if (factory) throw factory(r.error);
    const syscall = f.replace(/^crypto\./, '');
    throw errnoError(code, syscall, undefined, r.error);
  }
  return r.value;
};

const toBytes = (data: unknown, encoding: string = 'utf8'): Uint8Array => {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  if (typeof data === 'string') {
    const g = globalThis as Record<string, unknown>;
    const Buffer = g['Buffer'] as undefined | { from(s: string, enc?: string): Uint8Array };
    if (Buffer) return Buffer.from(data, encoding);
    // fallback: utf8 only
    const out: number[] = [];
    for (let i = 0; i < data.length; i++) {
      let c = data.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return Uint8Array.from(out);
  }
  if (ArrayBuffer.isView(data)) return new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw codes.ERR_INVALID_ARG_TYPE!('data', ['string', 'Buffer', 'Uint8Array', 'ArrayBuffer'], data);
};

const bytesToBuffer = (bytes: Uint8Array): Uint8Array => {
  const g = globalThis as Record<string, unknown>;
  const Buffer = g['Buffer'] as undefined | { from(b: Uint8Array): Uint8Array };
  if (Buffer) return Buffer.from(bytes);
  return bytes;
};

// ---- random ----

type IntegerTypedArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array;

const isIntegerTypedArray = (value: unknown): value is IntegerTypedArray =>
  value instanceof Int8Array ||
  value instanceof Uint8Array ||
  value instanceof Uint8ClampedArray ||
  value instanceof Int16Array ||
  value instanceof Uint16Array ||
  value instanceof Int32Array ||
  value instanceof Uint32Array;

export const getRandomValues = <T extends IntegerTypedArray>(buf: T): T => {
  if (!isIntegerTypedArray(buf)) throw new TypeError('crypto.getRandomValues expects an integer typed array');
  if (buf.byteLength > 65_536) {
    const error = new Error('The requested length exceeds 65,536 bytes');
    error.name = 'QuotaExceededError';
    throw error;
  }
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
    return buf;
  }
  const arr = __call('crypto.random', { size: buf.length }) as number[];
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < arr.length; i++) bytes[i] = arr[i] ?? 0;
  return buf;
};

export const randomBytes = (size: number, cb?: (err: Error | null, buf?: Uint8Array) => void): Uint8Array | undefined => {
  if (typeof size !== 'number' || size < 0 || !Number.isInteger(size)) {
    const e = codes.ERR_OUT_OF_RANGE!('size', '>= 0 && integer', size);
    if (cb) { cb(e as Error); return; }
    throw e;
  }
  const buf = new Uint8Array(size);
  getRandomValues(buf);
  const out = bytesToBuffer(buf);
  if (cb) {
    Promise.resolve().then(() => cb(null, out));
    return undefined;
  }
  return out;
};

export const randomFillSync = (buf: Uint8Array, offset = 0, size?: number): Uint8Array => {
  const len = size ?? buf.length - offset;
  const tmp = new Uint8Array(len);
  getRandomValues(tmp);
  buf.set(tmp, offset);
  return buf;
};

export const randomFill = (buf: Uint8Array, ...rest: unknown[]): void => {
  let offset = 0, size = buf.length, cb: Function | undefined;
  if (rest.length === 1) cb = rest[0] as Function;
  else if (rest.length === 2) { offset = rest[0] as number; cb = rest[1] as Function; }
  else if (rest.length === 3) { offset = rest[0] as number; size = rest[1] as number; cb = rest[2] as Function; }
  try {
    randomFillSync(buf, offset, size);
    if (cb) Promise.resolve().then(() => cb!(null, buf));
  } catch (e) {
    if (cb) Promise.resolve().then(() => cb!(e));
  }
};

export const randomInt = (...args: number[]): number => {
  let min = 0, max: number;
  if (args.length === 1) max = args[0]!;
  else { min = args[0]!; max = args[1]!; }
  const range = max - min;
  if (range <= 0) throw codes.ERR_OUT_OF_RANGE!('max', '> min', max);
  const buf = new Uint8Array(6);
  getRandomValues(buf);
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + buf[i]!;
  return min + (n % range);
};

const HEX = '0123456789abcdef';

export const randomUUID = (): string => {
  const b = new Uint8Array(16);
  getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = (i: number): string => HEX[(b[i]! >> 4) & 0xf]! + HEX[b[i]! & 0xf]!;
  return (
    hex(0) + hex(1) + hex(2) + hex(3) + '-' +
    hex(4) + hex(5) + '-' +
    hex(6) + hex(7) + '-' +
    hex(8) + hex(9) + '-' +
    hex(10) + hex(11) + hex(12) + hex(13) + hex(14) + hex(15)
  );
};

// ---- timingSafeEqual ----

export const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) {
    throw codes.ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH!();
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
};

// ---- pure-JS MD5 ----

const md5Bytes = (data: Uint8Array): Uint8Array => {
  const r = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const k: number[] = [];
  for (let i = 0; i < 64; i++) k.push(Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);

  const ml = data.length * 8;
  const withLen = new Uint8Array(((data.length + 9 + 63) >>> 6) << 6);
  withLen.set(data);
  withLen[data.length] = 0x80;
  for (let i = 0; i < 4; i++) withLen[withLen.length - 8 + i] = (ml >>> (i * 8)) & 0xff;

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let off = 0; off < withLen.length; off += 64) {
    const M: number[] = [];
    for (let i = 0; i < 16; i++) M.push((withLen[off + i * 4]! | (withLen[off + i * 4 + 1]! << 8) | (withLen[off + i * 4 + 2]! << 16) | (withLen[off + i * 4 + 3]! << 24)) >>> 0);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F = 0, g = 0;
      if (i < 16) { F = (B & C) | ((~B) & D); g = i; }
      else if (i < 32) { F = (D & B) | ((~D) & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | (~D)); g = (7 * i) % 16; }
      F = (F + A + k[i]! + M[g]!) >>> 0;
      A = D;
      D = C;
      C = B;
      const shift = r[i]!;
      B = (B + (((F << shift) | (F >>> (32 - shift))) >>> 0)) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const write = (n: number, off: number): void => {
    out[off] = n & 0xff;
    out[off + 1] = (n >>> 8) & 0xff;
    out[off + 2] = (n >>> 16) & 0xff;
    out[off + 3] = (n >>> 24) & 0xff;
  };
  write(a0, 0); write(b0, 4); write(c0, 8); write(d0, 12);
  return out;
};

// ---- pure-JS SHA-1 (fallback if host doesn't have it) ----

const rotl32 = (n: number, s: number): number => ((n << s) | (n >>> (32 - s))) >>> 0;

const sha1Bytes = (data: Uint8Array): Uint8Array => {
  const ml = data.length * 8;
  const withLen = new Uint8Array(((data.length + 9 + 63) >>> 6) << 6);
  withLen.set(data);
  withLen[data.length] = 0x80;
  for (let i = 0; i < 4; i++) withLen[withLen.length - 1 - i] = (ml >>> (i * 8)) & 0xff;

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;

  for (let off = 0; off < withLen.length; off += 64) {
    const W: number[] = new Array(80);
    for (let i = 0; i < 16; i++) {
      W[i] = (withLen[off + i * 4]! << 24) | (withLen[off + i * 4 + 1]! << 16) | (withLen[off + i * 4 + 2]! << 8) | withLen[off + i * 4 + 3]!;
      W[i] = W[i]! >>> 0;
    }
    for (let i = 16; i < 80; i++) W[i] = rotl32(W[i - 3]! ^ W[i - 8]! ^ W[i - 14]! ^ W[i - 16]!, 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f = 0, k = 0;
      if (i < 20) { f = (b & c) | ((~b) & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rotl32(a, 5) + f + e + k + W[i]!) >>> 0;
      e = d; d = c; c = rotl32(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const writeBE = (n: number, off: number): void => {
    out[off] = (n >>> 24) & 0xff;
    out[off + 1] = (n >>> 16) & 0xff;
    out[off + 2] = (n >>> 8) & 0xff;
    out[off + 3] = n & 0xff;
  };
  writeBE(h0, 0); writeBE(h1, 4); writeBE(h2, 8); writeBE(h3, 12); writeBE(h4, 16);
  return out;
};

// ---- SubtleCrypto-routed sha256/sha384/sha512 ----

const SUBTLE_ALG: Record<string, string> = {
  'sha-1': 'SHA-1', sha1: 'SHA-1',
  'sha-256': 'SHA-256', sha256: 'SHA-256',
  'sha-384': 'SHA-384', sha384: 'SHA-384',
  'sha-512': 'SHA-512', sha512: 'SHA-512',
};

const hashSync = (alg: string, data: Uint8Array): Uint8Array => {
  const lower = alg.toLowerCase();
  if (lower === 'md5') return md5Bytes(data);
  if (lower === 'sha1' || lower === 'sha-1') return sha1Bytes(data);

  if (SUBTLE_ALG[lower]) {
    // Subtle is async; we go through the host IPC which can use it synchronously via Atomics.
    const result = __call('crypto.digest', { algorithm: SUBTLE_ALG[lower]!.toLowerCase(), data: data }) as number[] | undefined;
    if (result) return Uint8Array.from(result);
  }

  const e = new TypeError(`Invalid digest: ${alg}`);
  (e as Error & { code?: string }).code = 'ERR_CRYPTO_INVALID_DIGEST';
  throw e;
};

// ---- Hash / Hmac classes ----

export class Hash {
  private _alg: string;
  private _chunks: Uint8Array[] = [];
  private _finalized = false;

  constructor(alg: string) {
    this._alg = alg.toLowerCase();
  }

  update(data: unknown, encoding?: string): this {
    if (this._finalized) {
      const e = new Error('Hash already finalized');
      (e as Error & { code?: string }).code = 'ERR_CRYPTO_HASH_FINALIZED';
      throw e;
    }
    this._chunks.push(toBytes(data, encoding));
    return this;
  }

  digest(encoding?: string): Uint8Array | string {
    this._finalized = true;
    let total = 0;
    for (const c of this._chunks) total += c.length;
    const concat = new Uint8Array(total);
    let off = 0;
    for (const c of this._chunks) { concat.set(c, off); off += c.length; }
    const out = hashSync(this._alg, concat);
    if (!encoding) return bytesToBuffer(out);
    return encodeBytes(out, encoding);
  }

  copy(): Hash {
    const h = new Hash(this._alg);
    h._chunks = this._chunks.slice();
    return h;
  }
}

export class Hmac {
  private _alg: string;
  private _key: Uint8Array;
  private _chunks: Uint8Array[] = [];
  private _finalized = false;

  constructor(alg: string, key: unknown) {
    this._alg = alg.toLowerCase();
    this._key = toBytes(key);
  }

  update(data: unknown, encoding?: string): this {
    if (this._finalized) {
      const e = new Error('Hmac already finalized');
      (e as Error & { code?: string }).code = 'ERR_CRYPTO_HMAC_FINALIZED';
      throw e;
    }
    this._chunks.push(toBytes(data, encoding));
    return this;
  }

  digest(encoding?: string): Uint8Array | string {
    this._finalized = true;
    let total = 0;
    for (const c of this._chunks) total += c.length;
    const concat = new Uint8Array(total);
    let off = 0;
    for (const c of this._chunks) { concat.set(c, off); off += c.length; }

    let result: Uint8Array;
    if (this._alg === 'md5' || this._alg === 'sha1' || this._alg === 'sha-1') {
      result = hmacPureJS(this._alg, this._key, concat);
    } else {
      const alg = (SUBTLE_ALG[this._alg] ?? `SHA-256`).toLowerCase();
      const arr = __call('crypto.hmac', { algorithm: alg, key: this._key, data: concat }) as number[] | undefined;
      result = arr ? Uint8Array.from(arr) : hmacPureJS('sha256', this._key, concat);
    }
    if (!encoding) return bytesToBuffer(result);
    return encodeBytes(result, encoding);
  }
}

const hmacBlockSize = (alg: string): number => {
  const a = alg.toLowerCase();
  if (a === 'sha384' || a === 'sha-384' || a === 'sha512' || a === 'sha-512') return 128;
  return 64;
};

const hmacPureJS = (alg: string, key: Uint8Array, data: Uint8Array): Uint8Array => {
  const bs = hmacBlockSize(alg);
  let k = key;
  if (k.length > bs) k = hashSync(alg, k);
  if (k.length < bs) {
    const padded = new Uint8Array(bs);
    padded.set(k);
    k = padded;
  }
  const ipad = new Uint8Array(bs);
  const opad = new Uint8Array(bs);
  for (let i = 0; i < bs; i++) {
    ipad[i] = k[i]! ^ 0x36;
    opad[i] = k[i]! ^ 0x5c;
  }
  const inner = new Uint8Array(bs + data.length);
  inner.set(ipad); inner.set(data, bs);
  const innerHash = hashSync(alg, inner);
  const outer = new Uint8Array(bs + innerHash.length);
  outer.set(opad); outer.set(innerHash, bs);
  return hashSync(alg, outer);
};

const encodeBytes = (bytes: Uint8Array, encoding: string): string => {
  const g = globalThis as Record<string, unknown>;
  const Buffer = g['Buffer'] as undefined | { from(b: Uint8Array): { toString(enc: string): string } };
  if (Buffer) return Buffer.from(bytes).toString(encoding);
  if (encoding === 'hex') {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      s += HEX[(b >> 4) & 0xf]! + HEX[b & 0xf]!;
    }
    return s;
  }
  throw codes.ERR_UNKNOWN_ENCODING!(encoding);
};

export const createHash = (alg: string, _opts?: unknown): Hash => new Hash(alg);
export const createHmac = (alg: string, key: unknown, _opts?: unknown): Hmac => new Hmac(alg, key);

// ---- pbkdf2 (via host SubtleCrypto.deriveBits) ----

export const pbkdf2Sync = (password: unknown, salt: unknown, iterations: number, keylen: number, digest: string): Uint8Array => {
  const p = toBytes(password);
  const s = toBytes(salt);
  const subtleAlg = SUBTLE_ALG[digest.toLowerCase()] ?? 'SHA-256';
  const arr = __call('crypto.pbkdf2', {
    password: p,
    salt: s,
    iterations,
    keylen,
    digest: subtleAlg,
  }) as number[] | undefined;
  if (!arr) {
    throw codes.ERR_CRYPTO_UNSUPPORTED_OPERATION!('pbkdf2');
  }
  return bytesToBuffer(Uint8Array.from(arr));
};

export const pbkdf2 = (
  password: unknown, salt: unknown, iterations: number, keylen: number, digest: string,
  cb: (err: Error | null, derivedKey?: Uint8Array) => void,
): void => {
  Promise.resolve().then(() => {
    try { cb(null, pbkdf2Sync(password, salt, iterations, keylen, digest)); }
    catch (e) { cb(e as Error); }
  });
};

// ---- Cipher / Decipher ----
//
// Routes through host SubtleCrypto for AES-CBC and AES-GCM. AES-CTR also via subtle.
// For GCM, authTag is appended to ciphertext and stripped in decrypt.

const SUBTLE_CIPHER_MAP: Record<string, { name: string; tagLength?: number }> = {
  'aes-128-cbc': { name: 'AES-CBC' },
  'aes-192-cbc': { name: 'AES-CBC' },
  'aes-256-cbc': { name: 'AES-CBC' },
  'aes-128-gcm': { name: 'AES-GCM', tagLength: 16 },
  'aes-192-gcm': { name: 'AES-GCM', tagLength: 16 },
  'aes-256-gcm': { name: 'AES-GCM', tagLength: 16 },
  'aes-128-ctr': { name: 'AES-CTR' },
  'aes-192-ctr': { name: 'AES-CTR' },
  'aes-256-ctr': { name: 'AES-CTR' },
};

export class Cipher {
  private _alg: string;
  private _key: Uint8Array;
  private _iv: Uint8Array;
  private _chunks: Uint8Array[] = [];
  private _authTag: Uint8Array | null = null;
  private _aad: Uint8Array | null = null;
  private _finalized = false;

  constructor(alg: string, key: unknown, iv: unknown) {
    this._alg = alg.toLowerCase();
    this._key = toBytes(key);
    this._iv = toBytes(iv);
  }

  setAAD(buf: unknown): this {
    this._aad = toBytes(buf);
    return this;
  }

  update(data: unknown, _inputEncoding?: string, _outputEncoding?: string): Uint8Array | string {
    if (this._finalized) throw codes.ERR_CRYPTO_INVALID_STATE!('Cipher already finalized');
    this._chunks.push(toBytes(data));
    return new Uint8Array(0);  // We buffer; full encrypt happens in final()
  }

  final(_outputEncoding?: string): Uint8Array | string {
    this._finalized = true;
    let totalLen = 0;
    for (const c of this._chunks) totalLen += c.length;
    const plaintext = new Uint8Array(totalLen);
    let off = 0;
    for (const c of this._chunks) { plaintext.set(c, off); off += c.length; }

    const subtleAlg = SUBTLE_CIPHER_MAP[this._alg];
    if (!subtleAlg) {
      throw codes.ERR_CRYPTO_UNKNOWN_CIPHER!(this._alg);
    }

    const result = __call('crypto.encrypt', {
      algorithm: this._alg,
      key: this._key,
      iv: this._iv,
      plaintext: plaintext,
      ...(this._aad ? { aad: this._aad } : {}),
    }) as { ciphertext: number[]; authTag?: number[] } | undefined;

    if (!result) throw codes.ERR_OPERATION_FAILED!('cipher.final');
    const cipherBytes = Uint8Array.from(result.ciphertext);
    if (result.authTag) this._authTag = Uint8Array.from(result.authTag);
    return bytesToBuffer(cipherBytes);
  }

  getAuthTag(): Uint8Array {
    if (!this._authTag) throw codes.ERR_CRYPTO_INVALID_STATE!('getAuthTag: no auth tag set');
    return bytesToBuffer(this._authTag);
  }
}

export class Decipher {
  private _alg: string;
  private _key: Uint8Array;
  private _iv: Uint8Array;
  private _chunks: Uint8Array[] = [];
  private _authTag: Uint8Array | null = null;
  private _aad: Uint8Array | null = null;
  private _finalized = false;

  constructor(alg: string, key: unknown, iv: unknown) {
    this._alg = alg.toLowerCase();
    this._key = toBytes(key);
    this._iv = toBytes(iv);
  }

  setAuthTag(tag: unknown): this {
    this._authTag = toBytes(tag);
    return this;
  }

  setAAD(buf: unknown): this {
    this._aad = toBytes(buf);
    return this;
  }

  update(data: unknown, _inputEncoding?: string, _outputEncoding?: string): Uint8Array | string {
    if (this._finalized) throw codes.ERR_CRYPTO_INVALID_STATE!('Decipher already finalized');
    this._chunks.push(toBytes(data));
    return new Uint8Array(0);
  }

  final(_outputEncoding?: string): Uint8Array | string {
    this._finalized = true;
    let totalLen = 0;
    for (const c of this._chunks) totalLen += c.length;
    const ciphertext = new Uint8Array(totalLen);
    let off = 0;
    for (const c of this._chunks) { ciphertext.set(c, off); off += c.length; }

    const subtleAlg = SUBTLE_CIPHER_MAP[this._alg];
    if (!subtleAlg) {
      throw codes.ERR_CRYPTO_UNKNOWN_CIPHER!(this._alg);
    }

    const result = __call('crypto.decrypt', {
      algorithm: this._alg,
      key: this._key,
      iv: this._iv,
      ciphertext: ciphertext,
      ...(this._authTag ? { authTag: this._authTag } : {}),
      ...(this._aad ? { aad: this._aad } : {}),
    }) as { plaintext: number[] } | undefined;

    if (!result) throw codes.ERR_OPERATION_FAILED!('decipher.final');
    return bytesToBuffer(Uint8Array.from(result.plaintext));
  }
}

export const createCipheriv = (alg: string, key: unknown, iv: unknown, _opts?: unknown): Cipher => {
  return new Cipher(alg, key, iv);
};

export const createDecipheriv = (alg: string, key: unknown, iv: unknown, _opts?: unknown): Decipher => {
  return new Decipher(alg, key, iv);
};

interface ScryptOptions {
  N?: number; r?: number; p?: number; maxmem?: number;
  cost?: number; blockSize?: number; parallelization?: number;
}

const salsa20x8 = (b: Uint32Array): void => {
  let x0 = b[0]!, x1 = b[1]!, x2 = b[2]!, x3 = b[3]!, x4 = b[4]!, x5 = b[5]!, x6 = b[6]!, x7 = b[7]!;
  let x8 = b[8]!, x9 = b[9]!, x10 = b[10]!, x11 = b[11]!, x12 = b[12]!, x13 = b[13]!, x14 = b[14]!, x15 = b[15]!;
  const R = (a: number, n: number): number => (a << n) | (a >>> (32 - n));
  for (let i = 0; i < 8; i += 2) {
    x4 ^= R(x0 + x12, 7); x8 ^= R(x4 + x0, 9); x12 ^= R(x8 + x4, 13); x0 ^= R(x12 + x8, 18);
    x9 ^= R(x5 + x1, 7); x13 ^= R(x9 + x5, 9); x1 ^= R(x13 + x9, 13); x5 ^= R(x1 + x13, 18);
    x14 ^= R(x10 + x6, 7); x2 ^= R(x14 + x10, 9); x6 ^= R(x2 + x14, 13); x10 ^= R(x6 + x2, 18);
    x3 ^= R(x15 + x11, 7); x7 ^= R(x3 + x15, 9); x11 ^= R(x7 + x3, 13); x15 ^= R(x11 + x7, 18);
    x1 ^= R(x0 + x3, 7); x2 ^= R(x1 + x0, 9); x3 ^= R(x2 + x1, 13); x0 ^= R(x3 + x2, 18);
    x6 ^= R(x5 + x4, 7); x7 ^= R(x6 + x5, 9); x4 ^= R(x7 + x6, 13); x5 ^= R(x4 + x7, 18);
    x11 ^= R(x10 + x9, 7); x8 ^= R(x11 + x10, 9); x9 ^= R(x8 + x11, 13); x10 ^= R(x9 + x8, 18);
    x12 ^= R(x15 + x14, 7); x13 ^= R(x12 + x15, 9); x14 ^= R(x13 + x12, 13); x15 ^= R(x14 + x13, 18);
  }
  b[0] = b[0]! + x0; b[1] = b[1]! + x1; b[2] = b[2]! + x2; b[3] = b[3]! + x3;
  b[4] = b[4]! + x4; b[5] = b[5]! + x5; b[6] = b[6]! + x6; b[7] = b[7]! + x7;
  b[8] = b[8]! + x8; b[9] = b[9]! + x9; b[10] = b[10]! + x10; b[11] = b[11]! + x11;
  b[12] = b[12]! + x12; b[13] = b[13]! + x13; b[14] = b[14]! + x14; b[15] = b[15]! + x15;
};

const blockMix = (b: Uint32Array, y: Uint32Array, x: Uint32Array, r: number): void => {
  x.set(b.subarray((2 * r - 1) * 16, 2 * r * 16));
  for (let i = 0; i < 2 * r; i++) {
    for (let j = 0; j < 16; j++) x[j] = x[j]! ^ b[i * 16 + j]!;
    salsa20x8(x);
    y.set(x, i * 16);
  }
  for (let i = 0; i < r; i++) {
    b.set(y.subarray(2 * i * 16, (2 * i + 1) * 16), i * 16);
    b.set(y.subarray((2 * i + 1) * 16, (2 * i + 2) * 16), (r + i) * 16);
  }
};

const roMix = (block: Uint8Array, n: number, r: number): void => {
  const words = 32 * r;
  const b = new Uint32Array(words);
  for (let i = 0; i < words; i++) {
    const o = i * 4;
    b[i] = block[o]! | (block[o + 1]! << 8) | (block[o + 2]! << 16) | (block[o + 3]! << 24);
  }
  const v = new Uint32Array(words * n);
  const y = new Uint32Array(words);
  const x = new Uint32Array(16);
  for (let i = 0; i < n; i++) {
    v.set(b, i * words);
    blockMix(b, y, x, r);
  }
  for (let i = 0; i < n; i++) {
    const j = b[(2 * r - 1) * 16]! & (n - 1);
    const off = j * words;
    for (let k = 0; k < words; k++) b[k] = b[k]! ^ v[off + k]!;
    blockMix(b, y, x, r);
  }
  for (let i = 0; i < words; i++) {
    const o = i * 4;
    const w = b[i]!;
    block[o] = w & 0xff;
    block[o + 1] = (w >>> 8) & 0xff;
    block[o + 2] = (w >>> 16) & 0xff;
    block[o + 3] = (w >>> 24) & 0xff;
  }
};

const scryptParams = (opts: ScryptOptions | undefined): { n: number; r: number; p: number; maxmem: number } => {
  const pick = (a: number | undefined, b: number | undefined, names: [string, string], fallback: number): number => {
    if (a !== undefined && b !== undefined) throw codes.ERR_INCOMPATIBLE_OPTION_PAIR!(names[0], names[1]);
    return a ?? b ?? fallback;
  };
  const n = pick(opts?.N, opts?.cost, ['N', 'cost'], 16384);
  const r = pick(opts?.r, opts?.blockSize, ['r', 'blockSize'], 8);
  const p = pick(opts?.p, opts?.parallelization, ['p', 'parallelization'], 1);
  const maxmem = opts?.maxmem ?? 32 * 1024 * 1024;
  if (!Number.isInteger(n) || n < 2 || (n & (n - 1)) !== 0) throw codes.ERR_CRYPTO_INVALID_SCRYPT_PARAMS!('N must be a power of 2 greater than 1');
  if (!Number.isInteger(r) || r < 1) throw codes.ERR_CRYPTO_INVALID_SCRYPT_PARAMS!('r must be a positive integer');
  if (!Number.isInteger(p) || p < 1 || p * r > 0x3fffffff) throw codes.ERR_CRYPTO_INVALID_SCRYPT_PARAMS!('p must be a positive integer');
  if (128 * n * r > maxmem) throw codes.ERR_CRYPTO_INVALID_SCRYPT_PARAMS!('memory limit exceeded');
  return { n, r, p, maxmem };
};

export const scryptSync = (password: unknown, salt: unknown, keylen: number, opts?: ScryptOptions): Uint8Array => {
  if (!Number.isInteger(keylen) || keylen < 0) throw codes.ERR_OUT_OF_RANGE!('keylen', '>= 0 && integer', keylen);
  const { n, r, p } = scryptParams(opts);
  const pw = toBytes(password);
  const blocks = toBytes(pbkdf2Sync(pw, salt, 1, p * 128 * r, 'sha256'));
  for (let i = 0; i < p; i++) roMix(blocks.subarray(i * 128 * r, (i + 1) * 128 * r), n, r);
  return pbkdf2Sync(pw, blocks, 1, keylen, 'sha256');
};

export const scrypt = (
  password: unknown, salt: unknown, keylen: number,
  optsOrCb: unknown, maybeCb?: Function,
): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (e: Error | null, key?: Uint8Array) => void;
  if (typeof cb !== 'function') throw codes.ERR_INVALID_CALLBACK!(cb);
  const opts = typeof optsOrCb === 'object' && optsOrCb !== null ? optsOrCb as ScryptOptions : undefined;
  scryptParams(opts);
  Promise.resolve().then(() => {
    let key: Uint8Array;
    try { key = scryptSync(password, salt, keylen, opts); }
    catch (e) { cb(e as Error); return; }
    cb(null, key);
  });
};

const inferHashFromAlgorithm = (algorithm: string): string => {
  const a = algorithm.toLowerCase().replace(/^rsa-/, '');
  if (a.includes('sha512') || a.includes('sha-512')) return 'SHA-512';
  if (a.includes('sha384') || a.includes('sha-384')) return 'SHA-384';
  if (a.includes('sha1') || a.includes('sha-1')) return 'SHA-1';
  if (a.includes('sha256') || a.includes('sha-256')) return 'SHA-256';
  throw codes.ERR_CRYPTO_INVALID_DIGEST!(algorithm);
};

const HASH_LENGTHS: Record<string, number> = { 'SHA-1': 20, 'SHA-256': 32, 'SHA-384': 48, 'SHA-512': 64 };

export const constants = Object.freeze({
  RSA_PKCS1_PADDING: 1,
  RSA_NO_PADDING: 3,
  RSA_PKCS1_OAEP_PADDING: 4,
  RSA_X931_PADDING: 5,
  RSA_PKCS1_PSS_PADDING: 6,
  RSA_PSS_SALTLEN_DIGEST: -1,
  RSA_PSS_SALTLEN_MAX_SIGN: -2,
  RSA_PSS_SALTLEN_AUTO: -2,
  POINT_CONVERSION_COMPRESSED: 2,
  POINT_CONVERSION_UNCOMPRESSED: 4,
  POINT_CONVERSION_HYBRID: 6,
  DH_CHECK_P_NOT_PRIME: 1,
  DH_CHECK_P_NOT_SAFE_PRIME: 2,
  DH_UNABLE_TO_CHECK_GENERATOR: 4,
  DH_NOT_SUITABLE_GENERATOR: 8,
});

interface SignatureOptions { dsaEncoding?: 'der' | 'ieee-p1363'; padding?: number; saltLength?: number }

const outputBytes = (bytes: Uint8Array, encoding?: string): Uint8Array | string => {
  if (encoding && encoding !== 'buffer') return encodeBytes(bytes, encoding);
  return bytesToBuffer(bytes);
};

const hostBytes = (value: unknown): Uint8Array => (value instanceof Uint8Array ? value : Uint8Array.from(value as number[]));

const rsaSubtleDer = (key: KeyObject): Uint8Array => {
  if (key.details?.keyType !== 'rsa-pss') return key.der;
  const material = keyMaterial(key.der, key.type === 'public' ? 'public' : 'private');
  return key.type === 'public' ? pkcs1PublicToSpki(material) : pkcs1PrivateToPkcs8(material);
};

const resolveSaltLength = (key: KeyObject, hash: string, saltLength: number | undefined, signing: boolean): number[] => {
  const hashLength = HASH_LENGTHS[hash] ?? 32;
  const max = Math.ceil((key.details?.modulusLength ?? 2048) / 8) - hashLength - 2;
  if (saltLength === undefined || saltLength === constants.RSA_PSS_SALTLEN_MAX_SIGN) return signing ? [max] : [max, hashLength];
  if (saltLength === constants.RSA_PSS_SALTLEN_DIGEST) return [hashLength];
  return [saltLength];
};

const signWithKey = (algorithm: string | null | undefined, data: Uint8Array, keyInput: unknown): Uint8Array => {
  const options = keyOptions(keyInput) as SignatureOptions;
  const key = createPrivateKey(keyInput as never);
  const info = key.details!;
  if (info.keyType === 'ed25519' || info.keyType === 'ed448') {
    return hostBytes(__call('crypto.sign', { algorithm: info.keyType, key: key.der, data, keyType: info.keyType }));
  }
  const hash = inferHashFromAlgorithm(algorithm ?? 'sha256');
  if (info.keyType === 'ec') {
    const curve = getCurve(info.namedCurve!);
    const p1363 = info.namedCurve === 'secp256k1'
      ? ecdsaSign(curve, bigintFromBytes(ecPrivateScalar(key.der)), hashSync(hash, data))
      : hostBytes(__call('crypto.sign', { algorithm: hash, key: key.der, data, keyType: 'ec', namedCurve: info.namedCurve, hash }));
    return options.dsaEncoding === 'ieee-p1363' ? p1363 : p1363ToDer(p1363);
  }
  if (info.keyType === 'rsa' || info.keyType === 'rsa-pss') {
    const pss = info.keyType === 'rsa-pss' || options.padding === constants.RSA_PKCS1_PSS_PADDING;
    const saltLength = pss ? resolveSaltLength(key, hash, options.saltLength, true)[0] : undefined;
    return hostBytes(__call('crypto.sign', {
      algorithm: hash, key: rsaSubtleDer(key), data, keyType: pss ? 'rsa-pss' : 'rsa', hash,
      ...(saltLength !== undefined ? { saltLength } : {}),
    }));
  }
  throw codes.ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE!(info.keyType, 'rsa, rsa-pss, ec, ed25519 or ed448');
};

const verifyWithKey = (algorithm: string | null | undefined, data: Uint8Array, keyInput: unknown, signature: Uint8Array): boolean => {
  const options = keyOptions(keyInput) as SignatureOptions;
  const key = createPublicKey(keyInput as never);
  const info = key.details!;
  if (info.keyType === 'ed25519' || info.keyType === 'ed448') {
    return __call('crypto.verify', { key: key.der, data, signature, keyType: info.keyType }) === true;
  }
  const hash = inferHashFromAlgorithm(algorithm ?? 'sha256');
  if (info.keyType === 'ec') {
    const curve = getCurve(info.namedCurve!);
    let p1363: Uint8Array;
    try { p1363 = options.dsaEncoding === 'ieee-p1363' ? signature : derToP1363(signature, curve.size); } catch { return false; }
    if (info.namedCurve === 'secp256k1') return ecdsaVerify(curve, keyMaterial(key.der, 'public'), hashSync(hash, data), p1363);
    return __call('crypto.verify', { key: key.der, data, signature: p1363, keyType: 'ec', namedCurve: info.namedCurve, hash }) === true;
  }
  if (info.keyType === 'rsa' || info.keyType === 'rsa-pss') {
    const pss = info.keyType === 'rsa-pss' || options.padding === constants.RSA_PKCS1_PSS_PADDING;
    const candidates = pss ? resolveSaltLength(key, hash, options.saltLength, false) : [undefined];
    return candidates.some((saltLength) => __call('crypto.verify', {
      key: rsaSubtleDer(key), data, signature, keyType: pss ? 'rsa-pss' : 'rsa', hash,
      ...(saltLength !== undefined ? { saltLength } : {}),
    }) === true);
  }
  throw codes.ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE!(info.keyType, 'rsa, rsa-pss, ec, ed25519 or ed448');
};

const concatChunks = (chunks: Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
};

export class Sign {
  private _alg: string;
  private _chunks: Uint8Array[] = [];

  constructor(alg: string) {
    this._alg = alg;
  }

  update(data: unknown, enc?: string): this {
    this._chunks.push(toBytes(data, enc ?? 'utf8'));
    return this;
  }

  sign(key: unknown, outputEncoding?: string): Uint8Array | string {
    return outputBytes(signWithKey(this._alg, concatChunks(this._chunks), key), outputEncoding);
  }
}

export class Verify {
  private _alg: string;
  private _chunks: Uint8Array[] = [];

  constructor(alg: string) {
    this._alg = alg;
  }

  update(data: unknown, enc?: string): this {
    this._chunks.push(toBytes(data, enc ?? 'utf8'));
    return this;
  }

  verify(key: unknown, signature: unknown, sigEncoding?: string): boolean {
    return verifyWithKey(this._alg, concatChunks(this._chunks), key, toBytes(signature, sigEncoding ?? 'utf8'));
  }
}

export const createSign = (alg: string): Sign => new Sign(alg);
export const createVerify = (alg: string): Verify => new Verify(alg);

export const sign = (
  algorithm: string | null | undefined, data: unknown, key: unknown,
  callback?: (error: Error | null, signature?: Uint8Array) => void,
): Uint8Array | undefined => {
  if (!callback) return bytesToBuffer(signWithKey(algorithm, toBytes(data), key));
  Promise.resolve().then(() => {
    let signature: Uint8Array;
    try { signature = bytesToBuffer(signWithKey(algorithm, toBytes(data), key)); } catch (error) { callback(error as Error); return; }
    callback(null, signature);
  });
  return undefined;
};

export const verify = (
  algorithm: string | null | undefined, data: unknown, key: unknown, signature: unknown,
  callback?: (error: Error | null, result?: boolean) => void,
): boolean | undefined => {
  if (!callback) return verifyWithKey(algorithm, toBytes(data), key, toBytes(signature));
  Promise.resolve().then(() => {
    let result: boolean;
    try { result = verifyWithKey(algorithm, toBytes(data), key, toBytes(signature)); } catch (error) { callback(error as Error); return; }
    callback(null, result);
  });
  return undefined;
};

export interface GenerateKeyPairOptions {
  modulusLength?: number;
  publicExponent?: number;
  namedCurve?: string;
  hash?: string;
  hashAlgorithm?: string;
  publicKeyEncoding?: { type?: string; format?: string };
  privateKeyEncoding?: { type?: string; format?: string; cipher?: string; passphrase?: unknown };
}

const SUBTLE_CURVE: Record<string, string> = { prime256v1: 'P-256', secp384r1: 'P-384', secp521r1: 'P-521' };

const toPssKeyPair = (pair: { publicKey: KeyObject; privateKey: KeyObject }): { publicKey: KeyObject; privateKey: KeyObject } => {
  const algorithm = sequence(encodeOid(OID.rsaPss));
  const spki = sequence(algorithm, bitString(keyMaterial(pair.publicKey.der, 'public')));
  const pkcs8 = sequence(integer(0n), algorithm, octetString(keyMaterial(pair.privateKey.der, 'private')));
  return keyPairFromDer(spki, pkcs8);
};

const generateKeyObjects = (type: string, options: GenerateKeyPairOptions): { publicKey: KeyObject; privateKey: KeyObject } => {
  const kind = type.toLowerCase();
  if (kind === 'rsa' || kind === 'rsa-pss') {
    if (!options.modulusLength) throw codes.ERR_INVALID_ARG_VALUE!('options.modulusLength', options.modulusLength);
    const hash = options.hashAlgorithm ?? options.hash;
    const r = __call('crypto.generateKeyPair', {
      type: kind,
      modulusLength: options.modulusLength,
      publicExponent: options.publicExponent ?? 65537,
      hash: hash ? inferHashFromAlgorithm(hash) : 'SHA-256',
    }) as { publicKey: Uint8Array; privateKey: Uint8Array };
    const pair = keyPairFromDer(hostBytes(r.publicKey), hostBytes(r.privateKey));
    return kind === 'rsa-pss' ? toPssKeyPair(pair) : pair;
  }
  if (kind === 'ec') {
    const name = curveName(options.namedCurve ?? '');
    if (!name) throw codes.ERR_INVALID_ARG_VALUE!('options.namedCurve', options.namedCurve);
    if (!SUBTLE_CURVE[name]) return ecKeyPair(name);
    const r = __call('crypto.generateKeyPair', { type: 'ec', namedCurve: SUBTLE_CURVE[name] }) as { publicKey: Uint8Array; privateKey: Uint8Array };
    return keyPairFromDer(hostBytes(r.publicKey), hostBytes(r.privateKey));
  }
  if (kind === 'ed25519' || kind === 'ed448' || kind === 'x25519' || kind === 'x448') {
    const r = __call('crypto.generateKeyPair', { type: kind }) as { publicKey: Uint8Array; privateKey: Uint8Array };
    return keyPairFromDer(hostBytes(r.publicKey), hostBytes(r.privateKey));
  }
  throw codes.ERR_INVALID_ARG_VALUE!('type', type, `must be a supported key type`);
};

export const generateKeyPairSync = (type: string, options: GenerateKeyPairOptions = {}): { publicKey: unknown; privateKey: unknown } => {
  const pair = generateKeyObjects(type, options);
  return {
    publicKey: options.publicKeyEncoding ? pair.publicKey.export(options.publicKeyEncoding) : pair.publicKey,
    privateKey: options.privateKeyEncoding ? pair.privateKey.export(options.privateKeyEncoding) : pair.privateKey,
  };
};

export const generateKeyPair = (
  type: string,
  optsOrCb: GenerateKeyPairOptions | Function,
  maybeCb?: Function,
): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as
    | ((e: Error | null, publicKey?: unknown, privateKey?: unknown) => void)
    | undefined;
  const options = (typeof optsOrCb === 'object' && optsOrCb !== null ? optsOrCb as GenerateKeyPairOptions : {});
  if (!cb) throw codes.ERR_INVALID_CALLBACK!(cb);
  Promise.resolve().then(() => {
    let kp: { publicKey: unknown; privateKey: unknown };
    try { kp = generateKeyPairSync(type, options); } catch (e) { cb(e as Error); return; }
    cb(null, kp.publicKey, kp.privateKey);
  });
};

export const generateKeySync = (type: string, options: { length: number }): KeyObject => {
  const length = options?.length;
  if (type === 'hmac') {
    if (!Number.isInteger(length) || length < 8 || length > 2 ** 31 - 1) throw codes.ERR_OUT_OF_RANGE!('options.length', '>= 8 && <= 2147483647', length);
  } else if (type === 'aes') {
    if (length !== 128 && length !== 192 && length !== 256) throw codes.ERR_INVALID_ARG_VALUE!('options.length', length, 'must be one of: 128, 192, 256');
  } else {
    throw codes.ERR_INVALID_ARG_VALUE!('type', type, "must be a supported key type");
  }
  const bytes = new Uint8Array(Math.floor(length / 8));
  getRandomValues(bytes);
  return createSecretKey(bytes);
};

export const generateKey = (type: string, options: { length: number }, callback: (error: Error | null, key?: KeyObject) => void): void => {
  if (typeof callback !== 'function') throw codes.ERR_INVALID_CALLBACK!(callback);
  Promise.resolve().then(() => {
    let key: KeyObject;
    try { key = generateKeySync(type, options); } catch (error) { callback(error as Error); return; }
    callback(null, key);
  });
};

export const hkdfSync = (digest: string, ikm: unknown, salt: unknown, info: unknown, keylen: number): ArrayBuffer => {
  const keyBytes = ikm instanceof KeyObject ? ikm.der : toBytes(ikm);
  const saltBytes = toBytes(salt);
  const infoBytes = toBytes(info);
  const hashLength = hashSync(digest, new Uint8Array(0)).length;
  if (!Number.isInteger(keylen) || keylen < 0 || keylen > 255 * hashLength) throw codes.ERR_CRYPTO_INVALID_KEYLEN!(keylen);
  if (infoBytes.length > 1024) throw codes.ERR_OUT_OF_RANGE!('info', 'must not contain more than 1024 bytes', infoBytes.length);
  const mac = (key: Uint8Array, data: Uint8Array): Uint8Array => toBytes(new Hmac(digest, key).update(data).digest());
  const prk = mac(saltBytes.length > 0 ? saltBytes : new Uint8Array(hashLength), keyBytes);
  const out = new Uint8Array(keylen);
  let previous: Uint8Array = new Uint8Array(0);
  for (let offset = 0, counter = 1; offset < keylen; counter++) {
    const block = new Uint8Array(previous.length + infoBytes.length + 1);
    block.set(previous, 0);
    block.set(infoBytes, previous.length);
    block[block.length - 1] = counter;
    previous = mac(prk, block);
    out.set(previous.subarray(0, Math.min(previous.length, keylen - offset)), offset);
    offset += previous.length;
  }
  return out.buffer;
};

export const hkdf = (
  digest: string, ikm: unknown, salt: unknown, info: unknown, keylen: number,
  callback: (error: Error | null, derivedKey?: ArrayBuffer) => void,
): void => {
  if (typeof callback !== 'function') throw codes.ERR_INVALID_CALLBACK!(callback);
  Promise.resolve().then(() => {
    let key: ArrayBuffer;
    try { key = hkdfSync(digest, ikm, salt, info, keylen); } catch (error) { callback(error as Error); return; }
    callback(null, key);
  });
};

export const hash = (algorithm: string, data: unknown, outputEncoding: string = 'hex'): Uint8Array | string => {
  if (typeof data !== 'string' && !ArrayBuffer.isView(data)) throw codes.ERR_INVALID_ARG_TYPE!('data', ['string', 'Buffer', 'TypedArray', 'DataView'], data);
  return outputBytes(hashSync(algorithm, toBytes(data)), outputEncoding);
};

const inputBytes = (value: unknown, encoding?: string): Uint8Array => (typeof value === 'string' ? toBytes(value, encoding ?? 'utf8') : toBytes(value));

export class ECDH {
  private readonly curve: Curve;
  private privateScalar: bigint | undefined;
  private publicBytes: Uint8Array | undefined;

  constructor(curve: string) {
    this.curve = getCurve(curve);
  }

  static convertKey(key: unknown, curve: string, inputEncoding?: string, outputEncoding?: string, format: 'uncompressed' | 'compressed' | 'hybrid' = 'uncompressed'): Uint8Array | string {
    const c = getCurve(curve);
    return outputBytes(encodePoint(c, decodePoint(c, inputBytes(key, inputEncoding)), format), outputEncoding);
  }

  generateKeys(encoding?: string, format?: 'uncompressed' | 'compressed' | 'hybrid'): Uint8Array | string {
    this.privateScalar = randomScalar(this.curve);
    this.publicBytes = encodePoint(this.curve, publicPoint(this.curve, this.privateScalar));
    return this.getPublicKey(encoding, format);
  }

  computeSecret(otherPublicKey: unknown, inputEncoding?: string, outputEncoding?: string): Uint8Array | string {
    if (this.privateScalar === undefined) throw codes.ERR_CRYPTO_INVALID_STATE!('computeSecret');
    let secret: Uint8Array;
    try {
      secret = sharedSecret(this.curve, this.privateScalar, inputBytes(otherPublicKey, inputEncoding));
    } catch {
      const error = new Error('Public key is not valid for specified curve');
      (error as Error & { code?: string }).code = 'ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY';
      throw error;
    }
    return outputBytes(secret, outputEncoding);
  }

  getPublicKey(encoding?: string, format: 'uncompressed' | 'compressed' | 'hybrid' = 'uncompressed'): Uint8Array | string {
    if (!this.publicBytes) throw codes.ERR_CRYPTO_INVALID_STATE!('getPublicKey');
    const bytes = format === 'uncompressed' ? this.publicBytes : encodePoint(this.curve, decodePoint(this.curve, this.publicBytes), format);
    return outputBytes(bytes, encoding);
  }

  getPrivateKey(encoding?: string): Uint8Array | string {
    if (this.privateScalar === undefined) throw codes.ERR_CRYPTO_INVALID_STATE!('getPrivateKey');
    return outputBytes(bytesFromBigint(this.privateScalar, this.curve.size), encoding);
  }

  setPrivateKey(key: unknown, encoding?: string): this {
    const d = bigintFromBytes(inputBytes(key, encoding));
    if (d <= 0n || d >= this.curve.n) {
      const error = new Error('Private key is not valid for specified curve.');
      (error as Error & { code?: string }).code = 'ERR_CRYPTO_INVALID_KEYTYPE';
      throw error;
    }
    this.privateScalar = d;
    this.publicBytes = encodePoint(this.curve, publicPoint(this.curve, d));
    return this;
  }

  setPublicKey(key: unknown, encoding?: string): this {
    this.publicBytes = encodePoint(this.curve, decodePoint(this.curve, inputBytes(key, encoding)));
    return this;
  }
}

export const createECDH = (curve: string): ECDH => new ECDH(curve);

const millerRabin = (n: bigint, rounds = 24): boolean => {
  if (n < 2n) return false;
  for (const p of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }
  let d = n - 1n;
  let r = 0;
  while ((d & 1n) === 0n) { d >>= 1n; r++; }
  const bytes = new Uint8Array(Math.ceil(n.toString(2).length / 8) + 8);
  for (let i = 0; i < rounds; i++) {
    getRandomValues(bytes);
    const a = 2n + (bigintFromBytes(bytes) % (n - 3n));
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let composite = true;
    for (let j = 1; j < r; j++) {
      x = (x * x) % n;
      if (x === n - 1n) { composite = false; break; }
    }
    if (composite) return false;
  }
  return true;
};

const randomPrime = (bits: number): bigint => {
  const bytes = new Uint8Array(Math.ceil(bits / 8));
  while (true) {
    getRandomValues(bytes);
    let candidate = bigintFromBytes(bytes) & ((1n << BigInt(bits)) - 1n);
    candidate |= (1n << BigInt(bits - 1)) | 1n;
    if (millerRabin(candidate)) return candidate;
  }
};

export class DiffieHellman {
  private readonly prime: bigint;
  private readonly generator: bigint;
  private privateValue: bigint | undefined;
  private publicValue: bigint | undefined;
  verifyError = 0;

  constructor(prime: Uint8Array, generator: Uint8Array) {
    this.prime = bigintFromBytes(prime);
    this.generator = bigintFromBytes(generator);
    if (this.generator < 2n) this.verifyError = constants.DH_NOT_SUITABLE_GENERATOR;
  }

  private size(): number {
    return Math.ceil(this.prime.toString(2).length / 8);
  }

  generateKeys(encoding?: string): Uint8Array | string {
    if (this.privateValue === undefined) {
      const bytes = new Uint8Array(this.size());
      do {
        getRandomValues(bytes);
        this.privateValue = bigintFromBytes(bytes) % (this.prime - 2n);
      } while (this.privateValue < 2n);
    }
    this.publicValue = modPow(this.generator, this.privateValue, this.prime);
    return this.getPublicKey(encoding);
  }

  computeSecret(otherPublicKey: unknown, inputEncoding?: string, outputEncoding?: string): Uint8Array | string {
    if (this.privateValue === undefined) throw codes.ERR_CRYPTO_INVALID_STATE!('computeSecret');
    const other = bigintFromBytes(inputBytes(otherPublicKey, inputEncoding));
    if (other <= 1n || other >= this.prime - 1n) {
      const error = new Error('Supplied key is too small');
      (error as Error & { code?: string }).code = 'ERR_CRYPTO_INVALID_KEYLEN';
      throw error;
    }
    return outputBytes(bytesFromBigint(modPow(other, this.privateValue, this.prime), this.size()), outputEncoding);
  }

  getPrime(encoding?: string): Uint8Array | string { return outputBytes(bytesFromBigint(this.prime), encoding); }
  getGenerator(encoding?: string): Uint8Array | string { return outputBytes(bytesFromBigint(this.generator), encoding); }

  getPublicKey(encoding?: string): Uint8Array | string {
    if (this.publicValue === undefined) throw codes.ERR_CRYPTO_INVALID_STATE!('getPublicKey');
    return outputBytes(bytesFromBigint(this.publicValue, this.size()), encoding);
  }

  getPrivateKey(encoding?: string): Uint8Array | string {
    if (this.privateValue === undefined) throw codes.ERR_CRYPTO_INVALID_STATE!('getPrivateKey');
    return outputBytes(bytesFromBigint(this.privateValue), encoding);
  }

  setPublicKey(key: unknown, encoding?: string): void { this.publicValue = bigintFromBytes(inputBytes(key, encoding)); }
  setPrivateKey(key: unknown, encoding?: string): void {
    this.privateValue = bigintFromBytes(inputBytes(key, encoding));
    this.publicValue = modPow(this.generator, this.privateValue, this.prime);
  }
}

export const createDiffieHellman = (primeOrLength: unknown, primeEncodingOrGenerator?: unknown, generator?: unknown, generatorEncoding?: string): DiffieHellman => {
  const toGenerator = (value: unknown, encoding?: string): Uint8Array => {
    if (value === undefined) return new Uint8Array([2]);
    if (typeof value === 'number') return bytesFromBigint(BigInt(value));
    return inputBytes(value, encoding);
  };
  if (typeof primeOrLength === 'number') {
    if (!Number.isInteger(primeOrLength) || primeOrLength < 2) throw codes.ERR_OUT_OF_RANGE!('primeLength', '>= 2', primeOrLength);
    return new DiffieHellman(bytesFromBigint(randomPrime(primeOrLength)), toGenerator(primeEncodingOrGenerator));
  }
  if (typeof primeEncodingOrGenerator === 'string' && typeof primeOrLength === 'string') {
    return new DiffieHellman(inputBytes(primeOrLength, primeEncodingOrGenerator), toGenerator(generator, generatorEncoding));
  }
  return new DiffieHellman(inputBytes(primeOrLength), toGenerator(primeEncodingOrGenerator ?? generator, generatorEncoding));
};

export const getDiffieHellman = (groupName: string): DiffieHellman => {
  const prime = MODP_GROUPS[groupName];
  if (!prime) {
    const error = new Error('Unknown DH group');
    (error as Error & { code?: string }).code = 'ERR_CRYPTO_UNKNOWN_DH_GROUP';
    throw error;
  }
  return new DiffieHellman(bytesFromBigint(BigInt('0x' + prime)), new Uint8Array([2]));
};

export const createDiffieHellmanGroup = getDiffieHellman;
export const DiffieHellmanGroup = DiffieHellman;

export const diffieHellman = (options: { privateKey: KeyObject; publicKey: KeyObject }): Uint8Array => {
  const { privateKey, publicKey } = options;
  if (!(privateKey instanceof KeyObject) || privateKey.type !== 'private') throw codes.ERR_INVALID_ARG_TYPE!('options.privateKey', 'KeyObject', privateKey);
  if (!(publicKey instanceof KeyObject) || publicKey.type !== 'public') throw codes.ERR_INVALID_ARG_TYPE!('options.publicKey', 'KeyObject', publicKey);
  const ours = privateKey.details!;
  const theirs = publicKey.details!;
  if (ours.keyType !== theirs.keyType || ours.namedCurve !== theirs.namedCurve) {
    const error = new Error('Incompatible key types for Diffie-Hellman');
    (error as Error & { code?: string }).code = 'ERR_CRYPTO_INCOMPATIBLE_KEY';
    throw error;
  }
  if (ours.keyType === 'ec') {
    const curve = getCurve(ours.namedCurve!);
    return bytesToBuffer(sharedSecret(curve, bigintFromBytes(ecPrivateScalar(privateKey.der)), keyMaterial(publicKey.der, 'public')));
  }
  if (ours.keyType === 'x25519' || ours.keyType === 'x448') {
    return bytesToBuffer(hostBytes(__call('crypto.okp.deriveBits', { keyType: ours.keyType, privateKey: privateKey.der, publicKey: publicKey.der })));
  }
  const error = new Error(`Diffie-Hellman is not supported for ${ours.keyType} keys`);
  (error as Error & { code?: string }).code = 'ERR_CRYPTO_INCOMPATIBLE_KEY';
  throw error;
};

export const getHashes = (): string[] => ['md5', 'sha1', 'sha256', 'sha384', 'sha512'];
export const getCiphers = (): string[] => Object.keys(SUBTLE_CIPHER_MAP);
export const getCurves = (): string[] => ['prime256v1', 'secp256k1', 'secp384r1', 'secp521r1'];

export const webcrypto = (typeof crypto !== 'undefined' ? crypto : undefined);
export const subtle = webcrypto?.subtle;

export { KeyObject, createPrivateKey, createPublicKey, createSecretKey };

export const nodeCrypto = {
  randomBytes,
  randomFill,
  randomFillSync,
  randomInt,
  randomUUID,
  getRandomValues,
  timingSafeEqual,
  Hash,
  Hmac,
  createHash,
  createHmac,
  hash,
  pbkdf2,
  pbkdf2Sync,
  scrypt,
  scryptSync,
  hkdf,
  hkdfSync,
  Cipher,
  Decipher,
  createCipheriv,
  createDecipheriv,
  Sign,
  Verify,
  createSign,
  createVerify,
  sign,
  verify,
  KeyObject,
  createPrivateKey,
  createPublicKey,
  createSecretKey,
  generateKey,
  generateKeySync,
  generateKeyPair,
  generateKeyPairSync,
  ECDH,
  createECDH,
  DiffieHellman,
  DiffieHellmanGroup,
  createDiffieHellman,
  createDiffieHellmanGroup,
  getDiffieHellman,
  diffieHellman,
  getHashes,
  getCiphers,
  getCurves,
  webcrypto,
  subtle,
  constants,
};
