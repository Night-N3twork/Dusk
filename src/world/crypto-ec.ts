import { CURVES, CURVE_ALIASES } from './crypto-groups';
import { bigintFromBytes, bytesFromBigint } from './crypto-der';

export interface Curve {
  name: string;
  p: bigint;
  a: bigint;
  b: bigint;
  n: bigint;
  gx: bigint;
  gy: bigint;
  size: number;
}

type Affine = { x: bigint; y: bigint } | null;
type Jacobian = { x: bigint; y: bigint; z: bigint };

const cache = new Map<string, Curve>();

export const curveName = (name: string): string | undefined => {
  const canonical = CURVE_ALIASES[name] ?? name;
  return CURVES[canonical] ? canonical : undefined;
};

export const getCurve = (name: string): Curve => {
  const canonical = curveName(name);
  if (!canonical) {
    const error = new TypeError(`Invalid EC curve name: ${name}`);
    (error as TypeError & { code?: string }).code = 'ERR_CRYPTO_INVALID_CURVE';
    throw error;
  }
  let curve = cache.get(canonical);
  if (!curve) {
    const params = CURVES[canonical]!;
    curve = {
      name: canonical,
      p: BigInt('0x' + params.p),
      a: BigInt('0x' + params.a),
      b: BigInt('0x' + params.b),
      n: BigInt('0x' + params.n),
      gx: BigInt('0x' + params.gx),
      gy: BigInt('0x' + params.gy),
      size: params.size,
    };
    cache.set(canonical, curve);
  }
  return curve;
};

const mod = (value: bigint, m: bigint): bigint => {
  const r = value % m;
  return r < 0n ? r + m : r;
};

const invert = (value: bigint, m: bigint): bigint => {
  let [r0, r1] = [mod(value, m), m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) throw new Error('value is not invertible');
  return mod(s0, m);
};

export const modPow = (base: bigint, exponent: bigint, m: bigint): bigint => {
  let result = 1n;
  let b = mod(base, m);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
};

const double = (c: Curve, P: Jacobian): Jacobian => {
  if (P.z === 0n || P.y === 0n) return { x: 0n, y: 1n, z: 0n };
  const { p, a } = c;
  const yy = (P.y * P.y) % p;
  const s = (4n * P.x * yy) % p;
  const zz = (P.z * P.z) % p;
  const m = mod(3n * P.x * P.x + a * zz * zz, p);
  const x = mod(m * m - 2n * s, p);
  const y = mod(m * (s - x) - 8n * yy * yy, p);
  const z = (2n * P.y * P.z) % p;
  return { x, y, z };
};

const add = (c: Curve, P: Jacobian, Q: Jacobian): Jacobian => {
  if (P.z === 0n) return Q;
  if (Q.z === 0n) return P;
  const { p } = c;
  const pz2 = (P.z * P.z) % p;
  const qz2 = (Q.z * Q.z) % p;
  const u1 = (P.x * qz2) % p;
  const u2 = (Q.x * pz2) % p;
  const s1 = (P.y * qz2 * Q.z) % p;
  const s2 = (Q.y * pz2 * P.z) % p;
  if (u1 === u2) return s1 === s2 ? double(c, P) : { x: 0n, y: 1n, z: 0n };
  const h = mod(u2 - u1, p);
  const r = mod(s2 - s1, p);
  const hh = (h * h) % p;
  const hhh = (hh * h) % p;
  const v = (u1 * hh) % p;
  const x = mod(r * r - hhh - 2n * v, p);
  const y = mod(r * (v - x) - s1 * hhh, p);
  const z = (h * P.z * Q.z) % p;
  return { x, y, z };
};

const toAffine = (c: Curve, P: Jacobian): Affine => {
  if (P.z === 0n) return null;
  const zi = invert(P.z, c.p);
  const zi2 = (zi * zi) % c.p;
  return { x: (P.x * zi2) % c.p, y: (P.y * zi2 * zi) % c.p };
};

export const multiply = (c: Curve, k: bigint, point: Affine = { x: c.gx, y: c.gy }): Affine => {
  if (!point) return null;
  let result: Jacobian = { x: 0n, y: 1n, z: 0n };
  let addend: Jacobian = { x: point.x, y: point.y, z: 1n };
  let scalar = mod(k, c.n);
  while (scalar > 0n) {
    if (scalar & 1n) result = add(c, result, addend);
    addend = double(c, addend);
    scalar >>= 1n;
  }
  return toAffine(c, result);
};

const sumPoints = (c: Curve, P: Affine, Q: Affine): Affine => {
  if (!P) return Q;
  if (!Q) return P;
  return toAffine(c, add(c, { x: P.x, y: P.y, z: 1n }, { x: Q.x, y: Q.y, z: 1n }));
};

export const isOnCurve = (c: Curve, P: Affine): boolean => {
  if (!P) return false;
  return mod(P.y * P.y - (P.x * P.x * P.x + c.a * P.x + c.b), c.p) === 0n;
};

export const encodePoint = (c: Curve, P: Affine, format: 'uncompressed' | 'compressed' | 'hybrid' = 'uncompressed'): Uint8Array => {
  if (!P) return new Uint8Array([0]);
  const x = bytesFromBigint(P.x, c.size);
  if (format === 'compressed') {
    const out = new Uint8Array(1 + c.size);
    out[0] = P.y & 1n ? 0x03 : 0x02;
    out.set(x, 1);
    return out;
  }
  const out = new Uint8Array(1 + 2 * c.size);
  out[0] = format === 'hybrid' ? (P.y & 1n ? 0x07 : 0x06) : 0x04;
  out.set(x, 1);
  out.set(bytesFromBigint(P.y, c.size), 1 + c.size);
  return out;
};

export const decodePoint = (c: Curve, bytes: Uint8Array): Affine => {
  const prefix = bytes[0];
  if ((prefix === 0x04 || prefix === 0x06 || prefix === 0x07) && bytes.length === 1 + 2 * c.size) {
    const P = { x: bigintFromBytes(bytes.subarray(1, 1 + c.size)), y: bigintFromBytes(bytes.subarray(1 + c.size)) };
    if (!isOnCurve(c, P)) throw new Error('Public key is not valid for specified curve');
    return P;
  }
  if ((prefix === 0x02 || prefix === 0x03) && bytes.length === 1 + c.size) {
    const x = bigintFromBytes(bytes.subarray(1));
    const rhs = mod(x * x * x + c.a * x + c.b, c.p);
    let y = modPow(rhs, (c.p + 1n) / 4n, c.p);
    if ((y * y) % c.p !== rhs) throw new Error('Public key is not valid for specified curve');
    if ((y & 1n) !== BigInt(prefix & 1)) y = c.p - y;
    return { x, y };
  }
  throw new Error('Public key is not valid for specified curve');
};

export const randomScalar = (c: Curve): bigint => {
  const bytes = new Uint8Array(c.size + 8);
  while (true) {
    crypto.getRandomValues(bytes);
    const k = mod(bigintFromBytes(bytes), c.n);
    if (k !== 0n) return k;
  }
};

export const publicPoint = (c: Curve, d: bigint): Affine => multiply(c, d);

export const sharedSecret = (c: Curve, d: bigint, publicKey: Uint8Array): Uint8Array => {
  const S = multiply(c, d, decodePoint(c, publicKey));
  if (!S) throw new Error('Invalid ECDH shared secret');
  return bytesFromBigint(S.x, c.size);
};

const hashToInt = (c: Curve, digest: Uint8Array): bigint => {
  let e = bigintFromBytes(digest);
  const excess = digest.length * 8 - c.n.toString(2).length;
  if (excess > 0) e >>= BigInt(excess);
  return e;
};

export const ecdsaSign = (c: Curve, d: bigint, digest: Uint8Array): Uint8Array => {
  const e = hashToInt(c, digest);
  while (true) {
    const k = randomScalar(c);
    const R = multiply(c, k);
    if (!R) continue;
    const r = mod(R.x, c.n);
    if (r === 0n) continue;
    let s = mod(invert(k, c.n) * (e + r * d), c.n);
    if (s === 0n) continue;
    if (s > c.n / 2n) s = c.n - s;
    const out = new Uint8Array(c.size * 2);
    out.set(bytesFromBigint(r, c.size), 0);
    out.set(bytesFromBigint(s, c.size), c.size);
    return out;
  }
};

export const ecdsaVerify = (c: Curve, publicKey: Uint8Array, digest: Uint8Array, signature: Uint8Array): boolean => {
  if (signature.length !== c.size * 2) return false;
  const r = bigintFromBytes(signature.subarray(0, c.size));
  const s = bigintFromBytes(signature.subarray(c.size));
  if (r <= 0n || r >= c.n || s <= 0n || s >= c.n) return false;
  const Q = decodePoint(c, publicKey);
  const w = invert(s, c.n);
  const e = hashToInt(c, digest);
  const X = sumPoints(c, multiply(c, mod(e * w, c.n)), multiply(c, mod(r * w, c.n), Q));
  return X !== null && mod(X.x, c.n) === r;
};
