import { test, expect } from 'vitest';
import { bootRepl, createFileSystemAccessBackend, createMountBackend, exportSnapshot, importSnapshot, snapshotFromUrl, snapshotToUrl } from '../src/index';
import { createMemoryBackend } from '../src/host/fs-backend';

const longName = `${'deep/'.repeat(30)}${'n'.repeat(120)}.txt`;

const seeded = async () => {
  const fs = createMemoryBackend();
  await fs.mkdir('/app/src', { recursive: true });
  await fs.writeFile('/app/package.json', '{"name":"demo"}');
  await fs.writeFileBytes('/app/src/blob.bin', new Uint8Array([0, 255, 1, 254, 128]));
  await fs.mkdir(`/app/${longName.slice(0, longName.lastIndexOf('/'))}`, { recursive: true });
  await fs.writeFile(`/app/${longName}`, 'long');
  await fs.mkdir('/app/empty');
  return fs;
};

test('snapshots round-trip files, binary data, long paths and empty directories', async () => {
  const source = await seeded();
  for (const gzip of [true, false]) {
    const tar = await exportSnapshot(source, { root: '/app', gzip });
    expect(gzip ? tar[0] === 0x1f && tar[1] === 0x8b : tar[257] === 0x75).toBe(true);
    const target = createMemoryBackend();
    const written = await importSnapshot(target, tar, { root: '/restored' });
    expect(written).toContain('/restored/package.json');
    expect(await target.readFile('/restored/package.json')).toBe('{"name":"demo"}');
    expect([...await target.readFileBytes('/restored/src/blob.bin')]).toEqual([0, 255, 1, 254, 128]);
    expect(await target.readFile(`/restored/${longName}`)).toBe('long');
    expect((await target.stat('/restored/empty')).isDirectory).toBe(true);
  }
});

test('snapshots survive a trip through a share URL', async () => {
  const tar = await exportSnapshot(await seeded(), { root: '/app' });
  const url = snapshotToUrl(tar, 'https://example.test/play?x=1');
  expect(url.startsWith('https://example.test/play?x=1#dusk-snapshot=')).toBe(true);
  expect(snapshotFromUrl(url)).toEqual(tar);
  expect(snapshotFromUrl('https://example.test/')).toBeUndefined();
});

test('imports refuse to write outside the target root', async () => {
  const source = createMemoryBackend();
  await source.mkdir('/x');
  await source.writeFile('/x/ok.txt', 'ok');
  const tar = await exportSnapshot(source, { gzip: false });
  const name = new TextEncoder().encode('../escape.txt');
  const evil = tar.slice();
  evil.fill(0, 512, 612);
  evil.set(name, 512);
  const target = createMemoryBackend();
  await target.mkdir('/root');
  await importSnapshot(target, evil, { root: '/root' });
  expect(await target.exists('/escape.txt')).toBe(false);
});

test('the mount router overlays backends and translates watch events', async () => {
  const base = createMemoryBackend();
  await base.mkdir('/home');
  const mounted = createMemoryBackend();
  await mounted.writeFile('/inside.txt', 'from mount');
  const fs = createMountBackend(base);
  const events: string[] = [];
  fs.subscribe((event) => events.push(`${event.type}:${event.path}`));
  fs.mount('/mnt/data', mounted);
  expect(await fs.readdir('/')).toEqual(['home', 'mnt']);
  expect(await fs.readdir('/mnt')).toEqual(['data']);
  expect((await fs.stat('/mnt')).isDirectory).toBe(true);
  expect(await fs.readFile('/mnt/data/inside.txt')).toBe('from mount');
  await fs.writeFile('/mnt/data/new.txt', 'hi');
  expect(await mounted.readFile('/new.txt')).toBe('hi');
  await expect(fs.rename('/mnt/data/new.txt', '/home/new.txt')).rejects.toMatchObject({ code: 'EXDEV' });
  await expect(fs.rm('/mnt', { recursive: true })).rejects.toMatchObject({ code: 'EBUSY' });
  const fd = await fs.openHandle('/mnt/data/fd.txt', 0o100 | 1);
  await fs.writeHandle(fd.handle, new TextEncoder().encode('fd'), 0);
  await fs.closeHandle(fd.handle);
  expect(await mounted.readFile('/fd.txt')).toBe('fd');
  expect(events).toContain('write:/mnt/data/new.txt');
  expect(fs.unmount('/mnt/data')).toBe(true);
  expect(await fs.exists('/mnt/data/inside.txt')).toBe(false);
});

test('bootRepl mounts a File System Access directory and processes see it', async () => {
  const opfs = await navigator.storage.getDirectory();
  const name = `dusk-mount-${Date.now()}`;
  const dir = await opfs.getDirectoryHandle(name, { create: true });
  try {
    const seed = await (await dir.getFileHandle('hello.txt', { create: true })).createWritable();
    await seed.write('from the host folder');
    await seed.close();
    const backend = createFileSystemAccessBackend(dir);
    await backend.mkdir('/nested/a', { recursive: true });
    expect(await backend.readdir('/')).toEqual(['hello.txt', 'nested']);
    await backend.rename('/nested', '/moved');
    expect(await backend.exists('/moved/a')).toBe(true);
    expect(await backend.exists('/nested')).toBe(false);

    const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
    try {
      repl.mount('/mnt/host', dir);
      const pm = repl.processManager;
      pm.registerBinary('/bin/probe', [
        "const fs = require('fs');",
        "process.stdout.write(fs.readFileSync('/mnt/host/hello.txt', 'utf8'));",
        "fs.writeFileSync('/mnt/host/out.txt', 'written by guest');",
        "process.exit(0);",
      ].join('\n'));
      const result = await pm.spawnSync('/bin/probe', [], { cwd: '/' });
      expect(new TextDecoder().decode(result.stdout)).toBe('from the host folder');
      const out = await (await dir.getFileHandle('out.txt')).getFile();
      expect(await out.text()).toBe('written by guest');

      const snapshot = await repl.exportSnapshot({ root: '/mnt/host' });
      const copy = createMemoryBackend();
      await importSnapshot(copy, snapshot);
      expect(await copy.readFile('/out.txt')).toBe('written by guest');
      expect(repl.unmount('/mnt/host')).toBe(true);
    } finally {
      await repl.dispose();
    }
  } finally {
    await opfs.removeEntry(name, { recursive: true });
  }
}, 60_000);
