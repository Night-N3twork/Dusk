import { test, expect } from 'vitest';
import { bootRepl, createAllowList } from '../src/index';
import { ProcessManager } from '../src/host/process-manager';
import { createMemoryBackend } from '../src/host/fs-backend';
import type { TcpProvider } from '../src/host/tcp';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

test('ProcessManager emits spawn, stdout and exit events', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/hello', "process.stdout.write('hi\\n'); process.stderr.write('err\\n'); process.exit(3);");
  const events: string[] = [];
  const off = pm.on('spawn', (e) => events.push(`spawn:${e.command}:${e.args.join(',')}`));
  pm.on('stdout', (e) => events.push(`stdout:${decode(e.chunk).trim()}`));
  pm.on('stderr', (e) => events.push(`stderr:${decode(e.chunk).trim()}`));
  pm.on('exit', (e) => events.push(`exit:${e.code}`));
  const proc = await pm.spawn('/bin/hello', ['a'], { cwd: '/' });
  await new Response(proc.stdout).text();
  await proc.exit;
  off();
  await pm.spawnSync('/bin/hello', [], { cwd: '/' });
  expect(events.slice(0, 4)).toEqual(['spawn:/bin/hello:a', 'stdout:hi', 'stderr:err', 'exit:3']);
  expect(events.filter((e) => e.startsWith('spawn:')).length).toBe(1);
  expect(events.filter((e) => e === 'exit:3').length).toBe(2);
}, 60_000);

test('limits cap concurrent processes, wall-clock time and output size', async () => {
  const pm = new ProcessManager(createMemoryBackend(), {}, {}, { limits: { maxProcesses: 1, timeoutMs: 300, maxOutputBytes: 64 } });
  pm.registerBinary('/bin/forever', 'setInterval(() => {}, 1000);');
  pm.registerBinary('/bin/noisy', "for (let i = 0; i < 100; i++) process.stdout.write('0123456789'); process.exit(0);");
  const exits: Array<{ code: number; signal?: string }> = [];
  pm.on('exit', (e) => exits.push(e));
  const first = await pm.spawn('/bin/forever', [], { cwd: '/' });
  await expect(pm.spawn('/bin/forever', [], { cwd: '/' })).rejects.toMatchObject({ code: 'EAGAIN' });
  const started = Date.now();
  await first.exit;
  expect(Date.now() - started).toBeLessThan(5000);
  const noisy = await pm.spawnSync('/bin/noisy', [], { cwd: '/' });
  expect(noisy.stdout.length).toBeLessThanOrEqual(64);
  expect(exits.map((e) => e.signal)).toEqual(['SIGKILL', 'SIGXFSZ']);
}, 60_000);

test('createAllowList matches hosts, wildcards, ports and schemes', () => {
  const allow = createAllowList(['registry.npmjs.org', '*.example.com:443', 'wss://relay.test', '[::1]:8080']);
  expect(allow({ protocol: 'https:', host: 'registry.npmjs.org', port: 443 })).toBe(true);
  expect(allow({ protocol: 'https:', host: 'api.example.com', port: 443 })).toBe(true);
  expect(allow({ protocol: 'https:', host: 'example.com', port: 443 })).toBe(false);
  expect(allow({ protocol: 'http:', host: 'api.example.com', port: 80 })).toBe(false);
  expect(allow({ protocol: 'wss:', host: 'relay.test', port: 443 })).toBe(true);
  expect(allow({ protocol: 'https:', host: 'relay.test', port: 443 })).toBe(false);
  expect(allow({ protocol: 'tcp:', host: '::1', port: 8080 })).toBe(true);
}, 60_000);

test('network allowlist blocks outbound TCP outside the policy', async () => {
  const opened: string[] = [];
  const tcpProvider: TcpProvider = {
    open: async (host, port) => {
      opened.push(`${host}:${port}`);
      throw new Error('ECONNREFUSED');
    },
  };
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory', net: { tcpProvider, allow: ['allowed.test'] } });
  await repl.feed(
    "const net = require('node:net'); const results = []; const tryConnect = (host) => new Promise((resolve) => { const s = net.connect(80, host); s.on('error', (e) => { results.push(host + '=' + (String(e.message).includes('ERR_DUSK_NETWORK_BLOCKED') ? 'blocked' : 'attempted')); resolve(); }); }); " +
    "tryConnect('blocked.test').then(() => tryConnect('allowed.test')).then(() => process.stdout.write('N:' + results.join(',') + ':END'));"
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  await repl.dispose();
  expect(out.join('')).toContain('N:blocked.test=blocked,allowed.test=attempted:END');
  expect(opened).toEqual(['allowed.test:80']);
}, 60_000);

test('dispose stops running processes and rejects new spawns', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  repl.processManager.registerBinary('/bin/forever', 'setInterval(() => {}, 1000);');
  const proc = await repl.processManager.spawn('/bin/forever', [], { cwd: '/' });
  await repl.dispose();
  await proc.exit;
  expect(repl.processManager.activePids()).toEqual([]);
  await expect(repl.processManager.spawn('/bin/forever')).rejects.toThrow('disposed');
}, 60_000);
