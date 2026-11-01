export interface ZipEntry {
  path: string;
  directory: boolean;
  data?: Uint8Array;
  mtimeMs?: number;
}

export type ZipCodec = (data: Uint8Array) => Uint8Array;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export const crc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const dosDateTime = (ms: number): { time: number; date: number } => {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
};

const fromDosDateTime = (time: number, date: number): number =>
  new Date(((date >> 9) & 0x7f) + 1980, ((date >> 5) & 0x0f) - 1, date & 0x1f, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2).getTime();

export const encodeZip = (entries: Iterable<ZipEntry>, deflateRaw?: ZipCodec): Uint8Array => {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let count = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.directory ? entry.path.replace(/\/?$/, '/') : entry.path);
    const raw = entry.directory ? new Uint8Array(0) : entry.data ?? new Uint8Array(0);
    const crc = crc32(raw);
    let method = 0;
    let body = raw;
    if (deflateRaw && raw.length > 0) {
      const packed = deflateRaw(raw);
      if (packed.length < raw.length) {
        method = 8;
        body = packed;
      }
    }
    const { time, date } = dosDateTime(entry.mtimeMs ?? Date.now());
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const record = new Uint8Array(46 + name.length);
    const cv = new DataView(record.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 0x031e, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, ((entry.directory ? 0o40755 : 0o100644) << 16) | (entry.directory ? 0x10 : 0), true);
    cv.setUint32(42, offset, true);
    record.set(name, 46);

    parts.push(local, body);
    central.push(record);
    offset += local.length + body.length;
    count++;
  }
  let centralSize = 0;
  for (const record of central) centralSize += record.length;
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, count, true);
  ev.setUint16(10, count, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  let total = 0;
  for (const part of all) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

export class ZipFormatError extends Error { }

export const decodeZip = (zip: Uint8Array, inflateRaw: ZipCodec): ZipEntry[] => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new ZipFormatError('End-of-central-directory signature not found');
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  if (cursor === 0xffffffff || count === 0xffff) throw new ZipFormatError('ZIP64 archives are not supported');
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new ZipFormatError('Corrupt central directory');
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const time = view.getUint16(cursor + 12, true);
    const date = view.getUint16(cursor + 14, true);
    const crc = view.getUint32(cursor + 16, true);
    const packedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameBytes = zip.subarray(cursor + 46, cursor + 46 + nameLength);
    const path = flags & 0x0800 ? decoder.decode(nameBytes) : String.fromCharCode(...nameBytes);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x0001) throw new ZipFormatError(`${path}: encrypted entries are not supported`);
    const mtimeMs = fromDosDateTime(time, date);
    if (path.endsWith('/')) {
      entries.push({ path: path.slice(0, -1), directory: true, mtimeMs });
      continue;
    }
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new ZipFormatError(`${path}: corrupt local header`);
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const packed = zip.subarray(dataStart, dataStart + packedSize);
    let data: Uint8Array;
    if (method === 0) data = packed.slice();
    else if (method === 8) data = inflateRaw(packed);
    else throw new ZipFormatError(`${path}: unsupported compression method ${method}`);
    if (data.length !== size || crc32(data) !== crc) throw new ZipFormatError(`${path}: CRC mismatch`);
    entries.push({ path, directory: false, data, mtimeMs });
  }
  return entries;
};
