import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';
import type { FSBackend } from '../src/host/fs-backend';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const withShell = async (run: (sh: (script: string) => Promise<{ status: number; stdout: string; stderr: string; bytes: Uint8Array }>, fs: FSBackend) => Promise<void>) => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  try {
    await run(async (script) => {
      const r = await repl.processManager.spawnSync('/bin/dsh', ['-c', script], { cwd: '/tmp', env: { PATH: '/bin', HOME: '/tmp' } });
      return { status: r.status, stdout: decode(r.stdout), stderr: decode(r.stderr), bytes: r.stdout };
    }, fs);
  } finally {
    await repl.dispose();
  }
};

test('tar creates, lists and extracts gzip archives with binary content', async () => {
  await withShell(async (sh, fs) => {
    await fs.mkdir('/tmp/src/nested', { recursive: true });
    await fs.writeFile('/tmp/src/hello.txt', 'hello archive\n');
    await fs.writeFileBytes('/tmp/src/nested/blob.bin', new Uint8Array([0, 1, 2, 253, 254, 255]));
    const create = await sh('tar -czvf out.tgz src');
    expect(create.status).toBe(0);
    expect(create.stdout).toContain('src/nested/blob.bin');
    const list = await sh('tar tzf out.tgz | sort');
    expect(list.stdout).toBe('src/\nsrc/hello.txt\nsrc/nested/\nsrc/nested/blob.bin\n');
    const extract = await sh('mkdir dest && tar -xzf out.tgz -C dest --strip-components=1 && cat dest/hello.txt');
    expect(extract.stdout).toBe('hello archive\n');
    expect([...await fs.readFileBytes('/tmp/dest/nested/blob.bin')]).toEqual([0, 1, 2, 253, 254, 255]);
    const piped = await sh('tar -cf - src/hello.txt | tar -xOf -');
    expect(piped.stdout).toBe('hello archive\n');
  });
}, 60_000);

test('gzip, gunzip and zcat round-trip files and pipes', async () => {
  await withShell(async (sh, fs) => {
    await fs.writeFile('/tmp/note.txt', 'compress me '.repeat(50));
    expect((await sh('gzip note.txt && ls note.txt*')).stdout).toBe('note.txt.gz\n');
    expect((await sh('zcat note.txt.gz | head -c 11')).stdout).toBe('compress me');
    expect((await sh('gunzip note.txt.gz && wc -c < note.txt')).stdout.trim()).toBe('600');
    expect((await sh('echo piped | gzip | gunzip')).stdout).toBe('piped\n');
  });
}, 60_000);

test('zip and unzip archives, listing and extracting into a directory', async () => {
  await withShell(async (sh, fs) => {
    await fs.mkdir('/tmp/proj/lib', { recursive: true });
    await fs.writeFile('/tmp/proj/a.txt', 'alpha '.repeat(40));
    await fs.writeFile('/tmp/proj/lib/b.js', 'module.exports = 1;\n');
    const zipped = await sh('zip -r bundle.zip proj');
    expect(zipped.status).toBe(0);
    expect(zipped.stdout).toMatch(/adding: proj\/a\.txt \(deflated \d+%\)/);
    const listed = await sh('unzip -l bundle.zip');
    expect(listed.stdout).toContain('proj/lib/b.js');
    expect(listed.stdout).toMatch(/4 files/);
    const extracted = await sh('unzip -q bundle.zip -d out && cat out/proj/lib/b.js');
    expect(extracted.stdout).toBe('module.exports = 1;\n');
    expect((await sh('unzip -p bundle.zip proj/a.txt | wc -c')).stdout.trim()).toBe('240');
    expect((await sh('zip -d bundle.zip "proj/lib/*" >/dev/null && unzip -l bundle.zip | grep -c b.js')).stdout.trim()).toBe('0');
  });
}, 60_000);

test('patch applies diff output, detects reversed patches and reports failures', async () => {
  await withShell(async (sh, fs) => {
    await fs.mkdir('/tmp/a', { recursive: true });
    await fs.mkdir('/tmp/b', { recursive: true });
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    await fs.writeFile('/tmp/a/file.txt', lines.join('\n') + '\n');
    const changed = [...lines];
    changed[4] = 'line five';
    changed.splice(20, 1, 'line twenty-one', 'extra');
    await fs.writeFile('/tmp/b/file.txt', changed.join('\n') + '\n');
    await sh('diff -u a/file.txt b/file.txt > change.patch; true');
    await fs.writeFile('/tmp/work.txt', ['header', ...lines].join('\n') + '\n');
    const applied = await sh('patch work.txt < change.patch');
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain('patching file work.txt');
    expect(applied.stdout).toContain('offset 1 line');
    expect(await fs.readFile('/tmp/work.txt')).toBe(['header', ...changed].join('\n') + '\n');
    const again = await sh('patch -N work.txt < change.patch');
    expect(again.stdout).toContain('Reversed (or previously applied) patch detected');
    expect(again.status).toBe(1);
    const reverted = await sh('patch -R -p1 -d a --dry-run < change.patch; patch -R work.txt -i change.patch');
    expect(reverted.status).toBe(0);
    expect(await fs.readFile('/tmp/work.txt')).toBe(['header', ...lines].join('\n') + '\n');
    await fs.writeFile('/tmp/other.txt', 'nothing in common\n');
    const failed = await sh('patch other.txt < change.patch');
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('FAILED');
    expect(await fs.exists('/tmp/other.txt.rej')).toBe(true);
  });
}, 60_000);

test('redirections and cp keep binary files byte-for-byte', async () => {
  await withShell(async (sh, fs) => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    await fs.writeFileBytes('/tmp/all.bin', bytes);
    const r = await sh('cat all.bin > piped.bin && cp all.bin copied.bin && cat all.bin >> piped.bin && echo "héllo ✓" > text.txt');
    expect(r.status).toBe(0);
    expect([...await fs.readFileBytes('/tmp/copied.bin')]).toEqual([...bytes]);
    expect([...await fs.readFileBytes('/tmp/piped.bin')]).toEqual([...bytes, ...bytes]);
    expect(await fs.readFile('/tmp/text.txt')).toBe('héllo ✓\n');
  });
}, 60_000);
