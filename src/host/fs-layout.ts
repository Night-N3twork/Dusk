import type { FSBackend, FSCaller, FSMutation, FSStat, FSReadResult, FSWriteResult, FSFstat } from './fs-backend';
import type { ProcessManager } from './process-manager';
import { norm, encodeUtf8 } from './vfs';

// Shared stubs for synthetic backends that don't support byte-level fd IO.
// readFileBytes forwards to the synthetic readFile (utf-8 encode); everything else throws ENOSYS.
const enosys = (op: string): Error => {
  const e = new Error(`ENOSYS: ${op} not supported on this mount`);
  (e as Error & { code?: string }).code = 'ENOSYS';
  return e;
};
const syntheticByteStubs = <B extends { readFile(path: string, caller?: FSCaller): Promise<string> }>(base: B) => ({
  readFileBytes: async (path: string, caller?: FSCaller): Promise<Uint8Array> =>
    encodeUtf8(await base.readFile(path, caller)),
  writeFileBytes: async (_path: string, _data: Uint8Array, _caller?: FSCaller): Promise<void> => {
    throw enosys('writeFileBytes');
  },
  openHandle: async (): Promise<{ handle: number; size: number; appendOnly: boolean }> => { throw enosys('openHandle'); },
  readHandle: async (): Promise<FSReadResult> => { throw enosys('readHandle'); },
  writeHandle: async (): Promise<FSWriteResult> => { throw enosys('writeHandle'); },
  closeHandle: async (): Promise<void> => { throw enosys('closeHandle'); },
  fstatHandle: async (): Promise<FSFstat> => { throw enosys('fstatHandle'); },
  ftruncateHandle: async (): Promise<void> => { throw enosys('ftruncateHandle'); },
  fsyncHandle: async (): Promise<void> => { throw enosys('fsyncHandle'); },
  subscribe: (): (() => void) => () => {},
});

export interface LayoutOptions {
  ephemeral: FSBackend;
  persistent: FSBackend;
  processManager: ProcessManager;
  user: string;
  hostname: string;
}

const enotEnt = (path: string): Error => {
  const e = new Error(`ENOENT: no such file or directory, '${path}'`);
  (e as Error & { code?: string }).code = 'ENOENT';
  return e;
};

const erofs = (path: string): Error => {
  const e = new Error(`EROFS: read-only file system, '${path}'`);
  (e as Error & { code?: string }).code = 'EROFS';
  return e;
};

const exdev = (from: string, to: string): Error => {
  const e = new Error(`EXDEV: cross-device link not permitted, rename '${from}' -> '${to}'`);
  (e as Error & { code?: string }).code = 'EXDEV';
  return e;
};

const staticStat = (isFile: boolean, isDirectory: boolean): FSStat => ({
  isFile,
  isDirectory,
  size: 0,
  mtimeMs: 0,
  atimeMs: 0,
  ctimeMs: 0,
  birthtimeMs: 0,
});

const enotDir = (path: string): Error => {
  const e = new Error(`ENOTDIR: not a directory, '${path}'`);
  (e as Error & { code?: string }).code = 'ENOTDIR';
  return e;
};

interface MountResolver {
  match(path: string): boolean;
  backend: FSBackend;
  prefix: string;
  backendPrefix: string;
}

const stripPrefix = (path: string, prefix: string): string => {
  if (path === prefix) return '/';
  if (path.startsWith(prefix + '/')) return path.slice(prefix.length);
  return path;
};

const pathForMount = (path: string, mount: MountResolver): string =>
  mount.backendPrefix === '/'
    ? stripPrefix(path, mount.prefix)
    : norm(mount.backendPrefix + stripPrefix(path, mount.prefix));

const buildSyntheticBin = (pm: ProcessManager): FSBackend => {
  const fileFor = async (name: string): Promise<string | undefined> => {
    const src = pm.getBinarySource(name);
    if (src !== undefined) return src;
    const loaded = await pm.loadBinarySource(name);
    if (loaded !== undefined) return loaded;
    if (pm.hasBinary(name)) return `#!/bin/sh\n# builtin: ${name}\n`;
    return undefined;
  };
  const base = {
    async readFile(path: string): Promise<string> {
      const n = norm(path);
      if (n === '/' || n === '') throw enotDir(path);
      const name = '/bin' + n;
      const src = await fileFor(name);
      if (src === undefined) throw enotEnt(path);
      return src;
    },
    async writeFile(path: string): Promise<void> { throw erofs(path); },
    async readdir(path: string): Promise<string[]> {
      const n = norm(path);
      if (n !== '/' && n !== '') throw enotDir(path);
      return pm.listBinaries().map((b) => b.replace(/^\/bin\//, ''));
    },
    async mkdir(path: string): Promise<void> { throw erofs(path); },
    async rm(path: string): Promise<void> { throw erofs(path); },
    async exists(path: string): Promise<boolean> {
      const n = norm(path);
      if (n === '/' || n === '') return true;
      return pm.hasBinary('/bin' + n);
    },
    async stat(path: string): Promise<FSStat> {
      const n = norm(path);
      if (n === '/' || n === '') return staticStat(false, true);
      const name = '/bin' + n;
      if (pm.hasBinary(name)) return staticStat(true, false);
      throw enotEnt(path);
    },
    async rename(from: string): Promise<void> { throw erofs(from); },
  };
  return { ...base, ...syntheticByteStubs(base) };
};

const formatProcStatus = (rec: { argv0: string; pid: number; ppid: number; title: string }): string => {
  const name = (rec.title || rec.argv0 || 'unknown').slice(0, 16);
  return `Name:\t${name}\nUmask:\t0022\nState:\tR (running)\nTgid:\t${rec.pid}\nNgid:\t0\nPid:\t${rec.pid}\nPPid:\t${rec.ppid}\nTracerPid:\t0\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n`;
};

const buildSyntheticProc = (pm: ProcessManager): FSBackend => {
  const callerPid = (caller?: FSCaller): number => caller?.pid ?? 0;

  const recordFor = (pid: number) => pm.getProcessRecord(pid);

  const base = {
    async readFile(path: string, caller?: FSCaller): Promise<string> {
      const n = norm(path);
      const me = callerPid(caller);
      if (n === '/cpuinfo') return 'processor\t: 0\nmodel name\t: DuskJS Virtual CPU\n';
      if (n === '/meminfo') return 'MemTotal:        0 kB\nMemFree:         0 kB\n';
      if (n === '/uptime') {
        const rec = recordFor(me);
        const up = rec ? (Date.now() - rec.startTime) / 1000 : 0;
        return `${up.toFixed(2)} ${up.toFixed(2)}\n`;
      }
      const selfMatch = /^\/self\/(.+)$/.exec(n);
      const pidMatch = /^\/(\d+)\/(.+)$/.exec(n);
      let pid: number, sub: string;
      if (selfMatch) { pid = me; sub = selfMatch[1]!; }
      else if (pidMatch) { pid = parseInt(pidMatch[1]!, 10); sub = pidMatch[2]!; }
      else throw enotEnt(path);

      const rec = recordFor(pid);
      if (!rec) throw enotEnt(path);
      switch (sub) {
        case 'cmdline': return rec.argv.join('\0') + '\0';
        case 'environ': return Object.entries(rec.env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0';
        case 'status': return formatProcStatus(rec);
        case 'cwd': return rec.cwd;
        case 'exe': return rec.execPath;
        default: throw enotEnt(path);
      }
    },
    async writeFile(path: string): Promise<void> { throw erofs(path); },
    async readdir(path: string, caller?: FSCaller): Promise<string[]> {
      const n = norm(path);
      const me = callerPid(caller);
      if (n === '/' || n === '') {
        const pids = pm.activePids().map((p) => String(p));
        return ['self', 'cpuinfo', 'meminfo', 'uptime', ...pids];
      }
      const selfMatch = /^\/self$/.exec(n);
      const pidMatch = /^\/(\d+)$/.exec(n);
      let pid: number;
      if (selfMatch) pid = me;
      else if (pidMatch) pid = parseInt(pidMatch[1]!, 10);
      else throw enotEnt(path);
      const rec = recordFor(pid);
      if (!rec) throw enotEnt(path);
      return ['cmdline', 'environ', 'status', 'cwd', 'exe'];
    },
    async mkdir(path: string): Promise<void> { throw erofs(path); },
    async rm(path: string): Promise<void> { throw erofs(path); },
    async exists(path: string, caller?: FSCaller): Promise<boolean> {
      try { await this.stat(path, caller); return true; } catch { return false; }
    },
    async stat(path: string, caller?: FSCaller): Promise<FSStat> {
      const n = norm(path);
      const me = callerPid(caller);
      if (n === '/' || n === '') return staticStat(false, true);
      if (n === '/cpuinfo' || n === '/meminfo' || n === '/uptime') return staticStat(true, false);
      if (n === '/self') return staticStat(false, true);
      const selfMatch = /^\/self\/(.+)$/.exec(n);
      const pidMatch = /^\/(\d+)(?:\/(.+))?$/.exec(n);
      if (selfMatch) {
        const rec = recordFor(me);
        if (!rec) throw enotEnt(path);
        return staticStat(true, false);
      }
      if (pidMatch) {
        const pid = parseInt(pidMatch[1]!, 10);
        const rec = recordFor(pid);
        if (!rec) throw enotEnt(path);
        return pidMatch[2] ? staticStat(true, false) : staticStat(false, true);
      }
      throw enotEnt(path);
    },
    async rename(from: string): Promise<void> { throw erofs(from); },
  };
  return { ...base, ...syntheticByteStubs(base) };
};

const buildSyntheticDev = (): FSBackend => {
  const randomBytesString = (n: number): string => {
    const u8 = new Uint8Array(n);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(u8);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(u8[i]!);
    return s;
  };

  const knownNames = new Set(['null', 'zero', 'random', 'urandom', 'stdin', 'stdout', 'stderr']);

  const base = {
    async readFile(path: string): Promise<string> {
      const n = norm(path);
      if (n === '/null') return '';
      if (n === '/zero') return '';
      if (n === '/random' || n === '/urandom') return randomBytesString(32);
      if (n === '/stdin' || n === '/stdout' || n === '/stderr') return '';
      throw enotEnt(path);
    },
    async writeFile(path: string): Promise<void> {
      const n = norm(path);
      const name = n.replace(/^\//, '');
      if (knownNames.has(name)) return;
      throw enotEnt(path);
    },
    async readdir(path: string): Promise<string[]> {
      const n = norm(path);
      if (n === '/' || n === '') return [...knownNames].sort();
      throw enotDir(path);
    },
    async mkdir(path: string): Promise<void> { throw erofs(path); },
    async rm(path: string): Promise<void> { throw erofs(path); },
    async exists(path: string): Promise<boolean> {
      const n = norm(path);
      if (n === '/' || n === '') return true;
      return knownNames.has(n.replace(/^\//, ''));
    },
    async stat(path: string): Promise<FSStat> {
      const n = norm(path);
      if (n === '/' || n === '') return staticStat(false, true);
      if (knownNames.has(n.replace(/^\//, ''))) return staticStat(true, false);
      throw enotEnt(path);
    },
    async rename(from: string): Promise<void> { throw erofs(from); },
  };
  return {
    ...base,
    ...syntheticByteStubs(base),
    async readFileBytes(path: string): Promise<Uint8Array> {
      const n = norm(path);
      if (n === '/random' || n === '/urandom') {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        return bytes;
      }
      if (knownNames.has(n.replace(/^\//, ''))) return new Uint8Array(0);
      throw enotEnt(path);
    },
    async writeFileBytes(path: string): Promise<void> {
      if (!knownNames.has(norm(path).replace(/^\//, ''))) throw enotEnt(path);
    },
  };
};

export const createLayoutBackend = async (opts: LayoutOptions): Promise<FSBackend> => {
  const { ephemeral, persistent, processManager: pm, user, hostname } = opts;
  const homeMount = `/home/${user}`;
  const projectMount = '/project';

  // Seed ephemeral /etc
  const etcSeeds: Record<string, string> = {
    '/etc/hostname': `${hostname}\n`,
    '/etc/passwd': `root:x:0:0:root:/root:/bin/sh\n${user}:x:1000:1000:${user}:/home/${user}:/bin/sh\n`,
    '/etc/group': `root:x:0:\n${user}:x:1000:\n`,
    '/etc/os-release': `NAME=DuskJS\nID=duskjs\nVERSION_ID=0\nPRETTY_NAME="DuskJS"\n`,
    '/etc/profile': `export PATH=/bin\nexport PS1='$ '\n`,
  };
  if (!(await ephemeral.exists('/etc'))) await ephemeral.mkdir('/etc');
  for (const [p, content] of Object.entries(etcSeeds)) {
    if (!(await ephemeral.exists(p))) await ephemeral.writeFile(p, content);
  }
  for (const d of ['/tmp', '/root', '/var', '/home']) {
    if (!(await ephemeral.exists(d))) await ephemeral.mkdir(d);
  }
  if (!(await persistent.exists(projectMount))) await persistent.mkdir(projectMount);

  const syntheticBin = buildSyntheticBin(pm);
  const syntheticProc = buildSyntheticProc(pm);
  const syntheticDev = buildSyntheticDev();

  const mounts: MountResolver[] = [
    { prefix: '/bin', backend: syntheticBin, backendPrefix: '/', match: (p) => p === '/bin' || p.startsWith('/bin/') },
    { prefix: '/proc', backend: syntheticProc, backendPrefix: '/', match: (p) => p === '/proc' || p.startsWith('/proc/') },
    { prefix: '/dev', backend: syntheticDev, backendPrefix: '/', match: (p) => p === '/dev' || p.startsWith('/dev/') },
    { prefix: homeMount, backend: persistent, backendPrefix: '/', match: (p) => p === homeMount || p.startsWith(homeMount + '/') },
    { prefix: projectMount, backend: persistent, backendPrefix: projectMount, match: (p) => p === projectMount || p.startsWith(projectMount + '/') },
  ];

  const pickMount = (path: string): MountResolver | null => {
    for (const m of mounts) if (m.match(path)) return m;
    return null;
  };

  // Backend handle IDs are local, so expose layout-owned IDs and retain where each
  // one originated for all subsequent handle operations.
  let persistentEventMount: MountResolver | undefined;
  const withPersistentEventMount = async <T>(mount: MountResolver | null, operation: () => Promise<T>): Promise<T> => {
    const previous = persistentEventMount;
    if (mount?.backend === persistent) persistentEventMount = mount;
    try { return await operation(); } finally { persistentEventMount = previous; }
  };
  const handles = new Map<number, { backend: FSBackend; handle: number; mount: MountResolver | null }>();
  let nextHandle = 1;
  const targetForHandle = (handle: number): { backend: FSBackend; handle: number; mount: MountResolver | null } =>
    handles.get(handle) ?? { backend: ephemeral, handle, mount: null };

  const layout: FSBackend = {
    subscribe(listener) {
      const notify = (event: FSMutation): void => {
        try { listener(event); } catch { /* Listeners cannot invalidate completed mutations. */ }
      };
      const persistentMounts = mounts.filter((mount) => mount.backend === persistent);
      const persistentMountFor = (path: string): MountResolver =>
        persistentMounts
          .filter((mount) => mount.backendPrefix === '/' || path === mount.backendPrefix || path.startsWith(mount.backendPrefix + '/'))
          .sort((a, b) => b.backendPrefix.length - a.backendPrefix.length)[0] ?? persistentMounts[0]!;
      const forwardPersistent = (event: FSMutation): void => {
        const mount = persistentEventMount ?? persistentMountFor(event.path);
        const translated = { ...event, path: mount.prefix + stripPrefix(event.path, mount.backendPrefix) };
        if (event.previousPath !== undefined) translated.previousPath = mount.prefix + stripPrefix(event.previousPath, mount.backendPrefix);
        notify(translated);
      };
      const unsubscribes = [
        ephemeral.subscribe(notify),
        persistent.subscribe(forwardPersistent),
      ];
      return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
    },
    async readFile(path, caller) {
      const n = norm(path);
      const m = pickMount(n);
      if (m) return m.backend.readFile(pathForMount(n, m), caller);
      return ephemeral.readFile(n, caller);
    },
    async writeFile(path, data, caller) {
      const n = norm(path);
      const m = pickMount(n);
      if (m) return withPersistentEventMount(m, () => m.backend.writeFile(pathForMount(n, m), data, caller));
      return ephemeral.writeFile(n, data, caller);
    },
    async readdir(path, caller) {
      const n = norm(path);
      if (n === '/home') return [user];
      const m = pickMount(n);
      if (m) return m.backend.readdir(pathForMount(n, m), caller);
      return ephemeral.readdir(n, caller);
    },
    async mkdir(path, options, caller) {
      const n = norm(path);
      const m = pickMount(n);
      if (m) return withPersistentEventMount(m, () => m.backend.mkdir(pathForMount(n, m), options, caller));
      return ephemeral.mkdir(n, options, caller);
    },
    async rm(path, options, caller) {
      const n = norm(path);
      const m = pickMount(n);
      if (m) return withPersistentEventMount(m, () => m.backend.rm(pathForMount(n, m), options, caller));
      return ephemeral.rm(n, options, caller);
    },
    async exists(path, caller) {
      const n = norm(path);
      if (n === '/home') return true;
      const m = pickMount(n);
      if (m) return m.backend.exists(pathForMount(n, m), caller);
      return ephemeral.exists(n, caller);
    },
    async stat(path, caller) {
      const n = norm(path);
      if (n === '/home') return staticStat(false, true);
      const m = pickMount(n);
      if (m) return m.backend.stat(pathForMount(n, m), caller);
      return ephemeral.stat(n, caller);
    },
    async rename(from, to, caller) {
      const f = norm(from);
      const t = norm(to);
      const fm = pickMount(f);
      const tm = pickMount(t);
      if ((fm?.prefix ?? '') !== (tm?.prefix ?? '')) throw exdev(from, to);
      if (fm) return withPersistentEventMount(fm, () => fm.backend.rename(pathForMount(f, fm), pathForMount(t, fm), caller));
      return ephemeral.rename(f, t, caller);
    },
    async readFileBytes(path, caller) {
      const n = norm(path);
      const m = pickMount(n);
      if (m) return m.backend.readFileBytes(pathForMount(n, m), caller);
      return ephemeral.readFileBytes(n, caller);
    },
    async writeFileBytes(path, data, caller) {
      const n = norm(path);
      const m = pickMount(n);
      if (m) return withPersistentEventMount(m, () => m.backend.writeFileBytes(pathForMount(n, m), data, caller));
      return ephemeral.writeFileBytes(n, data, caller);
    },
    async openHandle(path, flags, caller) {
      const n = norm(path);
      const m = pickMount(n);
      const backend = m?.backend ?? ephemeral;
      const opened = await withPersistentEventMount(m, () => backend.openHandle(m ? pathForMount(n, m) : n, flags, caller));
      const handle = nextHandle++;
      handles.set(handle, { backend, handle: opened.handle, mount: m });
      return { ...opened, handle };
    },
    async readHandle(handle, length, position, caller) {
      const target = targetForHandle(handle);
      return target.backend.readHandle(target.handle, length, position, caller);
    },
    async writeHandle(handle, data, position, caller) {
      const target = targetForHandle(handle);
      return withPersistentEventMount(target.mount, () => target.backend.writeHandle(target.handle, data, position, caller));
    },
    async closeHandle(handle, caller) {
      const target = targetForHandle(handle);
      await withPersistentEventMount(target.mount, () => target.backend.closeHandle(target.handle, caller));
      handles.delete(handle);
    },
    async fstatHandle(handle, caller) {
      const target = targetForHandle(handle);
      return target.backend.fstatHandle(target.handle, caller);
    },
    async ftruncateHandle(handle, length, caller) {
      const target = targetForHandle(handle);
      return withPersistentEventMount(target.mount, () => target.backend.ftruncateHandle(target.handle, length, caller));
    },
    async fsyncHandle(handle, caller) {
      const target = targetForHandle(handle);
      return withPersistentEventMount(target.mount, () => target.backend.fsyncHandle(target.handle, caller));
    },
  };

  return layout;
};
