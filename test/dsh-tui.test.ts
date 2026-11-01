import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';
import type { FSBackend } from '../src/host/fs-backend';

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

const session = async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  const sh = await repl.processManager.spawn('/bin/dsh', [], { cwd: '/tmp', env: { PATH: '/bin', HOME: '/tmp' }, pty: { cols: 80, rows: 24 } });
  let buf = '';
  void pump(sh.stdout, (s) => { buf += s; });
  void pump(sh.stderr, (s) => { buf += s; });
  const encoder = new TextEncoder();
  const mark = () => buf.length;
  const waitFor = async (pattern: string | RegExp, from = 0, ms = 8000): Promise<string> => {
    const deadline = Date.now() + ms;
    const found = () => (typeof pattern === 'string' ? buf.indexOf(pattern, from) !== -1 : pattern.test(buf.slice(from)));
    while (!found() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    if (!found()) throw new Error(`timed out waiting for ${String(pattern)} in ${JSON.stringify(buf.slice(from).slice(-1500))}`);
    return buf.slice(from);
  };
  const type = async (...keys: string[]) => {
    for (const key of keys) {
      await sh.stdin.write(encoder.encode(key));
      await new Promise((r) => setTimeout(r, 60));
    }
  };
  const stop = async () => {
    await sh.stdin.close();
    await Promise.race([sh.exit, new Promise((r) => setTimeout(r, 1500))]);
    sh.kill();
    await repl.dispose();
  };
  await waitFor('dsh$ ');
  return { fs, mark, waitFor, type, stop };
};

test('less pages piped input, searches and quits back to the prompt', async () => {
  const s = await session();
  try {
    let at = s.mark();
    await s.type('seq 1 200 | less\r');
    await s.waitFor('\x1b[?1049h', at);
    await s.waitFor(/23\x1b\[0m\x1b\[K\r\n\x1b\[24;1H\x1b\[7m:/, at);
    at = s.mark();
    await s.type('G');
    await s.waitFor('(END)', at);
    await s.waitFor('200', at);
    at = s.mark();
    await s.type('?', '150', '\r');
    await s.waitFor('\x1b[7m150\x1b[27m', at);
    at = s.mark();
    await s.type('q');
    await s.waitFor('\x1b[?1049l', at);
    await s.waitFor('dsh$ ', at);
  } finally {
    await s.stop();
  }
}, 60_000);

test('less without a terminal behaves like cat', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  try {
    const r = await repl.processManager.spawnSync('/bin/dsh', ['-c', 'printf "a\\nb\\n" | less'], { cwd: '/' });
    expect(new TextDecoder().decode(r.stdout)).toBe('a\nb\n');
  } finally {
    await repl.dispose();
  }
}, 60_000);

test('nano edits and writes a file', async () => {
  const s = await session();
  try {
    await s.fs.writeFile('/tmp/notes.txt', 'first line\n');
    let at = s.mark();
    await s.type('nano notes.txt\r');
    await s.waitFor('Dusk nano', at);
    await s.type('\x05', '\r', 'second line', '\x1b[A', '\x05', '!');
    at = s.mark();
    await s.type('\x0f');
    await s.waitFor('File Name to Write:', at);
    at = s.mark();
    await s.type('\r');
    await s.waitFor('Wrote 2 lines', at);
    at = s.mark();
    await s.type('\x18');
    await s.waitFor('dsh$ ', at);
    expect(await s.fs.readFile('/tmp/notes.txt')).toBe('first line!\nsecond line\n');
  } finally {
    await s.stop();
  }
}, 60_000);

test('vi inserts, deletes, undoes and writes with :wq', async () => {
  const s = await session();
  try {
    await s.fs.writeFile('/tmp/code.txt', 'alpha\nbeta\ngamma\n');
    let at = s.mark();
    await s.type('vi code.txt\r');
    await s.waitFor('"code.txt"', at);
    await s.type('j', 'dd', 'u', 'dd', 'G', 'o', 'delta', '\x1b', 'gg', 'A', '!', '\x1b');
    await s.type(':%s/a/A/g', '\r');
    at = s.mark();
    await s.type(':wq', '\r');
    await s.waitFor('dsh$ ', at);
    expect(await s.fs.readFile('/tmp/code.txt')).toBe('AlphA!\ngAmmA\ndeltA\n');
  } finally {
    await s.stop();
  }
}, 60_000);
