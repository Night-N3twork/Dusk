import { test, expect } from 'vitest';
import { ProcessManager } from '../src/host/process-manager';
import { createMemoryBackend } from '../src/host/fs-backend';

test('process.on("SIGTERM") handler receives delivered signal (baseline)', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary(
    '/bin/sig-listener',
    `let resolveMain;
     const done = new Promise((r) => { resolveMain = r; });
     process.on('SIGTERM', () => {
       process.stdout.write('caught');
       resolveMain();
     });
     await done;
     process.exit(0);`,
  );
  const proc = await pm.spawn('/bin/sig-listener', [], { cwd: '/' });
  // Small settle to let the entry body run past .on() registration.
  await new Promise((r) => setTimeout(r, 100));
  pm._deliverSignal(proc.pid, 'SIGTERM');
  const code = await proc.exit;
  const reader = proc.stdout.getReader();
  let txt = '';
  while (true) { const r = await reader.read(); if (r.done) break; txt += new TextDecoder().decode(r.value); }
  expect(code).toBe(0);
  expect(txt).toContain('caught');
}, 30_000);

test('SIGCHLD is delivered to parent when child exits', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  // Parent: spawn child, register SIGCHLD handler that resolves a gate, wait,
  // print marker, exit. Engine has no real setTimeout — use a Promise gate.
  pm.registerBinary(
    '/bin/parent',
    `let resolveSig;
     const sigSeen = new Promise((r) => { resolveSig = r; });
     process.on('SIGCHLD', () => { resolveSig() });
     const cp = require('node:child_process');
     const child = cp.spawn('/bin/quickchild', []);
     await sigSeen;
     process.stdout.write('sigchld-fired');
     process.exit(0)`,
  );
  pm.registerBinary('/bin/quickchild', `process.exit(0)`);
  const proc = await pm.spawn('/bin/parent', [], { cwd: '/' });
  const code = await proc.exit;
  const reader = proc.stdout.getReader();
  let txt = '';
  while (true) { const r = await reader.read(); if (r.done) break; txt += new TextDecoder().decode(r.value); }
  expect(txt).toContain('sigchld-fired');
  expect(code).toBe(0);
}, 60_000);

test('nested guest spawnSync receives its shell result before SIGCHLD dispatch', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary(
    '/bin/parent-sync',
    `const order = [];
     let releaseChildExit;
     const childExited = new Promise((resolve) => { releaseChildExit = resolve; });
     process.on('SIGCHLD', () => { order.push('sigchld'); releaseChildExit(); });
     const cp = require('node:child_process');
     const result = cp.spawnSync('/bin/sh', ['-c', 'echo nested-shell']);
     order.push('reply:' + result.status);
     await childExited;
     process.stdout.write(order.join(','));
     process.exit(result.status);`,
  );

  const proc = await pm.spawn('/bin/parent-sync', [], { cwd: '/' });
  const code = await proc.exit;
  const reader = proc.stdout.getReader();
  let output = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += new TextDecoder().decode(chunk.value);
  }

  expect(code).toBe(0);
  expect(output).toBe('reply:0,sigchld');
}, 60_000);

test('kill(-pgid) broadcasts to every process in the group', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  // Engine has no real setTimeout (fake fires immediately). Use a Promise gate
  // resolved by the SIGTERM handler so the sleeper actually blocks awaiting
  // the signal. If the broadcast misses a member, that member never exits and
  // this test times out.
  pm.registerBinary(
    '/bin/sleeper',
    `let resolveMain;
     const done = new Promise((r) => { resolveMain = r });
     process.on('SIGTERM', () => {
       process.stdout.write('term:' + process.pid);
       resolveMain()
     });
     await done;
     process.exit(0)`,
  );
  const a = await pm.spawn('/bin/sleeper', [], { cwd: '/' });
  const b = await pm.spawn('/bin/sleeper', [], { cwd: '/' });
  // Put b into a's pgroup.
  const ra = pm.getProcessRecord(a.pid)!;
  // Reuse the host func through the internal record (no public setpgid yet on PM API).
  // The host func 'process.setpgid' is wired; we call _deliverSignal directly after manually
  // setting via the same path the func uses:
  (pm as unknown as { processes: Map<number, { pgid: number }> }).processes.get(b.pid)!.pgid = ra.pgid;
  // Settle so both sleepers have registered their SIGTERM handlers.
  await new Promise((r) => setTimeout(r, 100));
  pm._deliverSignal(-ra.pgid, 'SIGTERM');
  const [ca, cb] = await Promise.all([a.exit, b.exit]);
  expect(ca).toBe(0);
  expect(cb).toBe(0);
}, 60_000);

test('SIGKILL terminates the engine even when a handler is installed', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  // Engine has no real setTimeout, so a keep-alive `setTimeout(..., 5000)` would
  // fire immediately and exit the process before we could SIGKILL it. Use a
  // Promise gate that never resolves: only engine.terminate() can end the run.
  // If SIGKILL routed through the dispatch path (bug), the handler would run,
  // write 'should-not-run', call process.exit(0), and we'd see the marker.
  pm.registerBinary(
    '/bin/stubborn',
    `let _neverResolve;
     const forever = new Promise((r) => { _neverResolve = r });
     process.on('SIGKILL', () => {
       process.stdout.write('should-not-run');
       process.exit(0)
     });
     await forever;
     process.exit(99)`,
  );
  const proc = await pm.spawn('/bin/stubborn', [], { cwd: '/' });
  // Settle so the handler registration definitely ran before we SIGKILL.
  await new Promise((r) => setTimeout(r, 100));
  pm._deliverSignal(proc.pid, 'SIGKILL');
  const code = await proc.exit;
  const reader = proc.stdout.getReader();
  let txt = '';
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    txt += String.fromCharCode(...r.value);
  }
  expect(txt).not.toContain('should-not-run');
  // Exit code is implementation-defined for engine.terminate(); just assert
  // the process is fully reaped from the active-pid table.
  expect(pm.activePids().includes(proc.pid)).toBe(false);
  void code;
}, 60_000);

test('SIGPIPE default action terminates a producer whose stream consumer closed', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const reg = pm.getStreamRegistry();
  const streamId = reg.allocate();
  let consumerSawChunks = 0;
  let resolveFirstChunk: () => void;
  const firstChunk = new Promise<void>((r) => { resolveFirstChunk = r });
  reg.register({
    id: streamId,
    producerPid: 0,  // patched below once spawn returns
    consumerPid: 0,
    onChunk: () => { consumerSawChunks++; resolveFirstChunk() },
    onEnd: () => {},
    onError: () => {},
  });
  // Producer: write chunks periodically via a Promise/microtask loop (engine
  // has no real setTimeout, but ipc.send is synchronous host-side; a while
  // loop with an awaited microtask lets host dispatches interleave).
  pm.registerBinary(
    '/bin/producer',
    `const id = Number(process.env.STREAM_ID);
     // Push a few chunks synchronously so the consumer sees data, then park on
     // an unresolvable Promise so the engine idles and can accept the SIGPIPE
     // dispatch envelope. Default SIGPIPE action then triggers process.exit(141).
     for (let i = 0; i < 4; i++) ipc.send({ f: 'stream.pushChunk', id, data: [1] });
     await new Promise(() => {})`,
  );
  const proc = await pm.spawn('/bin/producer', [], { cwd: '/', env: { STREAM_ID: String(streamId) } });
  // Patch producer pid on the registration so onConsumerClose (added by the
  // test) knows where to deliver SIGPIPE. Because this test registers the
  // stream directly (not via the host func), we also install the
  // onConsumerClose callback here to mirror production wiring.
  const r = reg.get(streamId) as {
    producerPid: number;
    onConsumerClose?: () => void;
  };
  r.producerPid = proc.pid;
  r.onConsumerClose = () => {
    try { pm._deliverSignal(proc.pid, 'SIGPIPE') } catch { /* ESRCH ok */ }
  };
  // Wait for the producer to actually push a chunk before closing the
  // consumer side (setTimeout is fake in the engine; use a real Promise gate).
  await firstChunk;
  // Consumer closes early. NEW API on the registry:
  (reg as unknown as { closeFromConsumer: (id: number) => void }).closeFromConsumer(streamId);
  const code = await proc.exit;
  // Default SIGPIPE action: terminate. 128 + 13 = 141 per node-process.ts:426.
  expect(code).toBe(141);
  expect(consumerSawChunks).toBeGreaterThan(0);
}, 60_000);

// Uses SpawnOptions.pty to attach a PTY and
// ProcessManager.resizePty to fire SIGWINCH with { cols, rows } payload.
test('PTY resize delivers SIGWINCH with new cols/rows', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  // Engine has no real setTimeout; use a Promise gate resolved by the
  // SIGWINCH handler. The producer parks on the gate until SIGWINCH arrives,
  // then prints the payload and exits.
  pm.registerBinary(
    '/bin/resize-listener',
    `let got = null;
     let resolveGate;
     const gate = new Promise((r) => { resolveGate = r });
     process.on('SIGWINCH', (_name, payload) => { got = payload; resolveGate() });
     await gate;
     process.stdout.write(JSON.stringify(got));
     process.exit(0)`,
  );
  const proc = await pm.spawn('/bin/resize-listener', [], { cwd: '/', pty: { cols: 80, rows: 24 } });
  pm.resizePty(proc.pid, 132, 50);
  const code = await proc.exit;
  const reader = proc.stdout.getReader();
  let txt = '';
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    txt += String.fromCharCode(...r.value);
  }
  expect(code).toBe(0);
  const payload = JSON.parse(txt) as { cols: number; rows: number } | null;
  expect(payload).toEqual({ cols: 132, rows: 50 });
}, 60_000);

test('process.on(SIGPIPE) handler suppresses default terminate on consumer close', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const reg = pm.getStreamRegistry();
  const streamId = reg.allocate();
  reg.register({
    id: streamId, producerPid: 0, consumerPid: 0,
    onChunk: () => {}, onEnd: () => {}, onError: () => {},
  });
  pm.registerBinary(
    '/bin/producer-handled',
    `     process.on('SIGPIPE', () => { process.stdout.write('caught-sigpipe'); process.exit(7) });
     const id = Number(process.env.STREAM_ID);
     for (let i = 0; i < 4; i++) ipc.send({ f: 'stream.pushChunk', id, data: [1] });
     await new Promise(() => {})`,
  );
  const proc = await pm.spawn('/bin/producer-handled', [], { cwd: '/', env: { STREAM_ID: String(streamId) } });
  const r = reg.get(streamId) as { producerPid: number; onConsumerClose?: () => void };
  r.producerPid = proc.pid;
  r.onConsumerClose = () => { try { pm._deliverSignal(proc.pid, 'SIGPIPE') } catch { /* */ } };
  await new Promise((res) => setTimeout(res, 60));
  (reg as unknown as { closeFromConsumer: (id: number) => void }).closeFromConsumer(streamId);
  const code = await proc.exit;
  expect(code).toBe(7);
}, 60_000);

test('process.kill from one engine delivers SIGTERM to another engine via host func', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  // Engine setTimeout is fake (fires immediately). Use a Promise gate resolved
  // by the SIGTERM handler; drop the plan's 5s fallback which would fire
  // instantly under the fake timer and race the signal delivery.
  pm.registerBinary(
    '/bin/victim',
    `let resolveMain;
     const done = new Promise((r) => { resolveMain = r });
     process.on('SIGTERM', () => { process.stdout.write('victim-down'); resolveMain() });
     await done;
     process.exit(0)`,
  );
  const victim = await pm.spawn('/bin/victim', [], { cwd: '/' });
  await new Promise((r) => setTimeout(r, 50));
  pm.registerBinary(
    '/bin/killer',
    `process.kill(Number(process.env.TARGET), 'SIGTERM'); process.exit(0)`,
  );
  const killer = await pm.spawn('/bin/killer', [], { cwd: '/', env: { TARGET: String(victim.pid) } });
  await killer.exit;
  const code = await victim.exit;
  expect(code).toBe(0);
}, 60_000);
