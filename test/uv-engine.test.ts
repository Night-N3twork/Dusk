// The real uv engine: Dusk's own worker, the real ~18 MiB wasm, no fakes.
// Proves the bundler emits and serves the worker, the engine module and its
// wasm, and that uv itself runs. Offline: nothing here reaches an index.

import { afterAll, expect, test } from 'vitest';
import { createMemoryBackend } from '../src/host/fs-backend';
import { ProcessManager } from '../src/host/process-manager';
import { createUvHost } from '../src/host/uv';

const decoder = new TextDecoder();
const fs = createMemoryBackend();
const uv = createUvHost({
  fs,
  loadPyodide: () => Promise.reject(new Error('no source builds in this test')),
  options: { cache: { kind: 'memory' } },
});
const pm = new ProcessManager(fs);
pm.registerStreamingHostBinary('/bin/uv', uv.uv);

afterAll(async () => { await uv.dispose(); });

const run = async (args: string[], cwd = '/home/user/proj') => {
  const result = await pm.spawnSync('/bin/uv', args, { cwd, env: { HOME: '/home/user' } });
  return { status: result.status, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
};

test('boots the real engine and runs uv', async () => {
  await fs.mkdir('/home/user/proj', { recursive: true });
  await fs.writeFile('/home/user/proj/requirements.txt', '');
  const result = await run(['--version']);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/^uv \d+\.\d+\.\d+/);
}, 120_000);

test('creates a venv that lands in Dusk\'s filesystem', async () => {
  const result = await run(['venv', '--quiet']);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(await fs.readFile('/home/user/proj/.venv/pyvenv.cfg')).toContain('version_info = 3.14');
  const lib = await fs.readdir('/home/user/proj/.venv/lib');
  expect(lib.some((name) => /^python3\.\d+$/.test(name))).toBe(true);
}, 120_000);

test('sees a requirements file written in Dusk', async () => {
  await fs.writeFile('/home/user/proj/requirements.in', 'idna==3.11\n');
  // --offline: resolution fails for want of the index, and says which file it read.
  const result = await run(['pip', 'compile', '--offline', 'requirements.in']);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('idna');
}, 120_000);

test('holds every request uv makes to the network policy', async () => {
  const asked: string[] = [];
  const guarded = createUvHost({
    fs,
    loadPyodide: () => Promise.reject(new Error('unused')),
    options: { cache: { kind: 'memory' } },
    networkPolicy: (target) => { asked.push(`${target.protocol}//${target.host}:${target.port}`); return false; },
  });
  const guardedPm = new ProcessManager(fs);
  guardedPm.registerStreamingHostBinary('/bin/uv', guarded.uv);
  try {
    const result = await guardedPm.spawnSync('/bin/uv', ['pip', 'compile', 'requirements.in'], { cwd: '/home/user/proj', env: { HOME: '/home/user' } });
    expect(result.status).not.toBe(0);
    expect(asked).toContain('https://pypi.org:443');
  } finally {
    await guarded.dispose();
  }
}, 120_000);

test('refuses a transport the policy cannot see into', async () => {
  const guarded = createUvHost({
    fs,
    loadPyodide: () => Promise.reject(new Error('unused')),
    options: { transport: { kind: 'libcurl', moduleUrl: 'https://example.invalid/libcurl.mjs', relayUrl: 'wss://example.invalid/' } },
    networkPolicy: () => true,
  });
  const guardedPm = new ProcessManager(fs);
  guardedPm.registerStreamingHostBinary('/bin/uv', guarded.uv);
  const result = await guardedPm.spawnSync('/bin/uv', ['--version'], { cwd: '/home/user/proj' });
  expect(result.status).toBe(1);
  expect(decoder.decode(result.stderr)).toContain('cannot be held to net.allow');
}, 30_000);
