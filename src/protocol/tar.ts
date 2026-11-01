export type TarEntryType = 'file' | 'directory' | 'symlink' | 'hardlink';

export interface TarEntry {
  path: string;
  type: TarEntryType;
  data?: Uint8Array;
  mode?: number;
  mtimeMs?: number;
  linkTarget?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const TYPE_FLAGS: Record<TarEntryType, string> = { file: '0', directory: '5', symlink: '2', hardlink: '1' };

const octal = (value: number, length: number): string => Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0') + '\0';

const put = (target: Uint8Array, offset: number, length: number, value: string): void => {
  target.set(encoder.encode(value).subarray(0, length), offset);
};

const header = (name: string, entry: TarEntry, size: number, flag: string, prefix = '', link = ''): Uint8Array => {
  const block = new Uint8Array(512);
  put(block, 0, 100, name);
  put(block, 100, 8, octal(entry.mode ?? (entry.type === 'file' ? 0o644 : 0o755), 8));
  put(block, 108, 8, octal(0, 8));
  put(block, 116, 8, octal(0, 8));
  put(block, 124, 12, octal(size, 12));
  put(block, 136, 12, octal((entry.mtimeMs ?? Date.now()) / 1000, 12));
  block.fill(0x20, 148, 156);
  block[156] = flag.charCodeAt(0);
  put(block, 157, 100, link);
  put(block, 257, 6, 'ustar\0');
  put(block, 263, 2, '00');
  put(block, 345, 155, prefix);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  put(block, 148, 8, octal(checksum, 7) + ' ');
  return block;
};

const padded = (data: Uint8Array): Uint8Array => {
  const size = Math.ceil(data.length / 512) * 512;
  if (size === data.length) return data;
  const out = new Uint8Array(size);
  out.set(data);
  return out;
};

const paxRecord = (key: string, value: string): string => {
  const body = ` ${key}=${value}\n`;
  const bodyLength = encoder.encode(body).length;
  let length = bodyLength + 1;
  while (String(length).length + bodyLength !== length) length = String(length).length + bodyLength;
  return `${length}${body}`;
};

const entryBlocks = (entry: TarEntry): Uint8Array[] => {
  const name = entry.type === 'directory' ? entry.path.replace(/\/?$/, '/') : entry.path;
  const data = entry.type === 'file' ? entry.data ?? new Uint8Array(0) : new Uint8Array(0);
  const flag = TYPE_FLAGS[entry.type];
  const link = entry.linkTarget ?? '';
  const blocks: Uint8Array[] = [];
  const pax: string[] = [];
  let shortName = name;
  let prefix = '';
  if (encoder.encode(name).length > 100) {
    const slash = name.lastIndexOf('/', name.length - 2);
    if (slash > 0 && encoder.encode(name.slice(0, slash)).length <= 155 && encoder.encode(name.slice(slash + 1)).length <= 100) {
      prefix = name.slice(0, slash);
      shortName = name.slice(slash + 1);
    } else {
      pax.push(paxRecord('path', name));
      shortName = name.slice(-100);
    }
  }
  if (encoder.encode(link).length > 100) pax.push(paxRecord('linkpath', link));
  if (pax.length > 0) {
    const body = encoder.encode(pax.join(''));
    blocks.push(header('PaxHeader', { path: 'PaxHeader', type: 'file' }, body.length, 'x'), padded(body));
  }
  blocks.push(header(shortName, entry, data.length, flag, prefix, link.slice(0, 100)));
  if (data.length > 0) blocks.push(padded(data));
  return blocks;
};

export const encodeTar = (entries: Iterable<TarEntry>): Uint8Array => {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) blocks.push(...entryBlocks(entry));
  blocks.push(new Uint8Array(1024));
  let total = 0;
  for (const block of blocks) total += block.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
};

const readString = (block: Uint8Array, offset: number, length: number): string => {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
};

const readOctal = (block: Uint8Array, offset: number, length: number): number => {
  const text = readString(block, offset, length).trim();
  return text ? parseInt(text, 8) : 0;
};

const parsePax = (data: Uint8Array): Record<string, string> => {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(decoder.decode(data.subarray(offset, space)));
    if (!length) break;
    const record = decoder.decode(data.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf('=');
    if (equals !== -1) out[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return out;
};

export const isGzip = (data: Uint8Array): boolean => data.length > 2 && data[0] === 0x1f && data[1] === 0x8b;

export const decodeTar = (tar: Uint8Array): TarEntry[] => {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pending: Record<string, string> = {};
  let longName: string | undefined;
  let longLink: string | undefined;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const size = readOctal(block, 124, 12);
    const flag = String.fromCharCode(block[156] || 0x30);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (flag === 'x') {
      pending = { ...pending, ...parsePax(body) };
      continue;
    }
    if (flag === 'g') continue;
    if (flag === 'L') {
      longName = readString(body, 0, body.length);
      continue;
    }
    if (flag === 'K') {
      longLink = readString(body, 0, body.length);
      continue;
    }
    const prefix = readString(block, 345, 155);
    const name = readString(block, 0, 100);
    const path = pending['path'] ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    const linkTarget = pending['linkpath'] ?? longLink ?? readString(block, 157, 100);
    const mode = readOctal(block, 100, 8);
    const mtimeMs = Number(pending['mtime'] ?? readOctal(block, 136, 12)) * 1000;
    pending = {};
    longName = undefined;
    longLink = undefined;
    if (flag === '5') entries.push({ path: path.replace(/\/+$/, ''), type: 'directory', mode, mtimeMs });
    else if (flag === '2') entries.push({ path, type: 'symlink', linkTarget, mode, mtimeMs });
    else if (flag === '1') entries.push({ path, type: 'hardlink', linkTarget, mode, mtimeMs });
    else if (flag === '0' || flag === '\0' || flag === '7') entries.push({ path, type: 'file', data: body.slice(), mode, mtimeMs });
  }
  return entries;
};
