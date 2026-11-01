import { Readable, Writable } from './node-stream';
import { EventEmitter } from './node-events';
import { errnoError } from './node-errors';

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const call = (f: string, extra: Record<string, unknown> = {}): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) {
    // Error string may be a bare message ("EBADF: ...") or a stack ("Error: EBADF: ...\n at ...").
    const m = /(?:^|Error:\s*)([A-Z]{2,}[A-Z_0-9]*):/.exec(r.error);
    const code = m && m[1] ? m[1] : 'UNKNOWN';
    const syscall = f.replace('fs.', '');
    const path = typeof extra['path'] === 'string' ? extra['path'] as string : undefined;
    throw errnoError(code, syscall, path, r.error);
  }
  return r.value;
};

type Cb = (err: Error | null, result?: unknown) => void;

const defer = (fn: () => void): void => { void Promise.resolve().then(fn); };

const promiseOp = <T>(run: () => T): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    defer(() => {
      try { resolve(run()); }
      catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
    });
  });

const toBuffer = (data: unknown): Uint8Array => {
  const g = globalThis as Record<string, unknown>;
  const Buffer = g['Buffer'] as undefined | { from(s: string | Uint8Array | number[], enc?: string): Uint8Array };
  if (Buffer) {
    if (typeof data === 'string') return Buffer.from(data, 'utf8');
    if (data instanceof Uint8Array) return Buffer.from(data);
    if (Array.isArray(data)) return Buffer.from(data as number[]);
  }
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(0);
};

const bytesToString = (b: Uint8Array, encoding?: string): string => {
  if (!encoding) {
    // Return Buffer-like for callers that didn't ask for an encoding.
    const g = globalThis as Record<string, unknown>;
    const Buffer = g['Buffer'] as undefined | { from(b: Uint8Array): Uint8Array & { toString(enc: string): string } };
    if (Buffer) return Buffer.from(b) as unknown as string;
    return b as unknown as string;
  }
  const g = globalThis as Record<string, unknown>;
  const Buffer = g['Buffer'] as undefined | { from(b: Uint8Array): { toString(enc: string): string } };
  if (Buffer) return Buffer.from(b).toString(encoding);
  // Fallback: utf8 only
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
};

const invalidPath = (): never => {
  const error = new TypeError('The "path" argument must be of type string or an instance of URL');
  (error as Error & { code?: string }).code = 'ERR_INVALID_ARG_TYPE';
  throw error;
};

const normalizePath = (path: unknown): string => {
  if (typeof path === 'string') return path;
  if (!path || typeof path !== 'object') return invalidPath();
  const url = path as { protocol?: unknown; hostname?: unknown; pathname?: unknown };
  if (url.protocol !== 'file:') {
    const error = new TypeError('The URL must be of scheme file:');
    (error as Error & { code?: string }).code = 'ERR_INVALID_URL_SCHEME';
    throw error;
  }
  if (url.hostname !== '') {
    const error = new TypeError('File URL host must be empty or localhost');
    (error as Error & { code?: string }).code = 'ERR_INVALID_FILE_URL_HOST';
    throw error;
  }
  if (typeof url.pathname !== 'string') return invalidPath();
  if (/%2f|%5c/i.test(url.pathname)) {
    const error = new TypeError('File URL path must not include encoded slash characters');
    (error as Error & { code?: string }).code = 'ERR_INVALID_FILE_URL_PATH';
    throw error;
  }
  return decodeURIComponent(url.pathname);
};

// ---- Stats ----

interface RawStat {
  isFile: boolean;
  isDirectory: boolean;
  size?: number;
  mtimeMs?: number;
  atimeMs?: number;
  ctimeMs?: number;
  birthtimeMs?: number;
  mode?: number;
}

class Stats {
  size: number;
  mtimeMs: number;
  atimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  mtimeKnown: boolean;
  mode: number;
  uid = 1000;
  gid = 1000;
  ino = 0;
  dev = 0;
  nlink = 1;
  rdev = 0;
  blksize = 4096;
  blocks = 0;

  private _isFile: boolean;
  private _isDirectory: boolean;

  constructor(raw: RawStat) {
    this._isFile = raw.isFile;
    this._isDirectory = raw.isDirectory;
    this.size = raw.size ?? 0;
    this.mtimeMs = raw.mtimeMs ?? 0;
    this.mtimeKnown = raw.mtimeMs !== undefined;
    this.atimeMs = raw.atimeMs ?? 0;
    this.ctimeMs = raw.ctimeMs ?? 0;
    this.birthtimeMs = raw.birthtimeMs ?? 0;
    this.mode = raw.mode ?? (raw.isDirectory ? 0o40755 : 0o100644);
    this.blocks = Math.ceil(this.size / 512);
  }

  isFile(): boolean { return this._isFile; }
  isDirectory(): boolean { return this._isDirectory; }
  isSymbolicLink(): boolean { return false; }
  isBlockDevice(): boolean { return false; }
  isCharacterDevice(): boolean { return false; }
  isFIFO(): boolean { return false; }
  isSocket(): boolean { return false; }

  get mtime(): Date { return new Date(this.mtimeMs); }
  get atime(): Date { return new Date(this.atimeMs); }
  get ctime(): Date { return new Date(this.ctimeMs); }
  get birthtime(): Date { return new Date(this.birthtimeMs); }
}

const wrapStat = (raw: RawStat): Stats => new Stats(raw);

// ---- fd ops (forward to host fd table) ----
//
// The host owns the per-pid fd table (see host/process-manager.ts fs.open/read/
// write/close/fstat/ftruncate/fsync funcs). Engine just forwards.

const _openSync = (path: string, flags: string | number, mode?: number): number => {
  return call('fs.open', { path: normalizePath(path), flags, mode }) as number;
};

const _closeSync = (fd: number): void => {
  call('fs.close', { fd });
};

const asBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return new Uint8Array(0);
};

const _readSync = (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number => {
  const res = call('fs.read', { fd, length, position }) as { bytes: Uint8Array | number[]; bytesRead: number };
  buffer.set(asBytes(res.bytes).subarray(0, res.bytesRead), offset);
  return res.bytesRead;
};

const encodeString = (text: string, encoding?: string | null): Uint8Array => {
  const g = globalThis as Record<string, unknown>;
  const Buffer = g['Buffer'] as undefined | { from(s: string, enc?: string): Uint8Array };
  if (Buffer) return Buffer.from(text, encoding ?? 'utf8');
  return new TextEncoder().encode(text);
};

const viewBytes = (data: ArrayBufferView): Uint8Array =>
  data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

const _writeSync = (fd: number, buffer: ArrayBufferView | string, offsetOrPosition?: number | null | Record<string, unknown>, lengthOrEncoding?: number | string | null, position?: number | null): number => {
  let bytes: Uint8Array;
  let at: number | null = null;
  if (typeof buffer === 'string') {
    bytes = encodeString(buffer, typeof lengthOrEncoding === 'string' ? lengthOrEncoding : undefined);
    at = typeof offsetOrPosition === 'number' ? offsetOrPosition : null;
  } else {
    const view = viewBytes(buffer);
    const options = offsetOrPosition !== null && typeof offsetOrPosition === 'object' ? offsetOrPosition : undefined;
    const off = options ? Number(options['offset'] ?? 0) : (offsetOrPosition ?? 0) as number;
    const len = options ? Number(options['length'] ?? view.length - off) : (typeof lengthOrEncoding === 'number' ? lengthOrEncoding : view.length - off);
    bytes = view.subarray(off, off + len);
    at = options ? (options['position'] as number | null | undefined) ?? null : position ?? null;
  }
  return call('fs.write', { fd, data: bytes, position: at }) as number;
};

const _fsyncSync = (fd: number): void => {
  call('fs.fsync', { fd });
};

const _ftruncateSync = (fd: number, len = 0): void => {
  call('fs.ftruncate', { fd, length: len });
};

const _fstatSync = (fd: number): Stats => {
  return wrapStat(call('fs.fstat', { fd }) as RawStat);
};

// ---- sync API ----

const READ_CHUNK = 1024 * 1024;

const readFileBytes = (path: string): Uint8Array => {
  const reply = call('fs.readFileBytes', { path, maxBytes: READ_CHUNK * 3 }) as Uint8Array | number[] | { tooLarge: true; size: number };
  if (reply instanceof Uint8Array || Array.isArray(reply)) return asBytes(reply);
  if (!reply || typeof reply !== 'object' || typeof reply.size !== 'number') throw errnoError('ENOSYS', 'read', path);
  const fd = _openSync(path, 'r');
  try {
    const out = new Uint8Array(reply.size);
    let offset = 0;
    while (offset < out.length) {
      const read = _readSync(fd, out, offset, Math.min(READ_CHUNK, out.length - offset), offset);
      if (read <= 0) break;
      offset += read;
    }
    return offset === out.length ? out : out.subarray(0, offset);
  } finally {
    _closeSync(fd);
  }
};

type FileOptions = { encoding?: string | null; flag?: string | number; mode?: number } | string | null | undefined;

const encodingOf = (opts: FileOptions): string | null | undefined => (typeof opts === 'string' ? opts : opts?.encoding);
const flagOf = (opts: FileOptions, fallback: string): string | number => (typeof opts === 'object' && opts !== null && opts.flag !== undefined ? opts.flag : fallback);

const dataBytes = (data: unknown, encoding?: string | null): Uint8Array => {
  if (typeof data === 'string') return encodeString(data, encoding);
  if (ArrayBuffer.isView(data)) return viewBytes(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  const error = new TypeError('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView');
  (error as Error & { code?: string }).code = 'ERR_INVALID_ARG_TYPE';
  throw error;
};

const readFileSync = (path: unknown, opts?: FileOptions): unknown => {
  if (typeof path === 'number') {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const chunk = new Uint8Array(READ_CHUNK);
      const read = _readSync(path, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      chunks.push(chunk.subarray(0, read));
      total += read;
    }
    const joined = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }
    const enc = encodingOf(opts);
    return enc ? bytesToString(joined, enc) : toBuffer(joined);
  }
  const bytes = readFileBytes(normalizePath(path));
  const encoding = encodingOf(opts);
  return encoding ? bytesToString(bytes, encoding) : toBuffer(bytes);
};

const writeBytesWithFlag = (filePath: string, bytes: Uint8Array, flag: string | number): void => {
  if (flag === 'w') {
    call('fs.writeFileBytes', { path: filePath, data: bytes });
    return;
  }
  const fd = _openSync(filePath, flag);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = _writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) break;
      offset += written;
    }
  } finally {
    _closeSync(fd);
  }
};

const writeFileSync = (path: unknown, data: unknown, opts?: FileOptions): void => {
  const bytes = dataBytes(data, encodingOf(opts));
  if (typeof path === 'number') {
    _writeSync(path, bytes, 0, bytes.length, null);
    return;
  }
  writeBytesWithFlag(normalizePath(path), bytes, flagOf(opts, 'w'));
};

const appendFileSync = (path: unknown, data: unknown, opts?: FileOptions): void => {
  const bytes = dataBytes(data, encodingOf(opts));
  if (typeof path === 'number') {
    _writeSync(path, bytes, 0, bytes.length, null);
    return;
  }
  writeBytesWithFlag(normalizePath(path), bytes, flagOf(opts, 'a'));
};

const joinPath = (base: string, name: string): string => (base === '/' ? '/' + name : base + '/' + name);

class Dirent {
  readonly name: string;
  readonly parentPath: string;
  private readonly stat: Stats;

  constructor(name: string, parentPath: string, stat: Stats) {
    this.name = name;
    this.parentPath = parentPath;
    this.stat = stat;
  }

  get path(): string { return this.parentPath; }
  isFile(): boolean { return this.stat.isFile(); }
  isDirectory(): boolean { return this.stat.isDirectory(); }
  isSymbolicLink(): boolean { return this.stat.isSymbolicLink(); }
  isBlockDevice(): boolean { return false; }
  isCharacterDevice(): boolean { return false; }
  isFIFO(): boolean { return false; }
  isSocket(): boolean { return false; }
}

const direntFor = (base: string, name: string): Dirent => new Dirent(name, base, lstatSync(joinPath(base, name)));

const readdirSync = (path: string, opts?: { withFileTypes?: boolean; recursive?: boolean; encoding?: string } | string): string[] | Dirent[] => {
  const options = typeof opts === 'string' ? { encoding: opts } : (opts ?? {});
  const base = normalizePath(path);
  if (options.recursive) {
    const names: string[] = [];
    const dirents: Dirent[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const name of call('fs.readdir', { path: dir }) as string[]) {
        const full = joinPath(dir, name);
        const entry = direntFor(dir, name);
        names.push(prefix + name);
        dirents.push(entry);
        if (entry.isDirectory()) walk(full, prefix + name + '/');
      }
    };
    walk(base, '');
    return options.withFileTypes ? dirents : names;
  }
  const names = call('fs.readdir', { path: base }) as string[];
  if (!options.withFileTypes) return names;
  return names.map((name) => direntFor(base, name));
};

const mkdirSync = (path: string, opts?: { recursive?: boolean } | number): void => {
  const recursive = typeof opts === 'object' && opts ? opts.recursive : false;
  call('fs.mkdir', { path: normalizePath(path), recursive: Boolean(recursive) });
};

const rmSync = (path: string, opts?: { recursive?: boolean; force?: boolean }): void => {
  try { call('fs.rm', { path: normalizePath(path), recursive: Boolean(opts?.recursive) }); }
  catch (e) { if (!opts?.force) throw e; }
};

const rmdirSync = (path: string, opts?: { recursive?: boolean }): void => {
  call('fs.rm', { path: normalizePath(path), recursive: Boolean(opts?.recursive) });
};

const unlinkSync = (path: string): void => {
  call('fs.rm', { path: normalizePath(path), recursive: false });
};

const existsSync = (path: string): boolean => {
  const filePath = normalizePath(path);
  try { return call('fs.exists', { path: filePath }) === true; } catch { return false; }
};

const statSync = (path: string, _opts?: unknown): Stats => {
  return wrapStat(call('fs.stat', { path: normalizePath(path) }) as RawStat);
};

const lstatSync = (path: string): Stats => {
  try {
    return wrapStat(call('fs.lstat', { path: normalizePath(path) }) as RawStat);
  } catch {
    return wrapStat(call('fs.stat', { path: normalizePath(path) }) as RawStat);
  }
};

const symlinkSync = (target: string, path: string, _type?: string): void => {
  call('fs.symlink', { target: normalizePath(target), path: normalizePath(path) });
};

const readlinkSync = (path: string, _opts?: unknown): string => {
  return call('fs.readlink', { path: normalizePath(path) }) as string;
};

const renameSync = (from: string, to: string): void => {
  call('fs.rename', { from: normalizePath(from), to: normalizePath(to) });
};

const copyFileSync = (src: string, dest: string, mode = 0): void => {
  const target = normalizePath(dest);
  if ((mode & 1) !== 0 && call('fs.exists', { path: target }) === true) throw errnoError('EEXIST', 'copyfile', target);
  call('fs.writeFileBytes', { path: target, data: readFileBytes(normalizePath(src)) });
};

const accessSync = (path: string, _mode?: number): void => {
  const filePath = normalizePath(path);
  if (call('fs.exists', { path: filePath }) !== true) {
    throw errnoError('ENOENT', 'access', filePath);
  }
};

const realpathSync = (path: string): string => {
  const filePath = normalizePath(path);
  // No symlinks yet — return path as-is if it exists
  if (call('fs.exists', { path: filePath }) !== true) {
    throw errnoError('ENOENT', 'realpath', filePath);
  }
  return filePath;
};

const truncateSync = (path: string | number, len = 0): void => {
  if (typeof path === 'number') {
    _ftruncateSync(path, len);
    return;
  }
  const filePath = normalizePath(path);
  const bytes = readFileBytes(filePath);
  if (len === bytes.length) return;
  const resized = new Uint8Array(len);
  resized.set(len < bytes.length ? bytes.subarray(0, len) : bytes);
  call('fs.writeFileBytes', { path: filePath, data: resized });
};

const chmodSync = (path: string, _mode: number): void => { normalizePath(path); };
const fchmodSync = (_fd: number, _mode: number): void => { /* no-op */ };
const lchmodSync = chmodSync;
const chownSync = (path: string, _uid: number, _gid: number): void => { normalizePath(path); };
const fchownSync = (_fd: number, _uid: number, _gid: number): void => { /* no-op */ };
const lchownSync = chownSync;
const utimesSync = (path: string, _atime: Date | number, _mtime: Date | number): void => { normalizePath(path); };
const lutimesSync = utimesSync;
const futimesSync = (_fd: number, _atime: Date | number, _mtime: Date | number): void => { /* no-op */ };

// ---- async wrappers ----

const wrapSync = <T extends unknown[], R>(fn: (...args: T) => R) =>
  (...args: [...T, Cb?]): void => {
    const cb = (args[args.length - 1] as unknown) as Cb | undefined;
    if (typeof cb === 'function') {
      const realArgs = args.slice(0, -1) as unknown as T;
      defer(() => {
        try { cb(null, fn(...realArgs)); }
        catch (e) { cb(e instanceof Error ? e : new Error(String(e))); }
      });
    } else {
      // Called without callback: silent fire-and-forget
      defer(() => { try { fn(...(args as unknown as T)); } catch { /* */ } });
    }
  };

const readFile = (path: string, optsOrCb?: FileOptions | Cb, maybeCb?: Cb): void => {
  let cb: Cb | undefined;
  let opts: FileOptions;
  if (typeof optsOrCb === 'function') cb = optsOrCb;
  else { opts = optsOrCb; cb = maybeCb; }
  defer(() => {
    try { cb?.(null, readFileSync(path, opts)); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const writeFile = (path: string, data: unknown, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  const opts = typeof optsOrCb === 'function' ? undefined : optsOrCb as FileOptions;
  defer(() => {
    try { writeFileSync(path, data, opts); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const appendFile = (path: string, data: unknown, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  const opts = typeof optsOrCb === 'function' ? undefined : optsOrCb as FileOptions;
  defer(() => {
    try { appendFileSync(path, data, opts); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const readdir = (path: string, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  const opts = typeof optsOrCb === 'object' && optsOrCb ? optsOrCb as { withFileTypes?: boolean } : undefined;
  defer(() => {
    try { cb?.(null, readdirSync(path, opts as { withFileTypes?: boolean })); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const mkdir = (path: string, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const opts = typeof optsOrCb === 'function' ? undefined : optsOrCb as { recursive?: boolean };
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { mkdirSync(path, opts); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const rm = (path: string, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const opts = typeof optsOrCb === 'function' ? undefined : optsOrCb as { recursive?: boolean; force?: boolean };
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { rmSync(path, opts); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const rmdir = (path: string, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const opts = typeof optsOrCb === 'function' ? undefined : optsOrCb as { recursive?: boolean };
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { rmdirSync(path, opts); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const unlink = (path: string, cb?: Cb): void => {
  defer(() => {
    try { unlinkSync(path); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const stat = (path: string, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { cb?.(null, statSync(path)); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const lstat = (path: string, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { cb?.(null, lstatSync(path)); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const symlink = (target: string, path: string, typeOrCb?: string | Cb, maybeCb?: Cb): void => {
  const cb = (typeof typeOrCb === 'function' ? typeOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { symlinkSync(target, path); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const readlink = (path: string, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { cb?.(null, readlinkSync(path)); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const rename = (from: string, to: string, cb?: Cb): void => {
  defer(() => {
    try { renameSync(from, to); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const copyFile = (src: string, dest: string, modeOrCb?: number | Cb, maybeCb?: Cb): void => {
  const cb = (typeof modeOrCb === 'function' ? modeOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { copyFileSync(src, dest, typeof modeOrCb === 'number' ? modeOrCb : 0); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const access = (path: string, modeOrCb?: number | Cb, maybeCb?: Cb): void => {
  const cb = (typeof modeOrCb === 'function' ? modeOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { accessSync(path); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const realpath = (path: string, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { cb?.(null, realpathSync(path)); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const exists = (path: string, cb?: (exists: boolean) => void): void => {
  defer(() => { try { cb?.(existsSync(path)); } catch { cb?.(false); } });
};

const open = (path: string, flagsOrCb?: string | number | Cb, modeOrCb?: number | Cb, maybeCb?: Cb): void => {
  let flags: string | number = 'r';
  let cb: Cb | undefined;
  if (typeof flagsOrCb === 'function') cb = flagsOrCb;
  else if (flagsOrCb !== undefined) flags = flagsOrCb;
  if (typeof modeOrCb === 'function') cb = modeOrCb;
  else if (maybeCb) cb = maybeCb;
  defer(() => {
    try { cb?.(null, _openSync(path, flags)); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const close = (fd: number, cb?: Cb): void => {
  defer(() => {
    try { _closeSync(fd); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const read = (fd: number, bufferOrOpts: Uint8Array | { buffer: Uint8Array; offset?: number; length?: number; position?: number | null }, offsetOrCb?: number | ((err: Error | null, bytesRead: number, buf: Uint8Array) => void), lengthOrPos?: number, positionOrCb?: number | null | ((err: Error | null, bytesRead: number, buf: Uint8Array) => void), maybeCb?: (err: Error | null, bytesRead: number, buf: Uint8Array) => void): void => {
  let buffer: Uint8Array, offset = 0, length: number, position: number | null = null;
  let cb: ((err: Error | null, bytesRead: number, buf: Uint8Array) => void) | undefined;
  if (bufferOrOpts instanceof Uint8Array) {
    buffer = bufferOrOpts;
    offset = (offsetOrCb as number) ?? 0;
    length = lengthOrPos ?? buffer.length - offset;
    position = (positionOrCb as number | null) ?? null;
    cb = maybeCb;
  } else {
    buffer = bufferOrOpts.buffer;
    offset = bufferOrOpts.offset ?? 0;
    length = bufferOrOpts.length ?? buffer.length - offset;
    position = bufferOrOpts.position ?? null;
    cb = offsetOrCb as ((err: Error | null, bytesRead: number, buf: Uint8Array) => void) | undefined;
  }
  defer(() => {
    try { const n = _readSync(fd, buffer, offset, length, position); cb?.(null, n, buffer); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e)), 0, buffer); }
  });
};

const write = (fd: number, bufferOrString: Uint8Array | string, ...rest: unknown[]): void => {
  const cb = rest.find((r) => typeof r === 'function') as ((err: Error | null, written: number) => void) | undefined;
  const offset = typeof rest[0] === 'number' ? rest[0] : 0;
  const length = typeof rest[1] === 'number' ? rest[1] : undefined;
  const position = typeof rest[2] === 'number' ? rest[2] : null;
  defer(() => {
    try {
      const n = _writeSync(fd, bufferOrString, offset as number, length, position);
      cb?.(null, n);
    } catch (e) { cb?.(e instanceof Error ? e : new Error(String(e)), 0); }
  });
};

const fstat = (fd: number, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { cb?.(null, _fstatSync(fd)); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const ftruncate = (fd: number, lenOrCb?: number | Cb, maybeCb?: Cb): void => {
  const len = typeof lenOrCb === 'number' ? lenOrCb : 0;
  const cb = (typeof lenOrCb === 'function' ? lenOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { _ftruncateSync(fd, len); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const fsync = (fd: number, cb?: Cb): void => {
  defer(() => {
    try { _fsyncSync(fd); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const fdatasync = fsync;

const truncate = (path: string, lenOrCb?: number | Cb, maybeCb?: Cb): void => {
  const len = typeof lenOrCb === 'number' ? lenOrCb : 0;
  const cb = (typeof lenOrCb === 'function' ? lenOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { truncateSync(path, len); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const chmod = wrapSync(chmodSync);
const fchmod = wrapSync(fchmodSync);
const lchmod = wrapSync(lchmodSync);
const chown = wrapSync(chownSync);
const fchown = wrapSync(fchownSync);
const lchown = wrapSync(lchownSync);
const utimes = wrapSync(utimesSync);
const lutimes = wrapSync(lutimesSync);
const futimes = wrapSync(futimesSync);

// ---- watch / watchFile / unwatchFile ----

type WatchListener = (event: 'rename' | 'change', filename: string | null) => void;
type HostMutation = { type: 'write' | 'mkdir' | 'rename' | 'rm'; path: string; previousPath?: string };
type DuskLifecycle = { retain(): () => void };

const lifecycle = (): DuskLifecycle | undefined =>
  ((globalThis as Record<string, unknown>)['__process'] as { __duskLifecycle?: DuskLifecycle } | undefined)?.__duskLifecycle;

interface WatchOptions {
  persistent?: boolean;
  recursive?: boolean;
  encoding?: string;
  interval?: number;
  signal?: AbortSignal;
}

class FSWatcher extends EventEmitter {
  private _path: string;
  private _encoding: string | undefined;
  private _interval: number;
  private _recursive: boolean;
  private _closed = false;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _hostSubscription: number | null = null;
  private _releaseLifecycle: (() => void) | null = null;
  private _pendingHostEvents = new Map<string, 'rename' | 'change'>();
  private _hostEventsQueued = false;
  // Snapshot signatures avoid unstable synthetic stat timestamps.
  private _snapshot: Map<string, { signature: string; isDir: boolean; entries?: Set<string> }> = new Map();

  constructor(p: string, opts: WatchOptions = {}) {
    super();
    this._path = normalizePath(p);
    this._encoding = opts.encoding;
    this._interval = opts.interval ?? 1000;
    this._recursive = !!opts.recursive;
    this._buildSnapshot(this._path);
    try {
      const id = call('fs.watch.subscribe') as number;
      if (typeof id === 'number') {
        this._hostSubscription = id;
        hostWatchers.set(id, this);
      }
    } catch { /* Older hosts use the polling fallback. */ }
    if (this._hostSubscription === null) {
      this._timer = setInterval(() => this._poll(), this._interval) as unknown as ReturnType<typeof setInterval>;
    } else {
      // Host subscriptions need no polling, but a persistent FSWatcher still
      // keeps the guest alive until close() or unref().
      this._timer = setInterval(() => {}, 0x7fffffff) as unknown as ReturnType<typeof setInterval>;
    }
    // The watcher, not its polling implementation, owns process retention.
    (this._timer as unknown as { unref?: () => void } | null)?.unref?.();
    if (opts.persistent !== false) this._retainLifecycle();
    if (opts.signal) {
      if (opts.signal.aborted) defer(() => this.close());
      else opts.signal.addEventListener('abort', () => this.close(), { once: true });
    }
  }

  private _buildSnapshot(p: string): void {
    try {
      const st = statSync(p);
      const entry: { signature: string; isDir: boolean; entries?: Set<string> } = {
        signature: this._statSignature(p, st), isDir: st.isDirectory(),
      };
      if (entry.isDir) {
        try {
          entry.entries = new Set(readdirSync(p) as string[]);
          if (this._recursive) {
            for (const child of entry.entries) {
              this._buildSnapshot(p + '/' + child);
            }
          }
        } catch { /* */ }
      }
      this._snapshot.set(p, entry);
    } catch { /* path may not exist yet */ }
  }

  private _statSignature(path: string, st: Stats): string {
    return `${path}\0${st.mtimeKnown ? st.mtimeMs : ''}\0${st.size}\0${st.isDirectory() ? 1 : 0}`;
  }

  private _deleteSnapshotSubtree(path: string): void {
    for (const key of this._snapshot.keys()) {
      if (key === path || key.startsWith(path + '/')) this._snapshot.delete(key);
    }
  }

  private _emit(event: 'rename' | 'change', filename: string | null): void {
    const name = filename !== null && this._encoding === 'buffer' ? toBuffer(filename) : filename;
    this.emit('change', event, name);
    if (event === 'rename') this.emit('rename', event, name);
  }

  private _poll(): void {
    if (this._closed) return;
    // Re-check the root path
    this._diffSubtree(this._path);
  }

  private _diffSubtree(p: string): void {
    let st: Stats | null = null;
    try { st = statSync(p); } catch { /* */ }
    const prev = this._snapshot.get(p);
    if (!st) {
      if (prev) {
        this._deleteSnapshotSubtree(p);
        this._emit('rename', this._relativeName(p));
      }
      return;
    }
    if (!prev) {
      this._buildSnapshot(p);
      this._emit('rename', this._relativeName(p));
      return;
    }
    // Check for changes to this entry
    const signature = this._statSignature(p, st);
    if (prev.signature !== signature) {
      prev.signature = signature;
      this._emit('change', this._relativeName(p));
    }
    // For directories, compare entry sets
    if (st.isDirectory()) {
      let current: Set<string>;
      try { current = new Set(readdirSync(p) as string[]); }
      catch { return; }
      const prevSet = prev.entries ?? new Set<string>();
      // Detect additions/removals
      for (const name of current) {
        if (!prevSet.has(name)) {
          this._emit('rename', name);
          if (this._recursive) {
            this._buildSnapshot(p + '/' + name);
          }
        }
      }
      for (const name of prevSet) {
        if (!current.has(name)) {
          this._emit('rename', name);
          this._deleteSnapshotSubtree(p + '/' + name);
        }
      }
      prev.entries = current;
      if (this._recursive) {
        for (const name of current) {
          this._diffSubtree(p + '/' + name);
        }
      }
    }
  }

  private _relativeName(p: string): string {
    if (p === this._path) return p.split('/').pop() ?? p;
    if (p.startsWith(this._path + '/')) return p.slice(this._path.length + 1);
    return p;
  }

  _onHostMutation(mutation: HostMutation): void {
    if (this._closed) return;
    const watchedPath = this._path;
    const watchesPath = (path: string | undefined): path is string => path === watchedPath
      || !!path && path.startsWith(watchedPath + '/')
        && (this._recursive || !path.slice(watchedPath.length + 1).includes('/'));
    const affectedPath = watchesPath(mutation.path)
      ? mutation.path
      : watchesPath(mutation.previousPath)
        ? mutation.previousPath
        : undefined;
    if (!affectedPath) return;
    const event = mutation.type === 'write' ? 'change' : 'rename';
    const filename = this._relativeName(affectedPath);
    const prior = this._pendingHostEvents.get(filename);
    if (prior !== 'rename') this._pendingHostEvents.set(filename, event);
    if (this._hostEventsQueued) return;
    this._hostEventsQueued = true;
    defer(() => {
      this._hostEventsQueued = false;
      if (this._closed) return;
      const events = this._pendingHostEvents;
      this._pendingHostEvents = new Map();
      for (const [name, queuedEvent] of events) this._emit(queuedEvent, name);
    });
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    if (this._hostSubscription !== null) {
      hostWatchers.delete(this._hostSubscription);
      try { call('fs.watch.unsubscribe', { id: this._hostSubscription }); } catch { /* Host may already be gone. */ }
      this._hostSubscription = null;
    }
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._pendingHostEvents.clear();
    this.emit('close');
    this._releaseLifecycle?.();
    this._releaseLifecycle = null;
    this.removeAllListeners();
    this._snapshot.clear();
  }

  ref(): this {
    this._retainLifecycle();
    return this;
  }
  unref(): this {
    this._releaseLifecycle?.();
    this._releaseLifecycle = null;
    return this;
  }

  private _retainLifecycle(): void {
    if (!this._releaseLifecycle) this._releaseLifecycle = lifecycle()?.retain() ?? null;
  }
}

const hostWatchers = new Map<number, FSWatcher>();
(globalThis as Record<string, unknown>)['__fsWatch'] = {
  dispatch(id: number, mutation: HostMutation): void {
    hostWatchers.get(id)?._onHostMutation(mutation);
  },
};

const watch = (
  filename: string,
  optsOrListener?: WatchOptions | WatchListener,
  maybeListener?: WatchListener,
): FSWatcher => {
  let opts: WatchOptions = {};
  let listener: WatchListener | undefined;
  if (typeof optsOrListener === 'function') listener = optsOrListener;
  else if (optsOrListener && typeof optsOrListener === 'object') opts = optsOrListener;
  if (maybeListener) listener = maybeListener;
  const w = new FSWatcher(normalizePath(filename), opts);
  if (listener) w.on('change', listener as (...args: unknown[]) => void);
  return w;
};

// ---- watchFile / unwatchFile ----

interface FileWatcher {
  curr: Stats | null;
  prev: Stats | null;
  listeners: Set<(curr: Stats, prev: Stats) => void>;
  timer: ReturnType<typeof setInterval>;
  interval: number;
}

const _fileWatchers = new Map<string, FileWatcher>();

const watchFile = (
  filename: string,
  optsOrListener: { interval?: number; persistent?: boolean } | ((curr: Stats, prev: Stats) => void),
  maybeListener?: (curr: Stats, prev: Stats) => void,
): void => {
  const filePath = normalizePath(filename);
  const opts = (typeof optsOrListener === 'object' ? optsOrListener : {}) as { interval?: number };
  const listener = (typeof optsOrListener === 'function' ? optsOrListener : maybeListener) as
    | ((curr: Stats, prev: Stats) => void)
    | undefined;
  if (!listener) return;
  const interval = opts.interval ?? 5007;
  let entry = _fileWatchers.get(filePath);
  if (!entry) {
    let initial: Stats | null = null;
    try { initial = statSync(filePath); } catch { /* */ }
    entry = {
      curr: initial,
      prev: initial,
      listeners: new Set(),
      interval,
      timer: setInterval(() => {
        const e = _fileWatchers.get(filePath);
        if (!e) return;
        let next: Stats | null = null;
        try { next = statSync(filePath); } catch { /* */ }
        if (next && e.curr) {
          if (next.mtimeMs !== e.curr.mtimeMs || next.size !== e.curr.size) {
            e.prev = e.curr;
            e.curr = next;
            for (const fn of e.listeners) {
              try { fn(next, e.prev); } catch { /* */ }
            }
          }
        } else if (next && !e.curr) {
          e.prev = next;
          e.curr = next;
          for (const fn of e.listeners) {
            try { fn(next, next); } catch { /* */ }
          }
        }
      }, interval) as unknown as ReturnType<typeof setInterval>,
    };
    _fileWatchers.set(filePath, entry);
  }
  entry.listeners.add(listener);
};

const unwatchFile = (filename: string, listener?: (curr: Stats, prev: Stats) => void): void => {
  const filePath = normalizePath(filename);
  const entry = _fileWatchers.get(filePath);
  if (!entry) return;
  if (listener) {
    entry.listeners.delete(listener);
  } else {
    entry.listeners.clear();
  }
  if (entry.listeners.size === 0) {
    clearInterval(entry.timer);
    _fileWatchers.delete(filePath);
  }
};

// ---- createReadStream / createWriteStream ----

export interface CreateReadStreamOptions {
  encoding?: string;
  start?: number;
  end?: number;
  highWaterMark?: number;
  autoClose?: boolean;
  flags?: string;
}

export const createReadStream = (path: string, opts?: CreateReadStreamOptions | string): Readable => {
  const filePath = normalizePath(path);
  const o: CreateReadStreamOptions = typeof opts === 'string' ? { encoding: opts } : (opts ?? {});
  let pushed = false;
  return new Readable({
    highWaterMark: o.highWaterMark ?? 64 * 1024,
    read() {
      if (pushed) return;
      pushed = true;
      defer(() => {
        try {
          const buf = readFileBytes(filePath);
          const start = o.start ?? 0;
          const end = o.end !== undefined ? Math.min(o.end + 1, buf.length) : buf.length;
          const slice = buf.subarray(start, end);
          if (o.encoding) {
            this.push(bytesToString(slice, o.encoding));
          } else {
            this.push(slice);
          }
          this.push(null);
        } catch (e) {
          this.destroy(e as Error);
        }
      });
    },
  });
};

export interface CreateWriteStreamOptions {
  flags?: string;
  encoding?: string;
  autoClose?: boolean;
  start?: number;
}

export const createWriteStream = (path: string, opts?: CreateWriteStreamOptions | string): Writable => {
  const filePath = normalizePath(path);
  const o: CreateWriteStreamOptions = typeof opts === 'string' ? { encoding: opts } : (opts ?? {});
  const chunks: Uint8Array[] = [];
  const isAppend = o.flags === 'a' || o.flags === 'a+';
  return new Writable({
    write(chunk, _enc, cb) {
      if (typeof chunk === 'string') chunks.push(toBuffer(chunk));
      else if (chunk instanceof Uint8Array) chunks.push(chunk);
      cb();
    },
    final(cb) {
      defer(() => {
        try {
          let total = 0;
          for (const c of chunks) total += c.length;
          const combined = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) { combined.set(c, off); off += c.length; }
          let finalBytes = combined;
          if (isAppend) {
            try {
              const existing = readFileBytes(filePath);
              const merged = new Uint8Array(existing.length + combined.length);
              merged.set(existing, 0);
              merged.set(combined, existing.length);
              finalBytes = merged;
            } catch { /* */ }
          }
          call('fs.writeFileBytes', { path: filePath, data: finalBytes });
          cb();
        } catch (e) { cb(e as Error); }
      });
    },
  });
};

// ---- mkdtemp ----

const mkdtempSync = (prefix: string): string => {
  const path = normalizePath(prefix);
  const suffix = Math.random().toString(36).slice(2, 8);
  const directory = path + suffix;
  call('fs.mkdir', { path: directory, recursive: false });
  return directory;
};

const mkdtemp = (prefix: string, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { cb?.(null, mkdtempSync(prefix)); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

interface CpOptions {
  recursive?: boolean;
  force?: boolean;
  errorOnExist?: boolean;
  filter?: (src: string, dest: string) => boolean | Promise<boolean>;
  dereference?: boolean;
  preserveTimestamps?: boolean;
  verbatimSymlinks?: boolean;
}

const fsError = (code: string, message: string, Ctor: new (message: string) => Error = Error): Error => {
  const error = new Ctor(message);
  (error as Error & { code?: string }).code = code;
  return error;
};

const cpSync = (src: unknown, dest: unknown, opts: CpOptions = {}): void => {
  const from = normalizePath(src);
  const to = normalizePath(dest);
  if (to === from || to.startsWith(from + '/')) throw fsError('ERR_FS_CP_EINVAL', `Invalid src or dest: cp returned EINVAL (cannot copy ${from} to a subdirectory of self ${to})`);
  const copy = (source: string, target: string): void => {
    if (opts.filter) {
      const allowed = opts.filter(source, target);
      if (allowed && typeof (allowed as Promise<boolean>).then === 'function') throw fsError('ERR_INVALID_RETURN_VALUE', 'Expected a boolean from the filter function, got a Promise', TypeError);
      if (!allowed) return;
    }
    const stat = statSync(source);
    if (stat.isDirectory()) {
      if (!opts.recursive) throw fsError('ERR_FS_EISDIR', `Recursive option is required to copy a directory: ${source}`);
      if (!existsSync(target)) mkdirSync(target, { recursive: true });
      for (const name of readdirSync(source) as string[]) copy(joinPath(source, name), joinPath(target, name));
      return;
    }
    if (existsSync(target)) {
      if (opts.force === false) {
        if (opts.errorOnExist) throw fsError('ERR_FS_CP_EEXIST', `Target already exists: cp returned EEXIST (${target} already exists)`);
        return;
      }
      if (statSync(target).isDirectory()) throw fsError('ERR_FS_CP_NON_DIR_TO_DIR', `Cannot overwrite directory ${target} with non-directory ${source}`);
    }
    const parent = target.split('/').slice(0, -1).join('/') || '/';
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    copyFileSync(source, target);
    if (opts.preserveTimestamps) utimesSync(target, stat.atimeMs / 1000, stat.mtimeMs / 1000);
  };
  copy(from, to);
};

const cp = (src: unknown, dest: unknown, optsOrCb?: CpOptions | Cb, maybeCb?: Cb): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  const opts = typeof optsOrCb === 'function' ? {} : optsOrCb ?? {};
  defer(() => {
    try { cpSync(src, dest, opts); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

class Dir {
  readonly path: string;
  private entries: Dirent[] | undefined;
  private closed = false;

  constructor(path: string) {
    this.path = path;
  }

  private load(): Dirent[] {
    if (this.closed) throw fsError('ERR_DIR_CLOSED', 'Directory handle was closed');
    this.entries ??= readdirSync(this.path, { withFileTypes: true }) as Dirent[];
    return this.entries;
  }

  readSync(): Dirent | null {
    return this.load().shift() ?? null;
  }

  read(cb?: (error: Error | null, entry?: Dirent | null) => void): Promise<Dirent | null> | undefined {
    if (cb) {
      defer(() => {
        let entry: Dirent | null;
        try { entry = this.readSync(); } catch (e) { cb(e as Error); return; }
        cb(null, entry);
      });
      return undefined;
    }
    return promiseOp(() => this.readSync());
  }

  closeSync(): void {
    if (this.closed) throw fsError('ERR_DIR_CLOSED', 'Directory handle was closed');
    this.closed = true;
    this.entries = [];
  }

  close(cb?: (error: Error | null) => void): Promise<void> | undefined {
    if (cb) {
      defer(() => {
        try { this.closeSync(); } catch (e) { cb(e as Error); return; }
        cb(null);
      });
      return undefined;
    }
    return promiseOp(() => this.closeSync());
  }

  async *entriesIterator(): AsyncGenerator<Dirent> {
    try {
      let entry = this.readSync();
      while (entry) {
        yield entry;
        entry = this.readSync();
      }
    } finally {
      if (!this.closed) this.closeSync();
    }
  }

  [Symbol.asyncIterator](): AsyncGenerator<Dirent> {
    return this.entriesIterator();
  }
}

const opendirSync = (path: unknown): Dir => {
  const dir = normalizePath(path);
  if (!statSync(dir).isDirectory()) throw errnoError('ENOTDIR', 'opendir', dir);
  return new Dir(dir);
};

const opendir = (path: unknown, optsOrCb?: unknown, maybeCb?: (error: Error | null, dir?: Dir) => void): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as ((error: Error | null, dir?: Dir) => void) | undefined;
  defer(() => {
    let dir: Dir;
    try { dir = opendirSync(path); } catch (e) { cb?.(e as Error); return; }
    cb?.(null, dir);
  });
};

interface StatFs { type: number | bigint; bsize: number | bigint; blocks: number | bigint; bfree: number | bigint; bavail: number | bigint; files: number | bigint; ffree: number | bigint }

const statfsSync = (path: unknown, opts?: { bigint?: boolean }): StatFs => {
  const target = normalizePath(path);
  if (!existsSync(target)) throw errnoError('ENOENT', 'statfs', target);
  const raw = call('fs.statfs', { path: target }) as { quota?: number; usage?: number } | undefined;
  const bsize = 4096;
  const quota = raw?.quota ?? 1024 * 1024 * 1024;
  const usage = Math.min(raw?.usage ?? 0, quota);
  const blocks = Math.floor(quota / bsize);
  const bfree = Math.floor((quota - usage) / bsize);
  const values = { type: 0x01021994, bsize, blocks, bfree, bavail: bfree, files: 1_000_000, ffree: 1_000_000 };
  if (!opts?.bigint) return values;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, BigInt(value)])) as unknown as StatFs;
};

const statfs = (path: unknown, optsOrCb?: unknown, maybeCb?: (error: Error | null, stats?: StatFs) => void): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as ((error: Error | null, stats?: StatFs) => void) | undefined;
  const opts = typeof optsOrCb === 'object' && optsOrCb !== null ? optsOrCb as { bigint?: boolean } : undefined;
  defer(() => {
    let stats: StatFs;
    try { stats = statfsSync(path, opts); } catch (e) { cb?.(e as Error); return; }
    cb?.(null, stats);
  });
};

const escapeRegex = (text: string): string => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');

const expandBraces = (pattern: string): string[] => {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  let depth = 0;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}' && --depth === 0) {
      const body = pattern.slice(open + 1, i);
      const options: string[] = [];
      let level = 0;
      let start = 0;
      for (let j = 0; j < body.length; j++) {
        if (body[j] === '{') level++;
        else if (body[j] === '}') level--;
        else if (body[j] === ',' && level === 0) { options.push(body.slice(start, j)); start = j + 1; }
      }
      options.push(body.slice(start));
      if (options.length === 1) return [pattern];
      return options.flatMap((option) => expandBraces(pattern.slice(0, open) + option + pattern.slice(i + 1)));
    }
  }
  return [pattern];
};

const segmentRegex = (segment: string): RegExp => {
  let source = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else if (c === '[') {
      const close = segment.indexOf(']', i + 1);
      if (close === -1) { source += '\\['; continue; }
      let body = segment.slice(i + 1, close);
      if (body.startsWith('!')) body = '^' + body.slice(1);
      source += '[' + body.replace(/\\/g, '\\\\') + ']';
      i = close;
    } else source += escapeRegex(c);
  }
  return new RegExp('^' + source + '$');
};

const globMatchers = (pattern: string): Array<Array<RegExp | '**'>> =>
  expandBraces(pattern).map((expanded) => expanded.split('/').filter((part) => part !== '' && part !== '.').map((part) => (part === '**' ? '**' : segmentRegex(part))));

const matchSegments = (parts: string[], matcher: Array<RegExp | '**'>, pi = 0, mi = 0): boolean => {
  if (mi === matcher.length) return pi === parts.length;
  const current = matcher[mi]!;
  if (current === '**') {
    for (let skip = pi; skip <= parts.length; skip++) {
      if (parts.slice(pi, skip).some((part) => part.startsWith('.'))) break;
      if (matchSegments(parts, matcher, skip, mi + 1)) return true;
    }
    return false;
  }
  if (pi === parts.length) return false;
  const part = parts[pi]!;
  if (part.startsWith('.') && !current.source.startsWith('^\\.')) return false;
  return current.test(part) && matchSegments(parts, matcher, pi + 1, mi + 1);
};

interface GlobOptions {
  cwd?: string;
  exclude?: ((path: string | Dirent) => boolean) | string[];
  withFileTypes?: boolean;
}

const globSync = (pattern: string | string[], opts: GlobOptions = {}): Array<string | Dirent> => {
  const cwd = normalizePath(opts.cwd ?? (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? '/');
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  const matchers = patterns.flatMap((p) => globMatchers(p.startsWith('/') ? p.slice(1) : p).map((m) => ({ absolute: p.startsWith('/'), m })));
  const excludeMatchers = Array.isArray(opts.exclude) ? opts.exclude.flatMap((p) => globMatchers(p)) : [];
  const excludeFn = typeof opts.exclude === 'function' ? opts.exclude : undefined;
  const results = new Map<string, string | Dirent>();
  const walk = (dir: string, rel: string[], absolute: boolean): void => {
    let names: string[];
    try { names = readdirSync(dir) as string[]; } catch { return; }
    for (const name of names) {
      const full = joinPath(dir, name);
      const parts = [...rel, name];
      const entry = direntFor(dir, name);
      const display = absolute ? full : parts.join('/');
      if (excludeFn && excludeFn(opts.withFileTypes ? entry : display)) continue;
      if (excludeMatchers.some((m) => matchSegments(parts, m))) continue;
      if (matchers.some(({ absolute: abs, m }) => abs === absolute && matchSegments(parts, m))) {
        results.set(display, opts.withFileTypes ? entry : display);
      }
      if (entry.isDirectory()) walk(full, parts, absolute);
    }
  };
  if (matchers.some(({ absolute }) => !absolute)) walk(cwd, [], false);
  if (matchers.some(({ absolute }) => absolute)) walk('/', [], true);
  return [...results.values()];
};

const glob = (pattern: string | string[], optsOrCb?: GlobOptions | Cb, maybeCb?: Cb): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  const opts = typeof optsOrCb === 'function' ? {} : optsOrCb ?? {};
  if (typeof cb !== 'function') throw fsError('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be of type function', TypeError);
  defer(() => {
    let matches: Array<string | Dirent>;
    try { matches = globSync(pattern, opts); } catch (e) { cb(e as Error); return; }
    cb(null, matches);
  });
};

const abortError = (): Error => {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  (error as Error & { code?: string }).code = 'ABORT_ERR';
  return error;
};

const watchAsync = (filename: string, options: WatchOptions = {}): AsyncIterableIterator<{ eventType: string; filename: string | Uint8Array | null }> => {
  const queue: Array<{ eventType: string; filename: string | Uint8Array | null }> = [];
  let wake: (() => void) | undefined;
  let finished = false;
  let aborted = false;
  const { signal, ...rest } = options;
  const watcher = new FSWatcher(normalizePath(filename), rest);
  watcher.on('change', (eventType: unknown, name: unknown) => {
    queue.push({ eventType: String(eventType), filename: name as string | Uint8Array | null });
    wake?.();
  });
  const stop = (): void => {
    if (finished) return;
    finished = true;
    watcher.close();
    wake?.();
  };
  if (signal) {
    if (signal.aborted) { aborted = true; stop(); }
    else signal.addEventListener('abort', () => { aborted = true; stop(); }, { once: true });
  }
  const iterator: AsyncIterableIterator<{ eventType: string; filename: string | Uint8Array | null }> = {
    async next() {
      while (queue.length === 0 && !finished) await new Promise<void>((resolve) => { wake = resolve; });
      wake = undefined;
      if (queue.length > 0) return { value: queue.shift()!, done: false };
      if (aborted) throw abortError();
      return { value: undefined, done: true };
    },
    async return() {
      stop();
      return { value: undefined, done: true };
    },
    [Symbol.asyncIterator]() { return iterator; },
  };
  return iterator;
};

const globAsync = (pattern: string | string[], opts: GlobOptions = {}): AsyncIterableIterator<string | Dirent> => {
  let matches: Array<string | Dirent> | undefined;
  const iterator: AsyncIterableIterator<string | Dirent> = {
    async next() {
      matches ??= globSync(pattern, opts);
      const value = matches.shift();
      return value === undefined ? { value: undefined, done: true } : { value, done: false };
    },
    [Symbol.asyncIterator]() { return iterator; },
  };
  return iterator;
};

// ---- promises namespace ----

const promises = {
  readFile: (path: string, opts?: FileOptions): Promise<unknown> =>
    promiseOp(() => readFileSync(path, opts)),
  writeFile: (path: string, data: unknown, opts?: FileOptions): Promise<void> =>
    promiseOp(() => writeFileSync(path, data, opts)),
  appendFile: (path: string, data: unknown, opts?: FileOptions): Promise<void> =>
    promiseOp(() => appendFileSync(path, data, opts)),
  readdir: (path: string, opts?: { withFileTypes?: boolean }): Promise<string[] | Dirent[]> =>
    promiseOp(() => readdirSync(path, opts)),
  mkdir: (path: string, opts?: { recursive?: boolean }): Promise<void> =>
    promiseOp(() => mkdirSync(path, opts)),
  rm: (path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> =>
    promiseOp(() => rmSync(path, opts)),
  rmdir: (path: string, opts?: { recursive?: boolean }): Promise<void> =>
    promiseOp(() => rmdirSync(path, opts)),
  unlink: (path: string): Promise<void> =>
    promiseOp(() => unlinkSync(path)),
  stat: (path: string): Promise<Stats> =>
    promiseOp(() => statSync(path)),
  lstat: (path: string): Promise<Stats> =>
    promiseOp(() => lstatSync(path)),
  symlink: (target: string, path: string, _type?: string): Promise<void> =>
    promiseOp(() => symlinkSync(target, path)),
  readlink: (path: string): Promise<string> =>
    promiseOp(() => readlinkSync(path)),
  rename: (from: string, to: string): Promise<void> =>
    promiseOp(() => renameSync(from, to)),
  copyFile: (src: string, dest: string, mode?: number): Promise<void> =>
    promiseOp(() => copyFileSync(src, dest, mode)),
  access: (path: string): Promise<void> =>
    promiseOp(() => accessSync(path)),
  realpath: (path: string): Promise<string> =>
    promiseOp(() => realpathSync(path)),
  truncate: (path: string, len?: number): Promise<void> =>
    promiseOp(() => truncateSync(path, len)),
  chmod: (path: string, mode: number): Promise<void> =>
    promiseOp(() => chmodSync(path, mode)),
  chown: (path: string, uid: number, gid: number): Promise<void> =>
    promiseOp(() => chownSync(path, uid, gid)),
  utimes: (path: string, atime: Date | number, mtime: Date | number): Promise<void> =>
    promiseOp(() => utimesSync(path, atime, mtime)),
  mkdtemp: (prefix: string): Promise<string> =>
    promiseOp(() => mkdtempSync(prefix)),
  cp: (src: unknown, dest: unknown, opts?: CpOptions): Promise<void> =>
    promiseOp(() => cpSync(src, dest, opts)),
  opendir: (path: unknown): Promise<Dir> =>
    promiseOp(() => opendirSync(path)),
  statfs: (path: unknown, opts?: { bigint?: boolean }): Promise<StatFs> =>
    promiseOp(() => statfsSync(path, opts)),
  glob: globAsync,
  watch: watchAsync,
  open: async (path: string, flags?: string | number): Promise<FileHandle> => {
    const fd = await promiseOp(() => _openSync(path, flags ?? 'r'));
    return new FileHandle(fd, path);
  },
};

class FileHandle {
  fd: number;
  path: string;
  constructor(fd: number, path: string) {
    this.fd = fd;
    this.path = path;
  }
  read(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesRead: number; buffer: Uint8Array }> {
    return promiseOp(() => {
      const n = _readSync(this.fd, buffer, offset ?? 0, length ?? buffer.length, position ?? null);
      return { bytesRead: n, buffer };
    });
  }
  write(buffer: Uint8Array | string, offset?: number, length?: number, position?: number | null): Promise<{ bytesWritten: number; buffer: Uint8Array | string }> {
    return promiseOp(() => {
      const n = _writeSync(this.fd, buffer, offset, length, position);
      return { bytesWritten: n, buffer };
    });
  }
  close(): Promise<void> {
    return promiseOp(() => _closeSync(this.fd));
  }
  stat(): Promise<Stats> {
    return promiseOp(() => _fstatSync(this.fd));
  }
  truncate(len?: number): Promise<void> {
    return promiseOp(() => _ftruncateSync(this.fd, len));
  }
  sync(): Promise<void> {
    return promiseOp(() => _fsyncSync(this.fd));
  }
  datasync(): Promise<void> {
    return promiseOp(() => _fsyncSync(this.fd));
  }
  readFile(opts?: string | { encoding?: string }): Promise<unknown> {
    return promiseOp(() => readFileSync(this.path, opts));
  }
  writeFile(data: unknown): Promise<void> {
    return promiseOp(() => writeFileSync(this.path, data));
  }
}

// ---- constants ----

const constants = {
  F_OK: 0, X_OK: 1, W_OK: 2, R_OK: 4,
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2,
  O_CREAT: 0o100, O_EXCL: 0o200, O_TRUNC: 0o1000, O_APPEND: 0o2000,
};

export const nodeFs = {
  // async callback
  readFile,
  writeFile,
  appendFile,
  readdir,
  mkdir,
  rm,
  rmdir,
  unlink,
  exists,
  stat,
  lstat,
  symlink,
  readlink,
  rename,
  copyFile,
  access,
  realpath,
  open,
  close,
  read,
  write,
  fstat,
  ftruncate,
  fsync,
  fdatasync,
  truncate,
  chmod, fchmod, lchmod,
  chown, fchown, lchown,
  utimes, lutimes, futimes,
  mkdtemp,
  watch,
  watchFile,
  unwatchFile,
  cp,
  opendir,
  statfs,
  glob,
  // sync
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  existsSync,
  statSync,
  lstatSync,
  symlinkSync,
  readlinkSync,
  renameSync,
  copyFileSync,
  accessSync,
  realpathSync: Object.assign(realpathSync, { native: realpathSync }),
  truncateSync,
  chmodSync, fchmodSync, lchmodSync,
  chownSync, fchownSync, lchownSync,
  utimesSync, lutimesSync, futimesSync,
  mkdtempSync,
  cpSync,
  opendirSync,
  statfsSync,
  globSync,
  openSync: _openSync,
  closeSync: _closeSync,
  readSync: _readSync,
  writeSync: _writeSync,
  fstatSync: _fstatSync,
  fsyncSync: _fsyncSync,
  fdatasyncSync: _fsyncSync,
  ftruncateSync: _ftruncateSync,
  // streams
  createReadStream,
  createWriteStream,
  // misc
  Stats,
  Dirent,
  Dir,
  FSWatcher,
  constants,
  promises,
};
