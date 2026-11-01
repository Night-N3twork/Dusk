import type { CommandContext, ExecResult } from '../../../vendor/just-bash/types';
import { latin1FromBytes } from '../../../vendor/just-bash/encoding';

type Ipc = { send: (m: unknown) => { value?: unknown; error?: string } };

export type ZlibFormat = 'gzip' | 'deflate' | 'deflate-raw';

export const stdinBytes = (ctx: CommandContext): Uint8Array => {
  const text = latin1FromBytes(ctx.stdin);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

export const latin1 = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
};

export const bytesResult = (bytes: Uint8Array, stderr = '', exitCode = 0): ExecResult => ({
  stdout: latin1(bytes),
  stderr,
  exitCode,
  stdoutKind: 'bytes',
});

export const textResult = (stdout: string, stderr = '', exitCode = 0): ExecResult => ({ stdout, stderr, exitCode });

export const zlib = (op: 'compress' | 'decompress', format: ZlibFormat, data: Uint8Array): Uint8Array => {
  const ipc = (globalThis as { ipc?: Ipc }).ipc;
  if (!ipc) throw new Error('compression is unavailable without the host bridge');
  const reply = ipc.send({ f: `zlib.${op}`, format, data });
  if (reply.error) throw new Error(reply.error);
  const value = reply.value;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new Error(`zlib ${op} returned no data`);
};

export const resolvePath = (ctx: CommandContext, path: string): string => ctx.fs.resolvePath(ctx.cwd, path);

export const ensureDir = async (ctx: CommandContext, path: string): Promise<void> => {
  if (path === '/' || path === '') return;
  if (await ctx.fs.exists(path)) return;
  await ctx.fs.mkdir(path, { recursive: true });
};

export const parentDir = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';

export const joinPath = (base: string, name: string): string => (base.endsWith('/') ? base + name : `${base}/${name}`);

export const normalizeRelative = (path: string): string | undefined => {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
};

export interface WalkedEntry {
  path: string;
  absolute: string;
  directory: boolean;
  mode: number;
  mtimeMs: number;
}

export const walk = async (ctx: CommandContext, absolute: string, path: string, recursive: boolean, out: WalkedEntry[]): Promise<void> => {
  const stat = await ctx.fs.stat(absolute);
  const mtimeMs = stat.mtime instanceof Date ? stat.mtime.getTime() : Date.now();
  if (!stat.isDirectory) {
    out.push({ path, absolute, directory: false, mode: stat.mode ?? 0o644, mtimeMs });
    return;
  }
  out.push({ path, absolute, directory: true, mode: stat.mode ?? 0o755, mtimeMs });
  if (!recursive) return;
  const names = (await ctx.fs.readdir(absolute)).sort();
  for (const name of names) await walk(ctx, joinPath(absolute, name), path ? joinPath(path, name) : name, true, out);
};

export const errorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^E[A-Z]+: /, '');
};

export const describeMode = (directory: boolean, mode: number): string => {
  const bits = 'rwxrwxrwx';
  let out = directory ? 'd' : '-';
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? bits[i] : '-';
  return out;
};

export const formatDate = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
