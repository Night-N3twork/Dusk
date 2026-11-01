import type { FSBackend, FSCaller, FSMutation, FSStat } from './fs-backend';
import { norm } from './vfs';

export interface MountableBackend extends FSBackend {
  mount(prefix: string, backend: FSBackend): void;
  unmount(prefix: string): boolean;
  mounts(): string[];
}

interface Mount {
  prefix: string;
  backend: FSBackend;
  unsubscribe?: () => void;
}

const codeError = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(`${code}: ${message}`), { code });

const inside = (path: string, prefix: string): boolean => path === prefix || path.startsWith(prefix + '/');

const relativeTo = (path: string, prefix: string): string => (path === prefix ? '/' : path.slice(prefix.length));

const directoryStat = (): FSStat => {
  const now = Date.now();
  return { isFile: false, isDirectory: true, size: 0, mtimeMs: now, atimeMs: now, ctimeMs: now, birthtimeMs: now };
};

export const createMountBackend = (base: FSBackend): MountableBackend => {
  const table: Mount[] = [];
  const listeners = new Set<(event: FSMutation) => void>();
  const handles = new Map<number, { backend: FSBackend; handle: number }>();
  let nextHandle = 1;

  const notify = (event: FSMutation): void => {
    for (const listener of listeners) {
      try { listener(event); } catch { }
    }
  };

  const resolve = (path: string): { backend: FSBackend; path: string; mount?: Mount } => {
    const n = norm(path);
    for (const mount of table) {
      if (inside(n, mount.prefix)) return { backend: mount.backend, path: relativeTo(n, mount.prefix), mount };
    }
    return { backend: base, path: n };
  };

  const childMounts = (dir: string): string[] => {
    const base = dir === '/' ? '/' : dir + '/';
    const names = new Set<string>();
    for (const { prefix } of table) {
      if (prefix.startsWith(base) && prefix !== dir) names.add(prefix.slice(base.length).split('/')[0]!);
    }
    return [...names];
  };

  const isMountAncestor = (path: string): boolean =>
    table.some(({ prefix }) => prefix !== path && (path === '/' || prefix.startsWith(path + '/')));

  const forward = (mount: Mount) => (event: FSMutation): void => {
    const translate = (inner: string): string => (inner === '/' ? mount.prefix : mount.prefix + inner);
    notify(event.previousPath === undefined
      ? { ...event, path: translate(event.path) }
      : { ...event, path: translate(event.path), previousPath: translate(event.previousPath) });
  };

  let baseUnsubscribe: (() => void) | undefined;

  const ensureSubscriptions = (): void => {
    if (listeners.size === 0) return;
    baseUnsubscribe ??= base.subscribe(notify);
    for (const mount of table) mount.unsubscribe ??= mount.backend.subscribe(forward(mount));
  };

  const dropSubscriptions = (): void => {
    baseUnsubscribe?.();
    baseUnsubscribe = undefined;
    for (const mount of table) {
      mount.unsubscribe?.();
      delete mount.unsubscribe;
    }
  };

  const route = <T>(path: string, run: (backend: FSBackend, inner: string) => Promise<T>): Promise<T> => {
    const target = resolve(path);
    return run(target.backend, target.path);
  };

  return {
    mount(prefix, backend) {
      const n = norm(prefix);
      if (n === '/') throw codeError('EINVAL', 'cannot mount over /');
      if (table.some((mount) => mount.prefix === n)) throw codeError('EBUSY', `${n} is already a mount point`);
      table.push({ prefix: n, backend });
      table.sort((a, b) => b.prefix.length - a.prefix.length);
      ensureSubscriptions();
    },
    unmount(prefix) {
      const n = norm(prefix);
      const index = table.findIndex((mount) => mount.prefix === n);
      if (index === -1) return false;
      table[index]!.unsubscribe?.();
      table.splice(index, 1);
      return true;
    },
    mounts: () => table.map((mount) => mount.prefix).sort(),

    subscribe(listener) {
      listeners.add(listener);
      ensureSubscriptions();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) dropSubscriptions();
      };
    },

    readFile: (path, caller) => route(path, (backend, inner) => backend.readFile(inner, caller)),
    writeFile: (path, data, caller) => route(path, (backend, inner) => backend.writeFile(inner, data, caller)),
    readFileBytes: (path, caller) => route(path, (backend, inner) => backend.readFileBytes(inner, caller)),
    writeFileBytes: (path, data, caller) => route(path, (backend, inner) => backend.writeFileBytes(inner, data, caller)),
    async readdir(path, caller) {
      const n = norm(path);
      const target = resolve(n);
      let names: string[] = [];
      try {
        names = await target.backend.readdir(target.path, caller);
      } catch (error) {
        if (!isMountAncestor(n)) throw error;
      }
      const extra = childMounts(n).filter((name) => !names.includes(name));
      return extra.length > 0 ? [...names, ...extra].sort() : names;
    },
    async mkdir(path, options, caller) {
      const n = norm(path);
      if (table.some((mount) => mount.prefix === n)) {
        if (options?.recursive) return;
        throw codeError('EEXIST', `file already exists, mkdir '${n}'`);
      }
      return route(n, (backend, inner) => backend.mkdir(inner, options, caller));
    },
    async rm(path, options, caller) {
      const n = norm(path);
      if (table.some((mount) => inside(mount.prefix, n))) throw codeError('EBUSY', `resource busy or locked, rm '${n}'`);
      return route(n, (backend, inner) => backend.rm(inner, options, caller));
    },
    async exists(path, caller) {
      const n = norm(path);
      if (isMountAncestor(n)) return true;
      return route(n, (backend, inner) => backend.exists(inner, caller));
    },
    async stat(path, caller) {
      const n = norm(path);
      const target = resolve(n);
      try {
        return await target.backend.stat(target.path, caller);
      } catch (error) {
        if (isMountAncestor(n)) return directoryStat();
        throw error;
      }
    },
    async rename(from, to, caller) {
      const source = resolve(from);
      const destination = resolve(to);
      if (source.backend !== destination.backend || source.mount !== destination.mount) {
        throw codeError('EXDEV', `cross-device link not permitted, rename '${norm(from)}' -> '${norm(to)}'`);
      }
      return source.backend.rename(source.path, destination.path, caller);
    },
    async symlink(target, path, caller) {
      const resolved = resolve(path);
      if (!resolved.backend.symlink) throw codeError('ENOSYS', `symlinks are not supported on this mount, '${norm(path)}'`);
      return resolved.backend.symlink(target, resolved.path, caller);
    },
    async readlink(path, caller) {
      const resolved = resolve(path);
      if (!resolved.backend.readlink) throw codeError('EINVAL', `invalid argument, readlink '${norm(path)}'`);
      return resolved.backend.readlink(resolved.path, caller);
    },
    async lstat(path, caller) {
      const resolved = resolve(path);
      if (resolved.backend.lstat) return resolved.backend.lstat(resolved.path, caller);
      return resolved.backend.stat(resolved.path, caller);
    },

    async openHandle(path, flags, caller) {
      const target = resolve(path);
      const opened = await target.backend.openHandle(target.path, flags, caller);
      const handle = nextHandle++;
      handles.set(handle, { backend: target.backend, handle: opened.handle });
      return { ...opened, handle };
    },
    readHandle: (handle, length, position, caller?: FSCaller) => {
      const target = handles.get(handle);
      if (!target) return Promise.reject(codeError('EBADF', 'bad file descriptor'));
      return target.backend.readHandle(target.handle, length, position, caller);
    },
    writeHandle: (handle, data, position, caller) => {
      const target = handles.get(handle);
      if (!target) return Promise.reject(codeError('EBADF', 'bad file descriptor'));
      return target.backend.writeHandle(target.handle, data, position, caller);
    },
    async closeHandle(handle, caller) {
      const target = handles.get(handle);
      if (!target) throw codeError('EBADF', 'bad file descriptor');
      handles.delete(handle);
      await target.backend.closeHandle(target.handle, caller);
    },
    fstatHandle: (handle, caller) => {
      const target = handles.get(handle);
      if (!target) return Promise.reject(codeError('EBADF', 'bad file descriptor'));
      return target.backend.fstatHandle(target.handle, caller);
    },
    ftruncateHandle: (handle, length, caller) => {
      const target = handles.get(handle);
      if (!target) return Promise.reject(codeError('EBADF', 'bad file descriptor'));
      return target.backend.ftruncateHandle(target.handle, length, caller);
    },
    fsyncHandle: (handle, caller) => {
      const target = handles.get(handle);
      if (!target) return Promise.reject(codeError('EBADF', 'bad file descriptor'));
      return target.backend.fsyncHandle(target.handle, caller);
    },
  };
};
