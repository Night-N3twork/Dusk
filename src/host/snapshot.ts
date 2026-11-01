import type { FSBackend } from './fs-backend';
import { norm } from './vfs';
import { decodeTar, encodeTar, isGzip, type TarEntry } from '../protocol/tar';

export interface SnapshotExportOptions {
  root?: string;
  exclude?: readonly string[];
  gzip?: boolean;
}

export interface SnapshotImportOptions {
  root?: string;
}

const DEFAULT_EXCLUDE = ['/proc', '/dev', '/bin'];

const gzip = async (data: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const gunzip = async (data: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

export const exportSnapshot = async (fs: FSBackend, options: SnapshotExportOptions = {}): Promise<Uint8Array> => {
  const root = norm(options.root ?? '/');
  const exclude = (options.exclude ?? DEFAULT_EXCLUDE).map(norm);
  const entries: TarEntry[] = [];
  const relative = (path: string): string => (root === '/' ? path.slice(1) : path.slice(root.length + 1));
  const walk = async (dir: string): Promise<void> => {
    const names = (await fs.readdir(dir)).sort();
    for (const name of names) {
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
      if (exclude.some((prefix) => path === prefix || path.startsWith(prefix + '/'))) continue;
      const stat = await fs.stat(path);
      if (stat.isDirectory) {
        entries.push({ path: relative(path), type: 'directory', mtimeMs: stat.mtimeMs });
        await walk(path);
      } else {
        entries.push({ path: relative(path), type: 'file', data: await fs.readFileBytes(path), mtimeMs: stat.mtimeMs });
      }
    }
  };
  await walk(root);
  const tar = encodeTar(entries);
  return options.gzip === false ? tar : gzip(tar);
};

const ensureDir = async (fs: FSBackend, path: string): Promise<void> => {
  if (path === '/' || await fs.exists(path)) return;
  await fs.mkdir(path, { recursive: true });
};

export const importSnapshot = async (fs: FSBackend, data: Uint8Array, options: SnapshotImportOptions = {}): Promise<string[]> => {
  const tar = isGzip(data) ? await gunzip(data) : data;
  const root = norm(options.root ?? '/');
  const written: string[] = [];
  const files = new Map<string, Uint8Array>();
  for (const entry of decodeTar(tar)) {
    const target = norm(`${root}/${entry.path}`);
    if (target !== root && !target.startsWith(root === '/' ? '/' : root + '/')) continue;
    if (entry.type === 'directory') {
      await ensureDir(fs, target);
      continue;
    }
    const data = entry.type === 'file' ? entry.data : entry.type === 'hardlink' ? files.get(norm(`${root}/${entry.linkTarget ?? ''}`)) : undefined;
    if (!data) continue;
    await ensureDir(fs, target.slice(0, target.lastIndexOf('/')) || '/');
    await fs.writeFileBytes(target, data);
    files.set(target, data);
    written.push(target);
  }
  return written;
};

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (text: string): Uint8Array => {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

const HASH_KEY = 'dusk-snapshot';

export const snapshotToUrl = (snapshot: Uint8Array, base: string | URL = location.href): string => {
  const url = new URL(String(base));
  url.hash = `${HASH_KEY}=${toBase64Url(snapshot)}`;
  return url.href;
};

export const snapshotFromUrl = (url: string | URL = location.href): Uint8Array | undefined => {
  const hash = new URL(String(url)).hash.slice(1);
  const params = new URLSearchParams(hash);
  const value = params.get(HASH_KEY);
  return value ? fromBase64Url(value) : undefined;
};
