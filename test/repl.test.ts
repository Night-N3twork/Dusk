import { test, expect } from 'vitest';
import { createRunner } from '../src/host/runner';
import { createMemoryBackend } from '../src/host/fs-backend';
import { createFuncs } from '../src/host/funcs';
import { startRepl } from '../src/repl/repl';
import { bootRepl } from '../src/index';

test('repl evaluates a line and prints the result', async () => {
  const backend = createMemoryBackend();
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (t) => out.push(t)));
  const repl = startRepl(runner, (t) => out.push(t));
  await repl.feed('21 * 2\n');
  runner.stop();
  expect(out.join('')).toContain('42');
}, 60_000);

test('repl persists mutable let and var declarations across feeds', async () => {
  const backend = createMemoryBackend();
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (t) => out.push(t)));
  const repl = startRepl(runner, (t) => out.push(t));
  await repl.feed('let count = 1');
  await repl.feed('count += 1');
  await repl.feed('var label = "a"');
  await repl.feed('label += "b"');
  await repl.feed('process.stdout.write("VALUES=" + count + ":" + label + "\\n")');
  runner.stop();

  expect(out.join('')).toContain('VALUES=2:ab');
}, 60_000);

test('repl refuses to shadow globalThis and keeps the real global intact', async () => {
  const backend = createMemoryBackend();
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (t) => out.push(t)));
  const repl = startRepl(runner, (t) => out.push(t));
  await repl.feed('const globalThis = 1');
  await repl.feed('typeof globalThis.Object');
  runner.stop();

  expect(out.join('')).toContain("SyntaxError: Identifier 'globalThis' has already been declared");
  expect(out.join('')).toContain('function');
}, 60_000);

test('repl does not persist a declaration whose initializer throws', async () => {
  const backend = createMemoryBackend();
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (t) => out.push(t)));
  const repl = startRepl(runner, (t) => out.push(t));
  await repl.feed('const unavailable = (() => { throw new Error("boom"); })()');
  await repl.feed('unavailable');
  runner.stop();

  expect(out.join('')).toContain('ReferenceError: unavailable is not defined');
}, 60_000);

test('repl runs later expressions after a declaration initializer throws', async () => {
  const backend = createMemoryBackend();
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (t) => out.push(t)));
  const repl = startRepl(runner, (t) => out.push(t));
  await repl.feed('const unavailable = (() => { throw new Error("boom"); })()');
  await repl.feed('21 * 2');
  runner.stop();

  expect(out.join('')).toContain('42');
}, 60_000);

test('repl rejects const reassignment and redeclaration before a redeclared initializer runs', async () => {
  const backend = createMemoryBackend();
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (t) => out.push(t)));
  const repl = startRepl(runner, (t) => out.push(t));
  await repl.feed('const locked = 1');
  await repl.feed('locked = 2');
  await repl.feed('const locked = (() => { process.stdout.write("INITIALIZER_RAN\\n"); return 3; })()');
  await repl.feed('process.stdout.write("LOCKED=" + locked + "\\n")');
  runner.stop();

  expect(out.join('').match(/TypeError/g)).toHaveLength(1);
  expect(out.join('')).toContain('SyntaxError');
  expect(out.join('')).not.toContain('INITIALIZER_RAN');
  expect(out.join('')).toContain('LOCKED=1');
}, 60_000);

test('repl has no implementation binding object in the guest global', async () => {
  const backend = createMemoryBackend();
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (t) => out.push(t)));
  const repl = startRepl(runner, (t) => out.push(t));
  await repl.feed('typeof globalThis.__duskReplBindings');
  runner.stop();

  expect(out.join('')).toContain('undefined');
}, 60_000);

test('REPL evaluates an expression that ends with a semicolon', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed("process.stdout.write('SEMI:' + (1 + 1) + ':END');");
  repl.engine.terminate();
  expect(out.join('')).toContain('SEMI:2:END');
}, 60_000);
