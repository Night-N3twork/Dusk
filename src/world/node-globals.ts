import { installNodeProcess } from './node-process';
import './engine-streams';

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

export const installNodeGlobals = (): void => {
  const g = globalThis as Record<string, unknown>;
  const call = (f: string, extra: Record<string, unknown> = {}): unknown => {
    const r = ipc.send({ f, ...extra });
    if (r.error) throw new Error(r.error);
    return r.value;
  };
  g['console'] = {
    log: (...args: unknown[]) => call('console.log', { args }),
    error: (...args: unknown[]) => call('console.error', { args }),
    warn: (...args: unknown[]) => call('console.error', { args }),
    info: (...args: unknown[]) => call('console.log', { args }),
    debug: (..._args: unknown[]) => { /* no-op: no debug channel in DuskJS engine */ },
    trace: (...args: unknown[]) => call('console.error', { args }),
    dir: (obj: unknown) => call('console.log', { args: [obj] }),
    group: (...args: unknown[]) => call('console.log', { args }),
    groupCollapsed: (...args: unknown[]) => call('console.log', { args }),
    groupEnd: () => { /* no-op */ },
    time: (_label?: string) => { /* no-op */ },
    timeEnd: (_label?: string) => { /* no-op */ },
    timeLog: (_label?: string) => { /* no-op */ },
    count: (_label?: string) => { /* no-op */ },
    countReset: (_label?: string) => { /* no-op */ },
    assert: (cond: unknown, ...args: unknown[]) => {
      if (!cond) call('console.error', { args: ['Assertion failed:', ...args] });
    },
    table: (obj: unknown) => call('console.log', { args: [obj] }),
    clear: () => { /* no-op */ },
  };
  g['__fs'] = {
    readFile: (path: string) => call('fs.readFile', { path }),
    writeFile: (path: string, data: string) => call('fs.writeFile', { path, data }),
    readdir: (path: string) => call('fs.readdir', { path }),
    mkdir: (path: string, recursive: boolean) => call('fs.mkdir', { path, recursive }),
    rm: (path: string, recursive?: boolean) => call('fs.rm', { path, recursive: !!recursive }),
    exists: (path: string) => call('fs.exists', { path }),
    stat: (path: string) => call('fs.stat', { path }),
    rename: (from: string, to: string) => call('fs.rename', { from, to }),
    readFileBytes: (path: string): Uint8Array => {
      const value = call('fs.readFileBytes', { path });
      return value instanceof Uint8Array ? value : Uint8Array.from(value as number[]);
    },
    writeFileBytes: (path: string, data: Uint8Array) => call('fs.writeFileBytes', { path, data }),
    appendFile: (path: string, data: string) => {
      // read-modify-write; TFS lacks a native append IPC
      let existing = '';
      try { existing = call('fs.readFile', { path }) as string; } catch { /* not-exists */ }
      return call('fs.writeFile', { path, data: existing + data });
    },
  };

  installNodeProcess();
};
