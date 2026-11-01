import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

const run = async (code: string, wait = 100): Promise<string> => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(code);
  await new Promise((resolve) => setTimeout(resolve, wait));
  await repl.engine.terminate();
  return out.join('');
};

test('cpSync copies trees and honours force, errorOnExist and filter', async () => {
  const s = await run(
    "const fs = require('node:fs'); fs.mkdirSync('/src/a/b', { recursive: true }); fs.writeFileSync('/src/a/b/x.txt', 'x'); fs.writeFileSync('/src/skip.log', 'no'); fs.writeFileSync('/src/a/y.bin', Buffer.from([0, 255])); " +
    "fs.cpSync('/src', '/dst', { recursive: true, filter: (src) => !src.endsWith('.log') }); " +
    "let noRecursive = ''; try { fs.cpSync('/src', '/dst2'); } catch (e) { noRecursive = e.code; } " +
    "fs.writeFileSync('/dst/a/b/x.txt', 'changed'); fs.cpSync('/src', '/dst', { recursive: true, force: false, filter: (src) => !src.endsWith('.log') }); " +
    "let exists = ''; try { fs.cpSync('/src/a/b/x.txt', '/dst/a/b/x.txt', { force: false, errorOnExist: true }); } catch (e) { exists = e.code; } " +
    "process.stdout.write('C:' + [fs.readFileSync('/dst/a/b/x.txt', 'utf8'), fs.existsSync('/dst/skip.log'), Array.from(fs.readFileSync('/dst/a/y.bin')).join('-'), noRecursive, exists].join('|') + ':END');"
  );
  expect(s).toContain('C:changed|false|0-255|ERR_FS_EISDIR|ERR_FS_CP_EEXIST:END');
}, 60_000);

test('opendir iterates Dirent entries and readdir supports recursive', async () => {
  const s = await run(
    "const fs = require('node:fs'); fs.mkdirSync('/d/sub', { recursive: true }); fs.writeFileSync('/d/f.txt', ''); fs.writeFileSync('/d/sub/g.txt', ''); " +
    "(async () => { const dir = await fs.promises.opendir('/d'); const names = []; for await (const e of dir) names.push(e.name + (e.isDirectory() ? '/' : '') + '@' + e.parentPath); " +
    "const sync = fs.opendirSync('/d'); const first = sync.readSync(); sync.closeSync(); " +
    "process.stdout.write('O:' + names.sort().join(',') + '|' + (first && first.name) + '|' + fs.readdirSync('/d', { recursive: true }).sort().join(',') + ':END'); })();"
  );
  expect(s).toMatch(/O:f\.txt@\/d,sub\/@\/d\|(f\.txt|sub)\|f\.txt,sub,sub\/g\.txt:END/);
}, 60_000);

test('globSync matches **, braces, character classes and exclusions', async () => {
  const s = await run(
    "const fs = require('node:fs'); for (const p of ['/p/src/a.ts', '/p/src/b.js', '/p/src/deep/c.ts', '/p/test/d.ts', '/p/.hidden/e.ts', '/p/README.md']) { fs.mkdirSync(p.split('/').slice(0, -1).join('/'), { recursive: true }); fs.writeFileSync(p, ''); } " +
    "const a = fs.globSync('**/*.ts', { cwd: '/p' }).sort(); const b = fs.globSync('src/*.{ts,js}', { cwd: '/p' }).sort(); const c = fs.globSync('**/[ab].*', { cwd: '/p', exclude: ['src/b.js'] }).sort(); " +
    "const d = fs.globSync('/p/*.md'); " +
    "(async () => { const e = []; for await (const m of fs.promises.glob('test/*.ts', { cwd: '/p' })) e.push(m); " +
    "process.stdout.write('G:' + [a.join(','), b.join(','), c.join(','), d.join(','), e.join(',')].join('|') + ':END'); })();"
  );
  expect(s).toContain('G:src/a.ts,src/deep/c.ts,test/d.ts|src/a.ts,src/b.js|src/a.ts|/p/README.md|test/d.ts:END');
}, 60_000);

test('statfsSync reports storage blocks and fs.watch delivers renames through change listeners', async () => {
  const s = await run(
    "const fs = require('node:fs'); const st = fs.statfsSync('/'); const big = fs.statfsSync('/', { bigint: true }); " +
    "fs.mkdirSync('/w'); const events = []; const watcher = fs.watch('/w', (type, name) => events.push(type + ':' + name)); " +
    "setTimeout(() => fs.writeFileSync('/w/new.txt', 'x'), 20); " +
    "setTimeout(() => { watcher.close(); process.stdout.write('S:' + [st.bsize, st.blocks > 0, typeof big.blocks, events.some((e) => e.endsWith(':new.txt'))].join('|') + ':END'); }, 300);",
    600,
  );
  expect(s).toContain('S:4096|true|bigint|true:END');
}, 60_000);

test('fs.promises.watch yields events and stops on abort', async () => {
  const s = await run(
    "const fs = require('node:fs'); fs.writeFileSync('/pw.txt', 'a'); const ac = new AbortController(); " +
    "(async () => { const seen = []; setTimeout(() => fs.writeFileSync('/pw.txt', 'b'), 20); " +
    "try { for await (const ev of fs.promises.watch('/pw.txt', { signal: ac.signal })) { seen.push(ev.eventType); ac.abort(); } } catch (e) { seen.push(e.name); } " +
    "process.stdout.write('W:' + seen.join(',') + ':END'); })();",
    600,
  );
  expect(s).toContain('W:change,AbortError:END');
}, 60_000);
