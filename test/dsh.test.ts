import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

const decode = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
};

// Sanity: /bin/dsh -c 'echo hello' — the simplest possible smoke test.
test('/bin/dsh -c "echo hello" prints hello', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync('/bin/dsh', ['-c', 'echo hello'], { cwd: '/' });
  expect(r.status).toBe(0);
  expect(decode(r.stdout).trim()).toBe('hello');
  repl.engine.terminate();
}, 60_000);

// grep from just-bash's command set: run a script that writes a file into
// TFS (via `>`) and then greps it. dsh backs writes with TfsFs, so this
// round-trip goes through the real filesystem, not an in-memory snapshot.
test('/bin/dsh: write then grep round-trip via in-memory shell', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync('/bin/dsh', ['-c', 'printf "apple\\nbanana\\ncherry\\n" > /tmp/fruits && grep -c a /tmp/fruits'], { cwd: '/' });
  expect(r.status).toBe(0);
  // 3 fruits contain 'a' (apple, banana) — grep -c prints the count.
  expect(decode(r.stdout).trim()).toBe('2');
  repl.engine.terminate();
}, 60_000);

// dsh reads DuskJS's preloaded files: seed /etc/hostname via bootRepl seed,
// then have dsh cat it.
test('/bin/dsh preloads DuskJS filesystem: cat /etc/hostname works', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync('/bin/dsh', ['-c', 'cat /etc/hostname'], { cwd: '/' });
  expect(r.status).toBe(0);
  // /etc/hostname is seeded by fs-layout with something like "duskjs\n".
  expect(decode(r.stdout).length).toBeGreaterThan(0);
  repl.engine.terminate();
}, 60_000);

// sed: another just-bash command that DuskJS's shell v2 doesn't provide.
test('/bin/dsh: sed s/// substitution', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync('/bin/dsh', ['-c', 'echo hello world | sed "s/world/dusk/"'], { cwd: '/' });
  expect(r.status).toBe(0);
  expect(decode(r.stdout).trim()).toBe('hello dusk');
  repl.engine.terminate();
}, 60_000);

// awk: field processing.
test('/bin/dsh: awk field print', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync('/bin/dsh', ['-c', 'echo "a b c" | awk "{print \\$2}"'], { cwd: '/' });
  expect(r.status).toBe(0);
  expect(decode(r.stdout).trim()).toBe('b');
  repl.engine.terminate();
}, 60_000);

// sort + uniq pipeline.
test('/bin/dsh: sort | uniq -c', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync('/bin/dsh', ['-c', 'printf "b\\na\\nb\\nc\\na\\n" | sort | uniq -c'], { cwd: '/' });
  expect(r.status).toBe(0);
  // Expected (a=2, b=2, c=1) — but format varies. Assert all three lines and counts.
  const text = decode(r.stdout);
  expect(text).toMatch(/2\s+a/);
  expect(text).toMatch(/2\s+b/);
  expect(text).toMatch(/1\s+c/);
  repl.engine.terminate();
}, 60_000);

// --version and --help sanity.
test('/bin/dsh --version prints a version', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync('/bin/dsh', ['--version'], { cwd: '/' });
  expect(r.status).toBe(0);
  expect(decode(r.stdout)).toMatch(/dsh.*\d+\.\d+\.\d+/);
  repl.engine.terminate();
}, 60_000);

// Top-level dsh-wrapper binaries: users can call /bin/grep directly instead
// of dsh -c 'grep ...'. These are thin wrappers that shell out to /bin/dsh.
test('/bin/grep as top-level binary: string match in file', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  // Seed a file via dsh, then grep it via /bin/grep directly.
  await repl.processManager.spawnSync('/bin/dsh', ['-c', 'printf "apple\\nbanana\\ncherry\\n" > /tmp/f'], { cwd: '/' });
  // dsh writes to TFS now, so files persist across invocations. This
  // grep-of-file should succeed.
  const r = await repl.processManager.spawnSync('/bin/grep', ['banana', '/tmp/f'], { cwd: '/' });
  expect(r.status).toBe(0);
  expect(decode(r.stdout).trim()).toBe('banana');
  // Pipe-mode via stdin also works.
  const r2 = await repl.processManager.spawnSync('/bin/grep', ['banana'], {
    cwd: '/',
    stdin: new TextEncoder().encode('apple\nbanana\ncherry\n'),
  });
  expect(r2.status).toBe(0);
  expect(decode(r2.stdout).trim()).toBe('banana');
  repl.engine.terminate();
}, 60_000);

test('/bin/sort as top-level binary: sorts stdin', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync('/bin/sort', [], {
    cwd: '/',
    stdin: new TextEncoder().encode('banana\napple\ncherry\n'),
  });
  expect(r.status).toBe(0);
  expect(decode(r.stdout)).toBe('apple\nbanana\ncherry\n');
  repl.engine.terminate();
}, 60_000);

// Aliases: /bin/sh and /bin/jsh both point to dsh. Sanity that the alias
// registration works and behaves identically.
test('/bin/sh is an alias for /bin/dsh', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync('/bin/sh', ['-c', 'echo via-sh-alias'], { cwd: '/' });
  expect(r.status).toBe(0);
  expect(decode(r.stdout).trim()).toBe('via-sh-alias');
  repl.engine.terminate();
}, 60_000);

test('/bin/jsh is an alias for /bin/dsh (backwards compat)', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync('/bin/jsh', ['-c', 'echo via-jsh-alias'], { cwd: '/' });
  expect(r.status).toBe(0);
  expect(decode(r.stdout).trim()).toBe('via-jsh-alias');
  repl.engine.terminate();
}, 60_000);

test('dsh -c passes UTF-8 stdin through unchanged', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  const r = await repl.processManager.spawnSync('/bin/dsh', ['-c', 'cat; printf "|%s" "$(echo é)"'], {
    cwd: '/',
    stdin: new TextEncoder().encode('héllo ✓\n'),
  });
  expect(r.status).toBe(0);
  expect(new TextDecoder().decode(r.stdout)).toBe('héllo ✓\n|é');
  await repl.engine.terminate();
}, 60_000);

test('dsh -c waits for stdin that arrives after spawn', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  const proc = await repl.processManager.spawn('/bin/dsh', ['-c', 'wc -l'], { cwd: '/' });
  setTimeout(() => {
    void proc.stdin.write(new TextEncoder().encode('a\nb\n')).then(() =>
      new Promise((resolve) => setTimeout(resolve, 50))).then(() =>
      proc.stdin.write(new TextEncoder().encode('c\n'))).then(() => proc.stdin.close());
  }, 100);
  const text = await new Response(proc.stdout).text();
  expect(await proc.exit).toBe(0);
  expect(text.trim()).toBe('3');
  await repl.engine.terminate();
}, 60_000);

test('dsh -c does not block on stdin when the script never reads it', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  const proc = await repl.processManager.spawn('/bin/dsh', ['-c', 'echo ready; (echo sub)'], { cwd: '/' });
  const text = await new Response(proc.stdout).text();
  expect(await proc.exit).toBe(0);
  expect(text).toBe('ready\nsub\n');
  await repl.engine.terminate();
}, 60_000);

test('dsh streams each statement before the script finishes', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  const proc = await repl.processManager.spawn('/bin/dsh', ['-c', 'for i in 1 2; do echo tick$i; sleep 1; done; echo $(echo done) | tr a-z A-Z'], { cwd: '/' });
  const reader = proc.stdout.getReader();
  const started = Date.now();
  const first = await reader.read();
  const firstAt = Date.now() - started;
  let rest = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += new TextDecoder().decode(value);
  }
  expect(new TextDecoder().decode(first.value)).toBe('tick1\n');
  expect(firstAt).toBeLessThan(900);
  expect(rest).toBe('tick2\nDONE\n');
  expect(await proc.exit).toBe(0);
  await repl.engine.terminate();
}, 60_000);

test('/bin/dsh runs nested shells, env and timeout without hanging', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true, limits: { timeoutMs: 20_000 } });
  try {
    const script = [
      'bash -c "echo inner"',
      'sh -c "exit 3"; echo "sh=$?"',
      'env GREETING=hi sh -c \'echo $GREETING\'',
      'timeout 0.2 sleep 5; echo "timeout=$?"',
      'bash -c "bash -c \'echo deep\'"',
    ].join('; ');
    const r = await repl.processManager.spawnSync('/bin/dsh', ['-c', script], { cwd: '/' });
    expect(decode(r.stdout)).toBe('inner\nsh=3\nhi\ntimeout=124\ndeep\n');
    expect(r.status).toBe(0);
  } finally {
    await repl.dispose();
  }
}, 60_000);
