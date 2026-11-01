import { test, expect } from 'vitest';
import { createVFS } from '../src/host/vfs';
import { createMemoryBackend } from '../src/host/fs-backend';
import { createRunner } from '../src/host/runner';
import { createFuncs } from '../src/host/funcs';

test('vfs round-trips files and dirs', () => {
  const vfs = createVFS();
  vfs.mkdir('/app', { recursive: true });
  vfs.writeFile('/app/a.txt', 'hello');
  expect(vfs.readFile('/app/a.txt')).toBe('hello');
  expect(vfs.readdir('/app')).toEqual(['a.txt']);
  expect(vfs.exists('/app/a.txt')).toBe(true);
  vfs.rm('/app/a.txt');
  expect(vfs.exists('/app/a.txt')).toBe(false);
});

test('require loads a module from the VFS', async () => {
  const backend = createMemoryBackend();
  await backend.writeFile('/dep.js', 'module.exports = 40 + 2;');
  await backend.writeFile('/main.js', 'console.log(require("./dep.js"));');
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (t) => out.push(t)));
  await runner.run(await backend.readFile('/main.js'));
  runner.stop();
  expect(out.join('')).toContain('42');
}, 60_000);

test('require retries CJS evaluation and JSON parsing after failures', async () => {
  const backend = createMemoryBackend();
  await backend.mkdir('/app', { recursive: true });
  await backend.writeFile('/app/throw.js', 'throw new Error("first");');
  await backend.writeFile('/app/data.json', '{');
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (text) => out.push(text)));
  await runner.run("for (const file of ['./app/throw.js', './app/data.json']) { try { require(file); } catch {} } ");
  await backend.writeFile('/app/throw.js', 'module.exports = "recovered-cjs";');
  await backend.writeFile('/app/data.json', '{"value":"recovered-json"}');
  await runner.run("console.log(require('./app/throw.js') + ':' + require('./app/data.json').value);");
  runner.stop();

  expect(out.join('')).toContain('recovered-cjs:recovered-json');
}, 60_000);

test('createRequire resolves relative requests from its filename', async () => {
  const backend = createMemoryBackend();
  await backend.mkdir('/app/lib', { recursive: true });
  await backend.writeFile('/app/lib/dep.js', 'module.exports = "relative";');
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (text) => out.push(text)));
  await runner.run("const req = require('node:module').createRequire('/app/lib/main.js'); console.log(req('./dep.js') + ':' + req.resolve('./dep.js')); ");
  runner.stop();

  expect(out.join('')).toContain('relative:/app/lib/dep.js');
}, 60_000);

test('require loads resolved ESM modules synchronously', async () => {
  const backend = createMemoryBackend();
  await backend.writeFile('/module.mjs', 'export default 1; export const named = "n";');
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (text) => out.push(text)));
  await runner.run("try { const m = require('./module.mjs'); console.log('ESM:' + m.default + ':' + m.named); } catch (error) { console.log(String(error)); }");
  runner.stop();

  expect(out.join('')).toContain('ESM:1:n');
}, 60_000);

test('require exposes TLS aliases through the builtin-module facade', async () => {
  const backend = createMemoryBackend();
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (text) => out.push(text)));
  await runner.run("const tls = require('tls'); const nodeTls = require('node:tls'); const modules = require('node:module').builtinModules; console.log((tls === nodeTls) + ':' + modules.includes('tls'));");
  runner.stop();

  expect(out.join('')).toContain('true:true');
}, 60_000);
