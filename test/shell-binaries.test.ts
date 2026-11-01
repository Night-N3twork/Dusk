import { test, expect } from 'vitest';
import { ProcessManager } from '../src/host/process-manager';
import { createMemoryBackend } from '../src/host/fs-backend';

test('/bin/sh -c echo hello via ProcessManager', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const result = await pm.spawnSync('/bin/sh', ['-c', 'echo hello'], { cwd: '/' });
  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('hello\n');
}, 60_000);

test('/bin/sh -c exit 3 propagates exit code', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const result = await pm.spawnSync('/bin/sh', ['-c', 'exit 3'], { cwd: '/' });
  expect(result.status).toBe(3);
}, 60_000);

test('/bin/sh -c dispatches to /bin/echo external binary', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  let captured = '';
  const write = (text: string) => { captured += text; };
  const engine = await pm.createPidZero({}, write);
  await engine.run(`
const cp = require('child_process');
const r = cp.spawnSync('/bin/sh', ['-c', '/bin/echo hi']);
process.stdout.write('status=' + r.status + ' out=' + String.fromCharCode.apply(null, Array.from(r.stdout)));
`);
  await engine.terminate();
  expect(captured).toContain('status=0');
  expect(captured).toContain('hi');
}, 120_000);

test('/bin/sh -c true && /bin/echo ok runs second command', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  let captured = '';
  const write = (text: string) => { captured += text; };
  const engine = await pm.createPidZero({}, write);
  await engine.run(`
const cp = require('child_process');
const r = cp.spawnSync('/bin/sh', ['-c', 'true && /bin/echo ok']);
process.stdout.write('status=' + r.status + ' out=' + String.fromCharCode.apply(null, Array.from(r.stdout)));
`);
  await engine.terminate();
  expect(captured).toContain('status=0');
  expect(captured).toContain('ok');
}, 120_000);

test('/bin/pwd prints cwd option', async () => {
  const backend = createMemoryBackend();
  await backend.mkdir('/var/work', { recursive: true });
  const pm = new ProcessManager(backend);
  const result = await pm.spawnSync('/bin/pwd', [], { cwd: '/var/work' });
  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('/var/work\n');
}, 60_000);

test('/bin/sh -c echo $1 x y prints y', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const result = await pm.spawnSync('/bin/sh', ['-c', 'echo $1', 'x', 'y'], { cwd: '/' });
  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('y\n');
}, 60_000);

test('/bin/sh -c echo $# a b c prints 2', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const result = await pm.spawnSync('/bin/sh', ['-c', 'echo $#', 'a', 'b', 'c'], { cwd: '/' });
  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('2\n');
}, 60_000);

test('/bin/false via ProcessManager exits 1', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const result = await pm.spawnSync('/bin/false', [], { cwd: '/' });
  expect(result.status).toBe(1);
}, 60_000);

test('/bin/env via ProcessManager prints env entries', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const result = await pm.spawnSync('/bin/env', [], { cwd: '/', env: { FOO: 'bar' } });
  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toContain('FOO=bar\n');
}, 60_000);

test('/bin/cat via ProcessManager with no stdin exits cleanly', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const result = await pm.spawnSync('/bin/cat', [], { cwd: '/' });
  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('');
}, 60_000);

test('/bin/cat via ProcessManager with stdin echoes input', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const result = await pm.spawnSync('/bin/cat', [], { cwd: '/', stdin: new TextEncoder().encode('hello\n') });
  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('hello\n');
}, 60_000);

test('/bin/sh -c echo hi | /bin/cat pipes stdin to external cat', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const result = await pm.spawnSync('/bin/sh', ['-c', 'echo hello | /bin/cat'], { cwd: '/' });
  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('hello\n');
}, 120_000);

test('/bin/cat via ProcessManager handles large (32KB) stdin payload', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const size = 32 * 1024;
  const input = new Uint8Array(size);
  for (let i = 0; i < size; i++) input[i] = (i * 31 + 7) & 0xff;
  const result = await pm.spawnSync('/bin/cat', [], { cwd: '/', stdin: input });
  expect(result.status).toBe(0);
  expect(result.stdout.length).toBe(size);
  for (let i = 0; i < size; i++) expect(result.stdout[i]).toBe(input[i]);
}, 120_000);
