import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

const run = async (code: string): Promise<string> => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(code);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await repl.engine.terminate();
  return out.join('');
};

test('readFileSync and writeFileSync round-trip arbitrary bytes', async () => {
  const s = await run(
    "const fs = require('node:fs'); const data = new Uint8Array(256).map((_, i) => i); " +
    "fs.writeFileSync('/tmp/bin.dat', data); const back = fs.readFileSync('/tmp/bin.dat'); " +
    "fs.copyFileSync('/tmp/bin.dat', '/tmp/copy.dat'); const copy = fs.readFileSync('/tmp/copy.dat'); " +
    "fs.appendFileSync('/tmp/bin.dat', Buffer.from([255, 0])); const appended = fs.readFileSync('/tmp/bin.dat'); " +
    "fs.truncateSync('/tmp/bin.dat', 4); const truncated = fs.readFileSync('/tmp/bin.dat'); " +
    "const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]); " +
    "process.stdout.write('B:' + same(back, data) + '|' + same(copy, data) + '|' + appended.length + ',' + appended[257] + '|' + Array.from(truncated).join(',') + ':END');"
  );
  expect(s).toContain('B:true|true|258,0|0,1,2,3:END');
}, 60_000);

test('readFileSync honours encodings and the flag option', async () => {
  const s = await run(
    "const fs = require('node:fs'); fs.writeFileSync('/tmp/t.txt', 'héllo'); " +
    "const hex = fs.readFileSync('/tmp/t.txt', 'hex'); const b64 = fs.readFileSync('/tmp/t.txt', { encoding: 'base64' }); " +
    "fs.writeFileSync('/tmp/t.txt', '!', { flag: 'a' }); let exclusive = ''; " +
    "try { fs.writeFileSync('/tmp/t.txt', 'x', { flag: 'wx' }); } catch (e) { exclusive = e.code; } " +
    "process.stdout.write('E:' + hex + '|' + b64 + '|' + fs.readFileSync('/tmp/t.txt', 'utf8') + '|' + exclusive + ':END');"
  );
  expect(s).toContain('E:68c3a96c6c6f|aMOpbGxv|héllo!|EEXIST:END');
}, 60_000);

test('readFileSync reads files larger than one IPC frame', async () => {
  const s = await run(
    "const fs = require('node:fs'); const big = new Uint8Array(9 * 1024 * 1024); for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) & 0xff; " +
    "fs.writeFileSync('/tmp/big.bin', big); const back = fs.readFileSync('/tmp/big.bin'); let ok = back.length === big.length; " +
    "for (let i = 0; ok && i < big.length; i += 4096) ok = back[i] === big[i]; process.stdout.write('L:' + ok + ':END');"
  );
  expect(s).toContain('L:true:END');
}, 120_000);
