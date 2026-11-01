import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

const run = async (seed: Record<string, string>, code: string): Promise<string> => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory', seed });
  await repl.feed(code);
  await new Promise((resolve) => setTimeout(resolve, 100));
  repl.engine.terminate();
  return out.join('');
};

test('require() loads a synchronous ES module graph', async () => {
  const s = await run({
    '/app/dep.mjs': 'export const base = 40;',
    '/app/lib.mjs': "import { base } from './dep.mjs'; import path from 'node:path'; export default function add(n) { return base + n; } export const sep = path.sep; export const file = import.meta.filename; export const dir = import.meta.dirname;",
  }, "const lib = require('/app/lib.mjs'); process.stdout.write('E:' + lib.default(2) + '|' + lib.sep + '|' + lib.file + '|' + lib.dir + ':END');");
  expect(s).toContain('E:42|/|/app/lib.mjs|/app:END');
}, 60_000);

test('require() honours a "module.exports" export from an ES module', async () => {
  const s = await run({
    '/app/fn.mjs': "function hello() { return 'hi'; } export { hello as 'module.exports' };",
  }, "const fn = require('/app/fn.mjs'); process.stdout.write('F:' + typeof fn + '|' + fn() + ':END');");
  expect(s).toContain('F:function|hi:END');
}, 60_000);

test('require() rejects ES modules that use top-level await', async () => {
  const s = await run({
    '/app/tla.mjs': 'export const x = await Promise.resolve(1);',
  }, "try { require('/app/tla.mjs'); process.stdout.write('T:loaded:END'); } catch (e) { process.stdout.write('T:' + String(e.message).includes('ERR_REQUIRE_ASYNC_MODULE') + ':END'); }");
  expect(s).toContain('T:true:END');
}, 60_000);

test('process.getBuiltinModule returns core modules and undefined for unknown ids', async () => {
  const s = await run({}, "process.stdout.write('B:' + (process.getBuiltinModule('node:path') === require('node:path')) + '|' + (process.getBuiltinModule('fs') === require('fs')) + '|' + process.getBuiltinModule('left-pad') + ':END');");
  expect(s).toContain('B:true|true|undefined:END');
}, 60_000);

test('import.meta exposes filename, dirname and a synchronous resolve', async () => {
  const s = await run({
    '/app/meta.mjs': "export const info = [import.meta.filename, import.meta.dirname, import.meta.resolve('./meta.mjs'), import.meta.resolve('fs')].join('|');",
  }, "import('/app/meta.mjs').then((m) => process.stdout.write('M:' + m.info + ':END'));");
  expect(s).toContain('M:/app/meta.mjs|/app|file:///app/meta.mjs|node:fs:END');
}, 60_000);
