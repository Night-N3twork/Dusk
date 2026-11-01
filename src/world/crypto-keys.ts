import {
  OID, bigintFromBytes, bytesFromBigint, children, ecPkcs8, ecPrivateScalar,
  ecPublicPointFromPkcs8, ecSpki, encodeOid, integer, keyInfo, keyMaterial, octetString, okpSpki, pkcs1PrivateToPkcs8,
  pkcs1PublicToSpki, readTlv, rsaPublicFromPrivate, sec1ToPkcs8, sequence, type KeyInfo,
} from './crypto-der';
import { encodePoint, getCurve, publicPoint } from './crypto-ec';

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

type KeyKind = 'secret' | 'public' | 'private';

const cryptoError = (message: string, code: string, Ctor: new (message: string) => Error = Error): Error => {
  const error = new Ctor(message);
  (error as Error & { code?: string }).code = code;
  return error;
};

const hostCall = (f: string, extra: Record<string, unknown>): unknown => {
  const reply = ipc.send({ f, ...extra });
  if (reply.error) throw cryptoError(reply.error, 'ERR_CRYPTO_OPERATION_FAILED');
  return reply.value;
};

const asBuffer = (bytes: Uint8Array): Uint8Array => {
  const BufferCtor = (globalThis as Record<string, unknown>)['Buffer'] as { from(b: Uint8Array): Uint8Array } | undefined;
  return BufferCtor ? BufferCtor.from(bytes) : bytes;
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array => {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

const base64url = (bytes: Uint8Array): string => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const toPem = (label: string, der: Uint8Array): string => {
  const body = toBase64(der).match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
};

const parsePem = (text: string): { label: string; der: Uint8Array } | undefined => {
  const match = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!match) return undefined;
  const body = match[2]!.split('\n').filter((line) => !line.includes(':')).join('');
  return { label: match[1]!, der: fromBase64(body) };
};

const bytesOf = (value: unknown, encoding?: string): Uint8Array => {
  if (typeof value === 'string') {
    const BufferCtor = (globalThis as Record<string, unknown>)['Buffer'] as { from(s: string, e?: string): Uint8Array } | undefined;
    return BufferCtor ? BufferCtor.from(value, encoding ?? 'utf8') : new TextEncoder().encode(value);
  }
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw cryptoError('The "key" argument must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey', 'ERR_INVALID_ARG_TYPE', TypeError);
};

const JWK_CURVES: Record<string, string> = { prime256v1: 'P-256', secp384r1: 'P-384', secp521r1: 'P-521', secp256k1: 'secp256k1' };
const CURVES_FROM_JWK: Record<string, string> = Object.fromEntries(Object.entries(JWK_CURVES).map(([k, v]) => [v, k]));
const OKP_FROM_JWK: Record<string, 'ed25519' | 'ed448' | 'x25519' | 'x448'> = { Ed25519: 'ed25519', Ed448: 'ed448', X25519: 'x25519', X448: 'x448' };
const OKP_TO_JWK: Record<string, string> = { ed25519: 'Ed25519', ed448: 'Ed448', x25519: 'X25519', x448: 'X448' };

export class KeyObject {
  readonly type: KeyKind;
  private readonly data: Uint8Array;
  private readonly info: KeyInfo | undefined;

  constructor(type: KeyKind, data: Uint8Array, info?: KeyInfo) {
    this.type = type;
    this.data = data;
    this.info = info;
  }

  get asymmetricKeyType(): string | undefined {
    return this.info?.keyType;
  }

  get asymmetricKeyDetails(): Record<string, unknown> | undefined {
    if (!this.info) return undefined;
    if (this.info.keyType === 'ec') return { namedCurve: this.info.namedCurve };
    if (this.info.keyType === 'rsa' || this.info.keyType === 'rsa-pss') {
      return { modulusLength: this.info.modulusLength, publicExponent: this.info.publicExponent };
    }
    return {};
  }

  get symmetricKeySize(): number | undefined {
    return this.type === 'secret' ? this.data.length : undefined;
  }

  get der(): Uint8Array {
    return this.data;
  }

  get details(): KeyInfo | undefined {
    return this.info;
  }

  equals(other: KeyObject): boolean {
    if (!(other instanceof KeyObject) || other.type !== this.type) return false;
    if (this.type !== 'secret' && this.info?.keyType !== other.info?.keyType) return false;
    const mine = this.type === 'private' ? JSON.stringify(exportJwk(this)) : undefined;
    const theirs = other.type === 'private' ? JSON.stringify(exportJwk(other)) : undefined;
    if (mine !== undefined || theirs !== undefined) return mine === theirs;
    if (other.data.length !== this.data.length) return false;
    let diff = 0;
    for (let i = 0; i < this.data.length; i++) diff |= this.data[i]! ^ other.data[i]!;
    return diff === 0;
  }

  export(options: { format?: string; type?: string; cipher?: string; passphrase?: unknown } = {}): Uint8Array | string | Record<string, unknown> {
    if (this.type === 'secret') {
      if (options.format === 'jwk') return { kty: 'oct', k: base64url(this.data) };
      return asBuffer(this.data.slice());
    }
    if (options.cipher || options.passphrase !== undefined) {
      throw cryptoError('Encrypted private key export is not supported in Dusk', 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
    }
    if (options.format === 'jwk') return exportJwk(this);
    const format = options.format ?? 'pem';
    const kind = options.type ?? (this.type === 'public' ? 'spki' : 'pkcs8');
    let der = this.data;
    let label = this.type === 'public' ? 'PUBLIC KEY' : 'PRIVATE KEY';
    if (kind === 'pkcs1') {
      if (this.info?.keyType !== 'rsa') throw cryptoError('pkcs1 encoding is only available for RSA keys', 'ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS');
      der = keyMaterial(this.data, this.type === 'public' ? 'public' : 'private');
      label = this.type === 'public' ? 'RSA PUBLIC KEY' : 'RSA PRIVATE KEY';
    } else if (kind === 'sec1') {
      if (this.info?.keyType !== 'ec' || this.type !== 'private') throw cryptoError('sec1 encoding is only available for EC private keys', 'ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS');
      der = keyMaterial(this.data, 'private');
      label = 'EC PRIVATE KEY';
    } else if (kind !== 'spki' && kind !== 'pkcs8') {
      throw cryptoError(`Unsupported key encoding type: ${kind}`, 'ERR_INVALID_ARG_VALUE', TypeError);
    }
    return format === 'der' ? asBuffer(der.slice()) : toPem(label, der);
  }

  toCryptoKey(): never {
    throw cryptoError('KeyObject.toCryptoKey is not supported in Dusk', 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
  }

  static from(_key: unknown): never {
    throw cryptoError('KeyObject.from(CryptoKey) is not supported in Dusk', 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
  }
}

const publicObject = (spki: Uint8Array): KeyObject => new KeyObject('public', spki, keyInfo(spki, 'public'));
const privateObject = (pkcs8: Uint8Array): KeyObject => new KeyObject('private', pkcs8, keyInfo(pkcs8, 'private'));

export const okpPrivateRaw = (pkcs8: Uint8Array): Uint8Array => {
  const inner = keyMaterial(pkcs8, 'private');
  const octet = readTlv(inner, 0);
  return inner.slice(octet.start, octet.end);
};

export const publicFromPrivate = (key: KeyObject): KeyObject => {
  const info = key.details!;
  if (info.keyType === 'rsa' || info.keyType === 'rsa-pss') return publicObject(rsaPublicFromPrivate(key.der, info.keyType));
  if (info.keyType === 'ec') {
    const curve = info.namedCurve!;
    const embedded = ecPublicPointFromPkcs8(key.der);
    const point = embedded ?? encodePoint(getCurve(curve), publicPoint(getCurve(curve), bigintFromBytes(ecPrivateScalar(key.der))));
    return publicObject(ecSpki(curve, point));
  }
  if (info.keyType === 'ed25519' || info.keyType === 'x25519' || info.keyType === 'ed448' || info.keyType === 'x448') {
    const raw = hostCall('crypto.okp.publicKey', { keyType: info.keyType, der: key.der }) as Uint8Array | number[];
    return publicObject(okpSpki(info.keyType, raw instanceof Uint8Array ? raw : Uint8Array.from(raw)));
  }
  throw cryptoError(`Cannot derive a public key for ${info.keyType} keys`, 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE');
};

const rsaJwk = (key: KeyObject): Record<string, unknown> => {
  const pkcs1 = keyMaterial(key.der, key.type === 'public' ? 'public' : 'private');
  const fields = children(pkcs1, readTlv(pkcs1, 0)).map((field) => {
    let bytes = pkcs1.slice(field.start, field.end);
    while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.slice(1);
    return base64url(bytes);
  });
  if (key.type === 'public') return { kty: 'RSA', n: fields[0], e: fields[1] };
  return { kty: 'RSA', n: fields[1], e: fields[2], d: fields[3], p: fields[4], q: fields[5], dp: fields[6], dq: fields[7], qi: fields[8] };
};

const exportJwk = (key: KeyObject): Record<string, unknown> => {
  const info = key.details!;
  if (info.keyType === 'rsa') return rsaJwk(key);
  if (info.keyType === 'ec') {
    const curve = getCurve(info.namedCurve!);
    const publicKey = key.type === 'public' ? key : publicFromPrivate(key);
    const point = keyMaterial(publicKey.der, 'public');
    const jwk: Record<string, unknown> = {
      kty: 'EC',
      x: base64url(point.subarray(1, 1 + curve.size)),
      y: base64url(point.subarray(1 + curve.size)),
      crv: JWK_CURVES[curve.name],
    };
    if (key.type === 'private') jwk['d'] = base64url(bytesFromBigint(bigintFromBytes(ecPrivateScalar(key.der)), curve.size));
    return jwk;
  }
  const okp = OKP_TO_JWK[info.keyType];
  if (okp) {
    const publicKey = key.type === 'public' ? key : publicFromPrivate(key);
    const x = base64url(keyMaterial(publicKey.der, 'public'));
    if (key.type === 'private') return { crv: okp, d: base64url(okpPrivateRaw(key.der)), x, kty: 'OKP' };
    return { crv: okp, x, kty: 'OKP' };
  }
  throw cryptoError(`Unsupported JWK key type: ${info.keyType}`, 'ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE');
};

const importJwk = (jwk: Record<string, string>, wantPrivate: boolean): KeyObject => {
  const big = (field: string): bigint => bigintFromBytes(fromBase64(jwk[field] ?? ''));
  if (jwk['kty'] === 'oct') return new KeyObject('secret', fromBase64(jwk['k'] ?? ''));
  const isPrivate = wantPrivate && jwk['d'] !== undefined;
  if (wantPrivate && !isPrivate) throw cryptoError('Invalid JWK private key', 'ERR_CRYPTO_INVALID_JWK', TypeError);
  if (jwk['kty'] === 'RSA') {
    if (!isPrivate) return publicObject(pkcs1PublicToSpki(sequence(integer(big('n')), integer(big('e')))));
    const fields = ['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi'].map((name) => integer(big(name)));
    return privateObject(pkcs1PrivateToPkcs8(sequence(integer(0n), ...fields)));
  }
  if (jwk['kty'] === 'EC') {
    const name = CURVES_FROM_JWK[jwk['crv'] ?? ''];
    if (!name) throw cryptoError(`Unsupported JWK EC curve: ${jwk['crv']}`, 'ERR_CRYPTO_JWK_UNSUPPORTED_CURVE', TypeError);
    const curve = getCurve(name);
    const point = new Uint8Array(1 + 2 * curve.size);
    point[0] = 4;
    point.set(bytesFromBigint(big('x'), curve.size), 1);
    point.set(bytesFromBigint(big('y'), curve.size), 1 + curve.size);
    if (!isPrivate) return publicObject(ecSpki(name, point));
    return privateObject(ecPkcs8(name, bytesFromBigint(big('d'), curve.size), point));
  }
  if (jwk['kty'] === 'OKP') {
    const type = OKP_FROM_JWK[jwk['crv'] ?? ''];
    if (!type) throw cryptoError(`Unsupported JWK OKP curve: ${jwk['crv']}`, 'ERR_CRYPTO_JWK_UNSUPPORTED_CURVE', TypeError);
    if (!isPrivate) return publicObject(okpSpki(type, fromBase64(jwk['x'] ?? '')));
    return privateObject(sequence(integer(0n), sequence(encodeOid(OID[type])), octetString(octetString(fromBase64(jwk['d'] ?? '')))));
  }
  throw cryptoError(`Unsupported JWK key type: ${jwk['kty']}`, 'ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE', TypeError);
};

const fromPemOrDer = (data: Uint8Array | string, options: { format?: string; type?: string; encoding?: string }, wantPrivate: boolean): KeyObject => {
  const text = typeof data === 'string' ? data : options.format === 'der' ? undefined : new TextDecoder().decode(data);
  const pem = text !== undefined ? parsePem(text) : undefined;
  if (pem) {
    switch (pem.label) {
      case 'PUBLIC KEY': return publicObject(pem.der);
      case 'RSA PUBLIC KEY': return publicObject(pkcs1PublicToSpki(pem.der));
      case 'PRIVATE KEY': return privateObject(pem.der);
      case 'RSA PRIVATE KEY': return privateObject(pkcs1PrivateToPkcs8(pem.der));
      case 'EC PRIVATE KEY': return privateObject(sec1ToPkcs8(pem.der));
      case 'ENCRYPTED PRIVATE KEY':
        throw cryptoError('Encrypted private keys are not supported in Dusk', 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
      case 'CERTIFICATE':
        throw cryptoError('Extracting keys from certificates is not supported in Dusk', 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
      default:
        throw cryptoError(`Unsupported PEM label: ${pem.label}`, 'ERR_INVALID_ARG_VALUE', TypeError);
    }
  }
  const der = bytesOf(data, options.encoding);
  if (options.format !== 'der') {
    try {
      const raw = typeof data === 'string' ? data : new TextDecoder().decode(der);
      if (/^[A-Za-z0-9+/=\s]+$/.test(raw.trim()) && raw.trim().length > 0) return fromPemOrDer(fromBase64(raw), { ...options, format: 'der' }, wantPrivate);
    } catch { }
    throw cryptoError('error:1E08010C:DECODER routines::unsupported', 'ERR_OSSL_UNSUPPORTED');
  }
  const type = options.type ?? (wantPrivate ? 'pkcs8' : 'spki');
  if (type === 'spki') return publicObject(der);
  if (type === 'pkcs8') return privateObject(der);
  if (type === 'pkcs1') return wantPrivate ? privateObject(pkcs1PrivateToPkcs8(der)) : publicObject(pkcs1PublicToSpki(der));
  if (type === 'sec1') return privateObject(sec1ToPkcs8(der));
  throw cryptoError(`Unsupported key type: ${type}`, 'ERR_INVALID_ARG_VALUE', TypeError);
};

type KeyInput = KeyObject | string | Uint8Array | ArrayBufferView | { key: unknown; format?: string; type?: string; encoding?: string; passphrase?: unknown };

const isKeyOptions = (value: unknown): value is { key: unknown; format?: string; type?: string; encoding?: string; passphrase?: unknown } =>
  value !== null && typeof value === 'object' && !ArrayBuffer.isView(value) && !(value instanceof KeyObject) && 'key' in (value as object);

export const createPrivateKey = (input: KeyInput): KeyObject => {
  if (input instanceof KeyObject) {
    if (input.type !== 'private') throw cryptoError(`Invalid key object type ${input.type}, expected private.`, 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', TypeError);
    return input;
  }
  if (isKeyOptions(input)) {
    if (input.key instanceof KeyObject) return createPrivateKey(input.key);
    if (input.format === 'jwk') return importJwk(input.key as Record<string, string>, true);
    if (input.passphrase !== undefined) throw cryptoError('Encrypted private keys are not supported in Dusk', 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
    const key = fromPemOrDer(input.key as Uint8Array | string, input, true);
    if (key.type !== 'private') throw cryptoError('error:1E08010C:DECODER routines::unsupported', 'ERR_OSSL_UNSUPPORTED');
    return key;
  }
  const key = fromPemOrDer(input as Uint8Array | string, {}, true);
  if (key.type !== 'private') throw cryptoError('error:1E08010C:DECODER routines::unsupported', 'ERR_OSSL_UNSUPPORTED');
  return key;
};

export const createPublicKey = (input: KeyInput): KeyObject => {
  if (input instanceof KeyObject) {
    if (input.type === 'public') return input;
    if (input.type === 'private') return publicFromPrivate(input);
    throw cryptoError('Invalid key object type secret, expected private or public.', 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', TypeError);
  }
  if (isKeyOptions(input)) {
    if (input.key instanceof KeyObject) return createPublicKey(input.key);
    if (input.format === 'jwk') return importJwk(input.key as Record<string, string>, false);
    const key = fromPemOrDer(input.key as Uint8Array | string, input, false);
    return key.type === 'private' ? publicFromPrivate(key) : key;
  }
  const key = fromPemOrDer(input as Uint8Array | string, {}, false);
  return key.type === 'private' ? publicFromPrivate(key) : key;
};

export const createSecretKey = (key: unknown, encoding?: string): KeyObject => {
  if (key instanceof KeyObject) {
    if (key.type !== 'secret') throw cryptoError(`Invalid key object type ${key.type}, expected secret.`, 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE', TypeError);
    return key;
  }
  return new KeyObject('secret', bytesOf(key, encoding).slice());
};

export const keyPairFromDer = (publicDer: Uint8Array, privateDer: Uint8Array): { publicKey: KeyObject; privateKey: KeyObject } => ({
  publicKey: publicObject(publicDer),
  privateKey: privateObject(privateDer),
});

export const keyOptions = (input: unknown): Record<string, unknown> => (isKeyOptions(input) ? input as unknown as Record<string, unknown> : {});

export const ecKeyPair = (curveName: string): { publicKey: KeyObject; privateKey: KeyObject } => {
  const curve = getCurve(curveName);
  const scalar = new Uint8Array(curve.size + 8);
  let d = 0n;
  while (d === 0n) {
    crypto.getRandomValues(scalar);
    d = bigintFromBytes(scalar) % curve.n;
  }
  const point = encodePoint(curve, publicPoint(curve, d));
  return keyPairFromDer(ecSpki(curve.name, point), ecPkcs8(curve.name, bytesFromBigint(d, curve.size), point));
};

