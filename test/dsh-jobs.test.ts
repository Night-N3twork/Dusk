import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';
import type { FSBackend } from '../src/host/fs-backend';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const pump = async (stream: ReadableStream<Uint8Array>, into: (s: string) => void): Promise<void> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) into(decoder.decode(value, { stream: true }));
    }
  } catch { }
};

const shell = async (options: { home?: string } = {}) => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  const env: Record<string, string> = { PATH: '/bin', ...(options.home ? { HOME: options.home } : {}) };
  const start = async () => {
    const sh = await repl.processManager.spawn('/bin/dsh', [], { cwd: '/', env, pty: { cols: 80, rows: 24 } });
    let buf = '';
    void pump(sh.stdout, (s) => { buf += s; });
    void pump(sh.stderr, (s) => { buf += s; });
    const encoder = new TextEncoder();
    const mark = () => buf.length;
    const output = (from = 0) => buf.slice(from);
    const waitFor = async (pattern: string | RegExp, from = 0, ms = 8000): Promise<string> => {
      const deadline = Date.now() + ms;
      const found = () => (typeof pattern === 'string' ? buf.indexOf(pattern, from) !== -1 : pattern.test(buf.slice(from)));
      while (!found() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      if (!found()) throw new Error(`timed out waiting for ${String(pattern)} in ${JSON.stringify(buf.slice(from))}`);
      return buf.slice(from);
    };
    const type = (text: string) => sh.stdin.write(encoder.encode(text));
    const stop = async () => {
      await sh.stdin.close();
      await Promise.race([sh.exit, new Promise((r) => setTimeout(r, 1500))]);
      sh.kill();
    };
    await waitFor('dsh$ ');
    return { sh, mark, output, waitFor, type, stop, pid: sh.pid };
  };
  return { repl, start };
};

test('dsh -c runs background jobs concurrently and wait collects them', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  try {
    const script = '(sleep 0.3; echo late) & echo early; wait; echo "pid:$!"; sleep 0.05 & wait %1; echo "status:$?"';
    const r = await repl.processManager.spawnSync('/bin/dsh', ['-c', script], { cwd: '/' });
    const out = decode(r.stdout);
    expect(decode(r.stderr)).toBe('');
    expect(out.indexOf('early')).toBeLessThan(out.indexOf('late'));
    expect(out).toMatch(/pid:\d+/);
    expect(out).toContain('status:0');
  } finally {
    await repl.dispose();
  }
}, 60_000);

test('interactive dsh lists, stops, resumes and reports jobs', async () => {
  const { repl, start } = await shell();
  const s = await start();
  try {
    let at = s.mark();
    await s.type('sleep 30 &\n');
    await s.waitFor(/\[1\] \d+/, at);
    at = s.mark();
    await s.type('jobs\n');
    await s.waitFor(/\[1\]\+\s+Running\s+sleep 30 &/, at);

    at = s.mark();
    await s.type('kill -STOP %1\n');
    await s.waitFor(/\[1\]\+\s+Stopped\s+sleep 30/, at);
    at = s.mark();
    await s.type('bg\n');
    await s.waitFor('[1]+ sleep 30 &', at);

    at = s.mark();
    await s.type('(sleep 0.4; echo late-output) &\n');
    await s.waitFor(/\[2\] \d+/, at);
    at = s.mark();
    await s.type('fg %2\n');
    await s.waitFor('(sleep 0.4; echo late-output)\n', at);
    await s.type('\x1a');
    await s.waitFor(/\[2\]\+\s+Stopped/, at);
    await new Promise((r) => setTimeout(r, 900));
    expect(s.output(at)).not.toContain('late-output\n');

    at = s.mark();
    await s.type('fg\n');
    await s.waitFor('late-output\n', at);

    at = s.mark();
    await s.type('kill %1\n');
    await s.waitFor('dsh$ ', at);
    await new Promise((r) => setTimeout(r, 300));
    at = s.mark();
    await s.type('true\n');
    await s.waitFor(/\[1\]\+?\s+Terminated\s+sleep 30/, at);
  } finally {
    await s.stop();
    await repl.dispose();
  }
}, 60_000);

test('^C interrupts the foreground command without killing dsh', async () => {
  const { repl, start } = await shell();
  const s = await start();
  try {
    let at = s.mark();
    await s.type('sleep 20; echo should-not-print\n');
    await new Promise((r) => setTimeout(r, 200));
    await s.type('\x03');
    await s.waitFor('dsh$ ', at);
    const later = s.mark();
    await s.type('echo "code:$?"\n');
    await s.waitFor('code:130', later);
    expect(s.output(at)).not.toContain('should-not-print\n');
  } finally {
    await s.stop();
    await repl.dispose();
  }
}, 60_000);

test('line editor recalls history, edits in place and persists history to HOME', async () => {
  const { repl, start } = await shell({ home: '/home/user' });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  const first = await start();
  try {
    let at = first.mark();
    await first.type('echo first-entry\r');
    await first.waitFor('first-entry\n', at);
    at = first.mark();
    await first.type('echo second\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D-\r');
    await first.waitFor('-second', at);
    at = first.mark();
    await first.type('\x1b[A\x1b[A\x01\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x0bX\r');
    await first.waitFor('X\n', at);
  } finally {
    await first.stop();
  }
  const saved = await fs.readFile('/home/user/.dsh_history');
  expect(saved.split('\n').filter(Boolean)).toEqual(['echo first-entry', 'echo -second', 'echo X']);

  const second = await start();
  try {
    const at = second.mark();
    await second.type('\x1b[A\x1b[A\r');
    await second.waitFor('-second', at);
    const bang = second.mark();
    await second.type('!echo\r');
    await second.waitFor('-second', bang);
  } finally {
    await second.stop();
    await repl.dispose();
  }
}, 60_000);

test('tab completes commands, paths and variables', async () => {
  const { repl, start } = await shell({ home: '/tmp' });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  await fs.mkdir('/tmp/completion-dir', { recursive: true });
  await fs.writeFile('/tmp/completion-dir/alpha.txt', 'A');
  await fs.writeFile('/tmp/completion-dir/alpine.txt', 'B');
  const s = await start();
  try {
    let at = s.mark();
    await s.type('ech\t /tmp/completion-d\talpha\t\r');
    await s.waitFor('/tmp/completion-dir/alpha.txt\n', at);

    at = s.mark();
    await s.type('cat /tmp/completion-dir/al\t\t');
    await s.waitFor(/alpha\.txt\s+alpine\.txt/, at);
    await s.type('\x15echo $HO\t\r');
    await s.waitFor('/tmp\n', at);
  } finally {
    await s.stop();
    await repl.dispose();
  }
}, 60_000);
