import type { FuncTable, SendFn } from './engine-instance';
import type { FSBackend } from './fs-backend';
import { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_APPEND } from './fs-backend';
import type { FDTable } from './fd-table';
import type { NativePackageRegistry } from './native-package-registry';
import { resolveModule } from './module-resolver';
import { prepareModuleSource } from './esm-static-transform';
import { formatHostError } from './host-errors';

export interface FsFuncContext {
  fs: FSBackend;
  pid: number;
  fdTable(pid: number): FDTable;
  nativePackageRegistry: NativePackageRegistry;
}

export const createFsFuncs = (ctx: FsFuncContext): FuncTable => {
  const fs = ctx.fs;
  const ok = (send: SendFn, value: unknown): void => send({ value });
  const err = (send: SendFn, e: unknown): void => send({ error: formatHostError(e) });
  const parseFsFlags = (raw: string | number): number => {
    if (typeof raw === 'number') return raw;
    switch (raw) {
      case 'r':   return O_RDONLY;
      case 'r+':  return O_RDWR;
      case 'w':   return O_WRONLY | O_CREAT | O_TRUNC;
      case 'wx':  return O_WRONLY | O_CREAT | O_TRUNC | O_EXCL;
      case 'w+':  return O_RDWR   | O_CREAT | O_TRUNC;
      case 'wx+': return O_RDWR   | O_CREAT | O_TRUNC | O_EXCL;
      case 'a':   return O_WRONLY | O_CREAT | O_APPEND;
      case 'ax':  return O_WRONLY | O_CREAT | O_APPEND | O_EXCL;
      case 'a+':  return O_RDWR   | O_CREAT | O_APPEND;
      case 'ax+': return O_RDWR   | O_CREAT | O_APPEND | O_EXCL;
      default: { const e: Error & { code?: string } = new Error('EINVAL: unknown flags ' + raw); e.code = 'EINVAL'; throw e; }
    }
  };

  return {
    'fs.statfs': (_m, send) => {
      void (async () => {
        try {
          const storage = (globalThis as { navigator?: { storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> } } }).navigator?.storage;
          const estimate = storage?.estimate ? await storage.estimate() : {};
          ok(send, { quota: estimate.quota, usage: estimate.usage });
        } catch (e) { err(send, e); }
      })();
    },
    'fs.readFile': (m, send) => { void (async () => { try { ok(send, await fs.readFile(m['path'] as string)); } catch (e) { err(send, e); } })(); },
    'fs.readFileBytes': (m, send) => { void (async () => {
      try {
        const bytes = await fs.readFileBytes(m['path'] as string, { pid: ctx.pid });
        const maxBytes = m['maxBytes'] as number | undefined;
        ok(send, maxBytes !== undefined && bytes.length > maxBytes ? { tooLarge: true, size: bytes.length } : bytes);
      } catch (e) { err(send, e); }
    })() },
    'fs.writeFile': (m, send) => { void (async () => { try { await fs.writeFile(m['path'] as string, m['data'] as string); ok(send, true); } catch (e) { err(send, e); } })(); },
    'fs.writeFileBytes': (m, send) => { void (async () => {
      try {
        const bytes = Uint8Array.from(m['data'] as number[]);
        await fs.writeFileBytes(m['path'] as string, bytes, { pid: ctx.pid });
        ok(send, true);
      } catch (e) { err(send, e); }
    })() },
    'fs.readdir': (m, send) => { void (async () => { try { ok(send, await fs.readdir(m['path'] as string)); } catch (e) { err(send, e); } })(); },
    'fs.mkdir': (m, send) => { void (async () => { try { await fs.mkdir(m['path'] as string, { recursive: Boolean(m['recursive']) }); ok(send, true); } catch (e) { err(send, e); } })(); },
    'fs.rm': (m, send) => { void (async () => { try { await fs.rm(m['path'] as string, { recursive: Boolean(m['recursive']) }); ok(send, true); } catch (e) { err(send, e); } })(); },
    'fs.exists': (m, send) => { void (async () => { try { ok(send, await fs.exists(m['path'] as string)); } catch (e) { err(send, e); } })(); },
    'fs.stat': (m, send) => { void (async () => { try { ok(send, await fs.stat(m['path'] as string)); } catch (e) { err(send, e); } })(); },
    'fs.rename': (m, send) => { void (async () => { try { await fs.rename(m['from'] as string, m['to'] as string); ok(send, true); } catch (e) { err(send, e); } })(); },
    'fs.symlink': (m, send) => { void (async () => { try { if (!fs.symlink) { err(send, new Error('ENOTSUP: symlink not supported')); return; } await fs.symlink(m['target'] as string, m['path'] as string); ok(send, true); } catch (e) { err(send, e); } })(); },
    'fs.readlink': (m, send) => { void (async () => { try { if (!fs.readlink) { err(send, new Error('EINVAL: readlink not supported')); return; } ok(send, await fs.readlink(m['path'] as string)); } catch (e) { err(send, e); } })(); },
    'fs.lstat': (m, send) => { void (async () => { try { const path = m['path'] as string; if (fs.lstat) { ok(send, await fs.lstat(path)); } else { ok(send, await fs.stat(path)); } } catch (e) { err(send, e); } })(); },

    'fs.open': (m, send) => { void (async () => {
      try {
        const pid = (m['pid'] as number | undefined) ?? ctx.pid;
        const flags = parseFsFlags((m['flags'] as string | number | undefined) ?? 'r');
        const { handle, size, appendOnly } = await fs.openHandle(m['path'] as string, flags, { pid });
        const tbl = ctx.fdTable(pid);
        const fd = tbl.allocate({ backendHandle: handle, path: m['path'] as string, flags, appendOnly, position: appendOnly ? size : 0 });
        ok(send, fd);
      } catch (e) { err(send, e); }
    })(); },

    'fs.read': (m, send) => { void (async () => {
      try {
        const pid = (m['pid'] as number | undefined) ?? ctx.pid;
        const fd = m['fd'] as number;
        const length = m['length'] as number;
        const pos = m['position'] as number | null | undefined;
        const tbl = ctx.fdTable(pid);
        const entry = tbl.get(fd);
        if (!entry) { const e: Error & { code?: string } = new Error('EBADF: bad file descriptor'); e.code = 'EBADF'; throw e; }
        const position = (pos === null || pos === undefined) ? entry.position : pos;
        const res = await fs.readHandle(entry.backendHandle, length, position, { pid });
        if (pos === null || pos === undefined) entry.position = position + res.bytesRead;
        ok(send, { bytes: res.bytes, bytesRead: res.bytesRead });
      } catch (e) { err(send, e); }
    })(); },

    'fs.write': (m, send) => { void (async () => {
      try {
        const pid = (m['pid'] as number | undefined) ?? ctx.pid;
        const fd = m['fd'] as number;
        const data = Uint8Array.from(m['data'] as number[]);
        const pos = m['position'] as number | null | undefined;
        const tbl = ctx.fdTable(pid);
        const entry = tbl.get(fd);
        if (!entry) { const e: Error & { code?: string } = new Error('EBADF: bad file descriptor'); e.code = 'EBADF'; throw e; }
        const position = entry.appendOnly ? 0 : ((pos === null || pos === undefined) ? entry.position : pos);
        const res = await fs.writeHandle(entry.backendHandle, data, position, { pid });
        if (!entry.appendOnly && (pos === null || pos === undefined)) entry.position = position + res.bytesWritten;
        else if (entry.appendOnly) entry.position = position + res.bytesWritten;
        ok(send, res.bytesWritten);
      } catch (e) { err(send, e); }
    })(); },

    'fs.close': (m, send) => { void (async () => {
      try {
        const pid = (m['pid'] as number | undefined) ?? ctx.pid;
        const fd = m['fd'] as number;
        const tbl = ctx.fdTable(pid);
        const entry = tbl.get(fd);
        if (!entry) { const e: Error & { code?: string } = new Error('EBADF: bad file descriptor'); e.code = 'EBADF'; throw e; }
        await fs.closeHandle(entry.backendHandle, { pid });
        tbl.release(fd);
        ok(send, true);
      } catch (e) { err(send, e); }
    })(); },

    'fs.fstat': (m, send) => { void (async () => {
      try {
        const pid = (m['pid'] as number | undefined) ?? ctx.pid;
        const fd = m['fd'] as number;
        const entry = ctx.fdTable(pid).get(fd);
        if (!entry) { const e: Error & { code?: string } = new Error('EBADF: bad file descriptor'); e.code = 'EBADF'; throw e; }
        ok(send, await fs.fstatHandle(entry.backendHandle, { pid }));
      } catch (e) { err(send, e); }
    })(); },

    'fs.ftruncate': (m, send) => { void (async () => {
      try {
        const pid = (m['pid'] as number | undefined) ?? ctx.pid;
        const fd = m['fd'] as number;
        const length = m['length'] as number;
        const entry = ctx.fdTable(pid).get(fd);
        if (!entry) { const e: Error & { code?: string } = new Error('EBADF: bad file descriptor'); e.code = 'EBADF'; throw e; }
        await fs.ftruncateHandle(entry.backendHandle, length, { pid });
        ok(send, true);
      } catch (e) { err(send, e); }
    })(); },

    'fs.fsync': (m, send) => { void (async () => {
      try {
        const pid = (m['pid'] as number | undefined) ?? ctx.pid;
        const fd = m['fd'] as number;
        const entry = ctx.fdTable(pid).get(fd);
        if (!entry) { const e: Error & { code?: string } = new Error('EBADF: bad file descriptor'); e.code = 'EBADF'; throw e; }
        await fs.fsyncHandle(entry.backendHandle, { pid });
        ok(send, true);
      } catch (e) { err(send, e); }
    })(); },

    'module.resolve': (m, send) => { void (async () => { try { ok(send, await resolveModule(fs, m['request'] as string, m['fromDir'] as string, (m['mode'] as 'import' | 'require' | undefined) ?? 'import', new Set(), ctx.nativePackageRegistry)); } catch (e) { err(send, e); } })(); },
    'module.readSource': (m, send) => { void (async () => { try { const path = m['path'] as string; const source = ctx.nativePackageRegistry.readSource(path) ?? await fs.readFile(path, { pid: ctx.pid }); ok(send, await prepareModuleSource(source, path, m['mode'])); } catch (e) { err(send, e); } })(); },
  };
};
