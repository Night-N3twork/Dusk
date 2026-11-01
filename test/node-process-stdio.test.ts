import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

// In the REPL (pid 0), process.stdout / process.stderr
// must be a real Writable backed by the host stream registry — not the
// synchronous proc.write fallback. Concretely: it must expose the Writable
// EventEmitter surface (`.on`, `.once`, etc.) AND writes must reach the
// host's print sink.

test('REPL process.stdout is a Writable and delivers writes to the host sink', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "process.stdout.write('hi');" +
    "process.stdout.write('bye');" +
    "console.error('stdout-is-writable=' + (typeof process.stdout.on === 'function'));\n"
  );
  repl.engine.terminate();
  const text = out.join('');
  expect(text).toContain('hi');
  expect(text).toContain('bye');
  expect(text).toContain('stdout-is-writable=true');
}, 60_000);

test('REPL process.stderr is a Writable and delivers writes to the host sink', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "process.stderr.write('err1');" +
    "process.stderr.write('err2');" +
    "console.error('stderr-is-writable=' + (typeof process.stderr.on === 'function'));\n"
  );
  repl.engine.terminate();
  const text = out.join('');
  expect(text).toContain('err1');
  expect(text).toContain('err2');
  expect(text).toContain('stderr-is-writable=true');
}, 60_000);

test('spawned process.stdin exposes EventEmitter listeners', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });

  try {
    const process = await repl.processManager.spawn('/bin/node', ['-e', "process.stdin.on('data', () => {}); process.stdout.write('ready');"]);
    const reader = process.stdout.getReader();
    const output = await reader.read();
    expect(new TextDecoder().decode(output.value)).toBe('ready');
    await expect(process.exit).resolves.toBe(0);
  } finally {
    await repl.engine.terminate();
  }
}, 60_000);
