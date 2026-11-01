export interface Tlv {
  tag: number;
  offset: number;
  start: number;
  end: number;
  next: number;
}

export const readTlv = (bytes: Uint8Array, offset: number): Tlv => {
  const tag = bytes[offset]!;
  let length = bytes[offset + 1]!;
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[start + i]!;
    start += count;
  }
  if (start + length > bytes.length) throw new Error('Invalid DER: length exceeds input');
  return { tag, offset, start, end: start + length, next: start + length };
};

export const children = (bytes: Uint8Array, tlv: Tlv): Tlv[] => {
  const out: Tlv[] = [];
  let offset = tlv.start;
  while (offset < tlv.end) {
    const child = readTlv(bytes, offset);
    out.push(child);
    offset = child.next;
  }
  return out;
};

export const decodeOid = (bytes: Uint8Array, tlv: Tlv): string => {
  const first = bytes[tlv.start]!;
  const parts = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (let i = tlv.start + 1; i < tlv.end; i++) {
    value = value * 128 + (bytes[i]! & 0x7f);
    if ((bytes[i]! & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
};

const lengthBytes = (length: number): number[] => {
  if (length < 0x80) return [length];
  const out: number[] = [];
  while (length > 0) { out.unshift(length & 0xff); length = Math.floor(length / 256); }
  return [0x80 | out.length, ...out];
};

export const tlv = (tag: number, ...content: Uint8Array[]): Uint8Array => {
  const total = content.reduce((sum, part) => sum + part.length, 0);
  const header = [tag, ...lengthBytes(total)];
  const out = new Uint8Array(header.length + total);
  out.set(header, 0);
  let offset = header.length;
  for (const part of content) { out.set(part, offset); offset += part.length; }
  return out;
};

export const sequence = (...content: Uint8Array[]): Uint8Array => tlv(0x30, ...content);
export const octetString = (content: Uint8Array): Uint8Array => tlv(0x04, content);
export const bitString = (content: Uint8Array): Uint8Array => tlv(0x03, new Uint8Array([0]), content);
export const NULL = new Uint8Array([0x05, 0x00]);

export const encodeOid = (oid: string): Uint8Array => {
  const parts = oid.split('.').map(Number);
  const out = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f];
    let rest = Math.floor(part / 128);
    while (rest > 0) { stack.unshift((rest & 0x7f) | 0x80); rest = Math.floor(rest / 128); }
    out.push(...stack);
  }
  return tlv(0x06, new Uint8Array(out));
};

export const bigintFromBytes = (bytes: Uint8Array): bigint => {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
};

export const bytesFromBigint = (value: bigint, length?: number): Uint8Array => {
  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  if (length !== undefined) hex = hex.padStart(length * 2, '0');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const integer = (value: bigint): Uint8Array => {
  let bytes = bytesFromBigint(value);
  if (bytes.length === 0) bytes = new Uint8Array([0]);
  if (bytes[0]! & 0x80) {
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes, 1);
    bytes = padded;
  }
  return tlv(0x02, bytes);
};

export const OID = {
  rsaEncryption: '1.2.840.113549.1.1.1',
  rsaPss: '1.2.840.113549.1.1.10',
  ecPublicKey: '1.2.840.10045.2.1',
  ed25519: '1.3.101.112',
  ed448: '1.3.101.113',
  x25519: '1.3.101.110',
  x448: '1.3.101.111',
  dhKeyAgreement: '1.2.840.113549.1.3.1',
};

export const CURVE_OIDS: Record<string, string> = {
  '1.2.840.10045.3.1.7': 'prime256v1',
  '1.3.132.0.34': 'secp384r1',
  '1.3.132.0.35': 'secp521r1',
  '1.3.132.0.10': 'secp256k1',
};

export const OID_FOR_CURVE: Record<string, string> = Object.fromEntries(Object.entries(CURVE_OIDS).map(([oid, name]) => [name, oid]));

export type AsymmetricKeyType = 'rsa' | 'rsa-pss' | 'ec' | 'ed25519' | 'ed448' | 'x25519' | 'x448' | 'dh';

export interface KeyInfo {
  kind: 'public' | 'private';
  keyType: AsymmetricKeyType;
  namedCurve?: string;
  modulusLength?: number;
  publicExponent?: bigint;
}

const KEY_TYPES: Record<string, AsymmetricKeyType> = {
  [OID.rsaEncryption]: 'rsa',
  [OID.rsaPss]: 'rsa-pss',
  [OID.ecPublicKey]: 'ec',
  [OID.ed25519]: 'ed25519',
  [OID.ed448]: 'ed448',
  [OID.x25519]: 'x25519',
  [OID.x448]: 'x448',
  [OID.dhKeyAgreement]: 'dh',
};

const rsaDetails = (bytes: Uint8Array, rsaKey: Tlv, kind: 'public' | 'private'): Pick<KeyInfo, 'modulusLength' | 'publicExponent'> => {
  const fields = children(bytes, rsaKey);
  const n = kind === 'public' ? fields[0]! : fields[1]!;
  const e = kind === 'public' ? fields[1]! : fields[2]!;
  const modulus = bigintFromBytes(bytes.subarray(n.start, n.end));
  return { modulusLength: modulus.toString(2).length, publicExponent: bigintFromBytes(bytes.subarray(e.start, e.end)) };
};

export const keyInfo = (der: Uint8Array, kind: 'public' | 'private'): KeyInfo => {
  const outer = readTlv(der, 0);
  const parts = children(der, outer);
  const algorithm = kind === 'public' ? parts[0]! : parts[1]!;
  const algParts = children(der, algorithm);
  const oid = decodeOid(der, algParts[0]!);
  const keyType = KEY_TYPES[oid];
  if (!keyType) throw new Error(`Unsupported key algorithm ${oid}`);
  const info: KeyInfo = { kind, keyType };
  const param = algParts[1];
  if (keyType === 'ec' && param && param.tag === 0x06) info.namedCurve = CURVE_OIDS[decodeOid(der, param)] ?? decodeOid(der, param);
  if (keyType === 'rsa' || keyType === 'rsa-pss') {
    const container = kind === 'public' ? parts[1]! : parts[2]!;
    const inner = readTlv(der, kind === 'public' ? container.start + 1 : container.start);
    Object.assign(info, rsaDetails(der, inner, kind));
  }
  return info;
};

export const keyMaterial = (der: Uint8Array, kind: 'public' | 'private'): Uint8Array => {
  const outer = readTlv(der, 0);
  const parts = children(der, outer);
  const container = kind === 'public' ? parts[1]! : parts[2]!;
  return kind === 'public' ? der.slice(container.start + 1, container.end) : der.slice(container.start, container.end);
};

export const pkcs1PublicToSpki = (pkcs1: Uint8Array): Uint8Array =>
  sequence(sequence(encodeOid(OID.rsaEncryption), NULL), bitString(pkcs1));

export const pkcs1PrivateToPkcs8 = (pkcs1: Uint8Array): Uint8Array =>
  sequence(integer(0n), sequence(encodeOid(OID.rsaEncryption), NULL), octetString(pkcs1));

export const sec1ToPkcs8 = (sec1: Uint8Array, namedCurve?: string): Uint8Array => {
  let curve = namedCurve;
  const fields = children(sec1, readTlv(sec1, 0));
  for (const field of fields) {
    if (field.tag === 0xa0) {
      const oid = readTlv(sec1, field.start);
      curve = CURVE_OIDS[decodeOid(sec1, oid)] ?? curve;
    }
  }
  if (!curve) throw new Error('EC private key is missing its named curve');
  return sequence(integer(0n), sequence(encodeOid(OID.ecPublicKey), encodeOid(OID_FOR_CURVE[curve]!)), octetString(sec1));
};

export const ecPrivateScalar = (pkcs8: Uint8Array): Uint8Array => {
  const sec1 = keyMaterial(pkcs8, 'private');
  const fields = children(sec1, readTlv(sec1, 0));
  const scalar = fields[1]!;
  return sec1.slice(scalar.start, scalar.end);
};

export const ecPublicPointFromPkcs8 = (pkcs8: Uint8Array): Uint8Array | undefined => {
  const sec1 = keyMaterial(pkcs8, 'private');
  const fields = children(sec1, readTlv(sec1, 0));
  for (const field of fields) {
    if (field.tag === 0xa1) {
      const bits = readTlv(sec1, field.start);
      return sec1.slice(bits.start + 1, bits.end);
    }
  }
  return undefined;
};

export const ecSpki = (namedCurve: string, point: Uint8Array): Uint8Array =>
  sequence(sequence(encodeOid(OID.ecPublicKey), encodeOid(OID_FOR_CURVE[namedCurve]!)), bitString(point));

export const ecPkcs8 = (namedCurve: string, scalar: Uint8Array, point: Uint8Array): Uint8Array =>
  sequence(
    integer(0n),
    sequence(encodeOid(OID.ecPublicKey), encodeOid(OID_FOR_CURVE[namedCurve]!)),
    octetString(sequence(integer(1n), octetString(scalar), tlv(0xa1, bitString(point)))),
  );

export const okpSpki = (keyType: 'ed25519' | 'x25519' | 'ed448' | 'x448', raw: Uint8Array): Uint8Array =>
  sequence(sequence(encodeOid(OID[keyType])), bitString(raw));

export const rsaPublicFromPrivate = (pkcs8: Uint8Array, keyType: 'rsa' | 'rsa-pss'): Uint8Array => {
  const pkcs1 = keyMaterial(pkcs8, 'private');
  const fields = children(pkcs1, readTlv(pkcs1, 0));
  const n = fields[1]!;
  const e = fields[2]!;
  const publicKey = sequence(pkcs1.slice(n.offset, n.end), pkcs1.slice(e.offset, e.end));
  const algorithm = keyType === 'rsa-pss' ? sequence(encodeOid(OID.rsaPss)) : sequence(encodeOid(OID.rsaEncryption), NULL);
  return sequence(algorithm, bitString(publicKey));
};

export const p1363ToDer = (signature: Uint8Array): Uint8Array => {
  const half = signature.length / 2;
  return sequence(integer(bigintFromBytes(signature.subarray(0, half))), integer(bigintFromBytes(signature.subarray(half))));
};

export const derToP1363 = (signature: Uint8Array, size: number): Uint8Array => {
  const fields = children(signature, readTlv(signature, 0));
  const r = bigintFromBytes(signature.subarray(fields[0]!.start, fields[0]!.end));
  const s = bigintFromBytes(signature.subarray(fields[1]!.start, fields[1]!.end));
  const out = new Uint8Array(size * 2);
  out.set(bytesFromBigint(r, size), 0);
  out.set(bytesFromBigint(s, size), size);
  return out;
};
