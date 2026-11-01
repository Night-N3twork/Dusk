import type { FSBackend, FSMutation, FSStat } from './fs-backend';
import { O_APPEND, O_CREAT, O_EXCL, O_TRUNC } from './fs-backend';
import { decodeUtf8, encodeUtf8, norm } from './vfs';

type DirectoryEntries = { values(): AsyncIterable<FileSystemDirectoryHandle | FileSystemFileHandle> };

const codeError = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(`${code}: ${message}`), { code });

const segments = (path: string): string[] => norm(path).split('/').filter(Boolean);

const isNotFound = (error: unknown): boolean => {
  const name = (error as { name?: string } | null)?.name;
  return name === 'NotFoundError' || name === 'TypeMismatchError';
};

interface OpenFile {
  path: string;
  data: Uint8Array;
  appendOnly: boolean;
  dirty: boolean;
}

export const createFileSystemAccessBackend = (root: FileSystemDirectoryHandle): FSBackend => {
  const listeners = new Set<(event: FSMutation) => void>();
  const handles = new Map<number, OpenFile>();
  let nextHandle = 1;

  const emit = (event: FSMutation): void => {
    for (const listener of listeners) {
      try { listener(event); } catch { }
    }
  };

  const directory = async (parts: readonly string[], path: string, create = false): Promise<FileSystemDirectoryHandle> => {
    let current = root;
    for (const part of parts) {
      try {
        current = await current.getDirectoryHandle(part, { create });
      } catch (error) {
        if ((error as { name?: string }).name === 'TypeMismatchError') throw codeError('ENOTDIR', `not a directory, '${path}'`);
        if (isNotFound(error)) throw codeError('ENOENT', `no such file or directory, '${path}'`);
        throw error;
      }
    }
    return current;
  };

  const parentOf = async (path: string, create = false): Promise<{ dir: FileSystemDirectoryHandle; name: string }> => {
    const parts = segments(path);
    const name = parts.pop();
    if (name === undefined) throw codeError('EISDIR', `illegal operation on a directory, '${norm(path)}'`);
    return { dir: await directory(parts, norm(path), create), name };
  };

  const lookup = async (path: string): Promise<FileSystemDirectoryHandle | FileSystemFileHandle> => {
    const n = norm(path);
    if (n === '/') return root;
    const { dir, name } = await parentOf(n);
    try {
      return await dir.getFileHandle(name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    try {
      return await dir.getDirectoryHandle(name);
    } catch (error) {
      if (isNotFound(error)) throw codeError('ENOENT', `no such file or directory, '${n}'`);
      throw error;
    }
  };

  const fileHandle = async (path: string, create = false): Promise<FileSystemFileHandle> => {
    const n = norm(path);
    const { dir, name } = await parentOf(n);
    try {
      return await dir.getFileHandle(name, { create });
    } catch (error) {
      if ((error as { name?: string }).name === 'TypeMismatchError') throw codeError('EISDIR', `illegal operation on a directory, '${n}'`);
      if (isNotFound(error)) throw codeError('ENOENT', `no such file or directory, '${n}'`);
      throw error;
    }
  };

  const readBytes = async (path: string): Promise<Uint8Array> => {
    const file = await (await fileHandle(path)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  };

  const writeBytes = async (path: string, data: Uint8Array): Promise<void> => {
    const handle = await fileHandle(path, true);
    const writable = await handle.createWritable();
    await writable.write(data as BufferSource);
    await writable.close();
  };

  const statOf = async (entry: FileSystemDirectoryHandle | FileSystemFileHandle): Promise<FSStat> => {
    if (entry.kind === 'directory') {
      return { isFile: false, isDirectory: true, size: 0, mtimeMs: 0, atimeMs: 0, ctimeMs: 0, birthtimeMs: 0 };
    }
    const file = await (entry as FileSystemFileHandle).getFile();
    const time = file.lastModified;
    return { isFile: true, isDirectory: false, size: file.size, mtimeMs: time, atimeMs: time, ctimeMs: time, birthtimeMs: time };
  };

  const list = async (dir: FileSystemDirectoryHandle): Promise<Array<FileSystemDirectoryHandle | FileSystemFileHandle>> => {
    const out: Array<FileSystemDirectoryHandle | FileSystemFileHandle> = [];
    for await (const entry of (dir as unknown as DirectoryEntries).values()) out.push(entry);
    return out;
  };

  const copyInto = async (source: FileSystemDirectoryHandle | FileSystemFileHandle, target: FileSystemDirectoryHandle, name: string): Promise<void> => {
    if (source.kind === 'file') {
      const file = await (source as FileSystemFileHandle).getFile();
      const handle = await target.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(await file.arrayBuffer());
      await writable.close();
      return;
    }
    const dir = await target.getDirectoryHandle(name, { create: true });
    for (const child of await list(source as FileSystemDirectoryHandle)) await copyInto(child, dir, child.name);
  };

  const openFile = (handle: number): OpenFile => {
    const open = handles.get(handle);
    if (!open) throw codeError('EBADF', 'bad file descriptor');
    return open;
  };

  const flush = async (open: OpenFile): Promise<void> => {
    if (!open.dirty) return;
    await writeBytes(open.path, open.data);
    open.dirty = false;
    emit({ type: 'write', path: open.path });
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readFile: async (path) => decodeUtf8(await readBytes(path)),
    async writeFile(path, data) {
      await writeBytes(path, encodeUtf8(data));
      emit({ type: 'write', path: norm(path) });
    },
    readFileBytes: readBytes,
    async writeFileBytes(path, data) {
      await writeBytes(path, data);
      emit({ type: 'write', path: norm(path) });
    },
    async readdir(path) {
      const entry = await lookup(path);
      if (entry.kind !== 'directory') throw codeError('ENOTDIR', `not a directory, scandir '${norm(path)}'`);
      return (await list(entry as FileSystemDirectoryHandle)).map((child) => child.name).sort();
    },
    async mkdir(path, options) {
      const n = norm(path);
      if (n === '/') {
        if (options?.recursive) return;
        throw codeError('EEXIST', `file already exists, mkdir '${n}'`);
      }
      const { dir, name } = await parentOf(n, options?.recursive ?? false);
      let exists = false;
      try {
        await dir.getDirectoryHandle(name);
        exists = true;
      } catch (error) {
        if ((error as { name?: string }).name === 'TypeMismatchError') throw codeError('EEXIST', `file already exists, mkdir '${n}'`);
        if (!isNotFound(error)) throw error;
      }
      if (exists) {
        if (options?.recursive) return;
        throw codeError('EEXIST', `file already exists, mkdir '${n}'`);
      }
      await dir.getDirectoryHandle(name, { create: true });
      emit({ type: 'mkdir', path: n });
    },
    async rm(path, options) {
      const n = norm(path);
      if (n === '/') throw codeError('EPERM', `operation not permitted, rm '${n}'`);
      const { dir, name } = await parentOf(n);
      try {
        await dir.removeEntry(name, { recursive: options?.recursive ?? false });
      } catch (error) {
        if (isNotFound(error)) throw codeError('ENOENT', `no such file or directory, rm '${n}'`);
        if ((error as { name?: string }).name === 'InvalidModificationError') throw codeError('ENOTEMPTY', `directory not empty, rm '${n}'`);
        throw error;
      }
      emit({ type: 'rm', path: n });
    },
    async exists(path) {
      try {
        await lookup(path);
        return true;
      } catch {
        return false;
      }
    },
    stat: async (path) => statOf(await lookup(path)),
    async rename(from, to) {
      const source = norm(from);
      const destination = norm(to);
      if (source === destination) return;
      if (destination.startsWith(source + '/')) throw codeError('EINVAL', `invalid argument, rename '${source}' -> '${destination}'`);
      const entry = await lookup(source);
      const target = await parentOf(destination);
      try {
        await target.dir.removeEntry(target.name, { recursive: true });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      await copyInto(entry, target.dir, target.name);
      const origin = await parentOf(source);
      await origin.dir.removeEntry(origin.name, { recursive: true });
      emit({ type: 'rename', path: destination, previousPath: source });
    },

    async openHandle(path, flags) {
      const n = norm(path);
      let data: Uint8Array;
      let created = false;
      try {
        data = await readBytes(n);
        if ((flags & O_EXCL) !== 0 && (flags & O_CREAT) !== 0) throw codeError('EEXIST', `file already exists, open '${n}'`);
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT' || (flags & O_CREAT) === 0) throw error;
        data = new Uint8Array(0);
        created = true;
      }
      const truncate = (flags & O_TRUNC) !== 0 && data.length > 0;
      if (truncate) data = new Uint8Array(0);
      const open: OpenFile = { path: n, data, appendOnly: (flags & O_APPEND) !== 0, dirty: created || truncate };
      if (open.dirty) await flush(open);
      const handle = nextHandle++;
      handles.set(handle, open);
      return { handle, size: data.length, appendOnly: open.appendOnly };
    },
    async readHandle(handle, length, position) {
      const open = openFile(handle);
      const start = Math.max(0, Math.min(position, open.data.length));
      const bytes = open.data.slice(start, Math.min(open.data.length, start + length));
      return { bytes, bytesRead: bytes.length };
    },
    async writeHandle(handle, data, position) {
      const open = openFile(handle);
      const at = open.appendOnly ? open.data.length : Math.max(0, position);
      const end = at + data.length;
      if (end > open.data.length) {
        const grown = new Uint8Array(end);
        grown.set(open.data);
        open.data = grown;
      }
      open.data.set(data, at);
      open.dirty = true;
      return { bytesWritten: data.length };
    },
    async closeHandle(handle) {
      const open = openFile(handle);
      handles.delete(handle);
      await flush(open);
    },
    async fstatHandle(handle) {
      const open = openFile(handle);
      const now = Date.now();
      return { isFile: true, isDirectory: false, size: open.data.length, mtimeMs: now, atimeMs: now, ctimeMs: now, birthtimeMs: now };
    },
    async ftruncateHandle(handle, length) {
      const open = openFile(handle);
      const next = new Uint8Array(length);
      next.set(open.data.subarray(0, Math.min(length, open.data.length)));
      open.data = next;
      open.dirty = true;
    },
    fsyncHandle: async (handle) => flush(openFile(handle)),
  };
};
