import { afterEach, expect, test, vi } from 'vitest';
import { createEngine, createEngineFactory, createNativeEngine } from '../src/host/engine-instance';
import { ProcessManager } from '../src/host/process-manager';
import { createMemoryBackend } from '../src/host/fs-backend';

test('browser Vitest does not inject the Vite HMR client into the native worker', async () => {
  const response = await fetch(new URL('../src/worker/native-loader.ts?worker_file&type=module', import.meta.url));

  expect(response.ok).toBe(true);
  expect(await response.text()).not.toContain('@vite/client');
});

test('native loader acknowledges a sync RPC only after decoding its reply', async () => {
  const response = await fetch(new URL('../src/worker/native-loader.ts?worker_file&type=module', import.meta.url));
  const source = await response.text();

  expect(source.indexOf('return read(size)')).toBeGreaterThan(-1);
  expect(source.indexOf('sync-rpc-consumed')).toBeGreaterThan(source.indexOf('return read(size)'));
});

class MockWorker {
  static instances: MockWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: unknown[] = [];
  terminated = false;

  constructor(..._args: unknown[]) { MockWorker.instances.push(this); }

  postMessage(message: unknown): void { this.messages.push(message); }

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(1);
  }

  receive(message: unknown): void { this.onmessage?.({ data: message } as MessageEvent); }
  fail(message = 'native worker bootstrap failed'): void { this.onerror?.({ message } as ErrorEvent); }
  failMessage(): void { this.onmessageerror?.({} as MessageEvent); }
}

afterEach(() => {
  MockWorker.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('native engine delivers eval envelopes through postMessage and gates dispatch until a sync reply is consumed', async () => {
  vi.stubGlobal('Worker', MockWorker);
  const seen: unknown[] = [];
  let engine: Awaited<ReturnType<typeof createNativeEngine>>;
  engine = await createNativeEngine(42, {
    capture: (message, send) => {
      seen.push(message['__enginePid']);
      void engine.dispatch('globalThis.dispatched = true;');
      send({ value: 'ok' });
    },
  });
  const worker = MockWorker.instances[0]!;
  const init = worker.messages[0] as { pid: number; lengthBuffer: SharedArrayBuffer; valueBuffer: SharedArrayBuffer; js: string };
  expect(init.pid).toBe(42);
  expect(init.js).toContain('installNodeGlobals');

  void engine.run('globalThis.entry = true;');
  expect(worker.messages[1]).toEqual({ type: 'eval', js: 'globalThis.entry = true;', primary: true });

  worker.receive({ f: 'capture', pid: 999, syncRpcSeq: 1 });
  expect(seen).toEqual([42]);
  const responseLength = Atomics.load(new Int32Array(init.lengthBuffer), 0);
  expect(JSON.parse(new TextDecoder().decode(new Uint8Array(init.valueBuffer, 0, responseLength).slice()))).toEqual({ value: 'ok' });
  expect(worker.messages).toHaveLength(2);

  worker.receive({ type: 'sync-rpc-consumed', syncRpcSeq: 1 });
  expect(worker.messages[2]).toEqual({ type: 'eval', js: 'globalThis.dispatched = true;', primary: false });

  await engine.terminate();
  expect(worker.terminated).toBe(true);
});

test('native engine prioritizes primary runs over queued dispatches', async () => {
  vi.stubGlobal('Worker', MockWorker);
  const engine = await createNativeEngine(42);
  const worker = MockWorker.instances[0]!;

  const primary = engine.run('globalThis.primary = true;');
  void engine.dispatch('globalThis.dispatched = true;');
  expect(worker.messages[1]).toEqual({ type: 'eval', js: 'globalThis.primary = true;', primary: true });
  expect(worker.messages[2]).toEqual({ type: 'eval', js: 'globalThis.dispatched = true;', primary: false });
  worker.receive({ type: 'done', primary: true, syncRpcSeq: 1 });
  await expect(primary).resolves.toBeUndefined();
});

test('native is the default engine factory', () => {
  expect(createEngineFactory()).toBe(createNativeEngine);
  expect(createEngine).toBe(createNativeEngine);
});

test('native engine resolves queued runs with their corresponding done messages', async () => {
  vi.stubGlobal('Worker', MockWorker);
  const engine = await createNativeEngine(42);
  const worker = MockWorker.instances[0]!;
  const first = engine.run('globalThis.first = true;');
  const second = engine.run('globalThis.second = true;');

  expect(worker.messages[1]).toEqual({ type: 'eval', js: 'globalThis.first = true;', primary: true });
  worker.receive({ type: 'done', primary: true, syncRpcSeq: 1 });
  await first;

  expect(worker.messages[2]).toEqual({ type: 'eval', js: 'globalThis.second = true;', primary: true });
  worker.receive({ type: 'done', primary: true, syncRpcSeq: 2 });
  await expect(second).resolves.toBeUndefined();
});

test('native engine terminates when primary completion reports an exit code', async () => {
  vi.stubGlobal('Worker', MockWorker);
  const engine = await createNativeEngine(42);
  const worker = MockWorker.instances[0]!;

  void engine.run('process.exit(7);');
  worker.receive({ type: 'exit', exitCode: 7, syncRpcSeq: 1 });

  await expect(engine.exited).resolves.toBe(7);
  expect(worker.terminated).toBe(true);
});

test('native engine terminates and resolves exited when its worker fails to bootstrap', async () => {
  vi.stubGlobal('Worker', MockWorker);
  const engine = await createNativeEngine(42);
  const worker = MockWorker.instances[0]!;

  worker.fail();

  await expect(Promise.race([engine.exited, Promise.resolve(-1)])).resolves.toBe(1);
  expect(worker.terminated).toBe(true);
});

test.each(['error', 'messageerror', 'terminate'] as const)(
  'native engine settles a pending run when worker %s terminates execution',
  async (failure) => {
    vi.stubGlobal('Worker', MockWorker);
    const engine = await createNativeEngine(42);
    const worker = MockWorker.instances[0]!;
    const run = engine.run('await new Promise(() => {});');

    if (failure === 'error') worker.fail();
    else if (failure === 'messageerror') worker.failMessage();
    else await engine.terminate();

    await expect(Promise.race([
      run.then(() => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 100)),
    ])).resolves.toBe('settled');
  },
);

test('native worker boots the bundled world and serves host calls', async () => {
  let seen: unknown;
  const engine = await createNativeEngine(7, {
    capture: (message, send) => { seen = message['value']; send({}); },
  });
  await engine.run('print(JSON.stringify({ f: "capture", value: process.pid }));');
  await engine.terminate();
  expect(seen).toBe(7);
}, 30_000);

test('native guest awaits timers while the host can dispatch their callbacks', async () => {
  const seen: unknown[] = [];
  const engine = await createNativeEngine(8, {
    capture: (message, send) => { seen.push(message['value']); send({}); },
  });

  try {
    await engine.run(`
      await new Promise((resolve) => setTimeout(resolve, 0));
      print(JSON.stringify({ f: 'capture', value: 'timer-fired' }));
    `);
    expect(seen).toEqual(['timer-fired']);
  } finally {
    await engine.terminate();
  }
}, 30_000);

test('native guest exits after a timer callback releases its final refed handle', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/release-timer', `
    const keepAlive = setInterval(() => {}, 60_000);
    setTimeout(() => clearInterval(keepAlive), 0);
  `);

  const proc = await pm.spawn('/bin/release-timer');
  await expect(proc.exit).resolves.toBe(0);
}, 5_000);

test('native process exits after its final retained timer is cleared', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/release-final-timer', `
    const retained = setTimeout(() => {}, 60_000);
    clearTimeout(retained);
  `);

  const proc = await pm.spawn('/bin/release-final-timer');
  await expect(Promise.race([
    proc.exit,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('native process remained alive after clearing its final timer')), 500)),
  ])).resolves.toBe(0);
}, 5_000);

test('native guest sends a terminal exit after process.exit in a retained timer callback', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/exit-from-timer', `
    await new Promise((resolve) => setTimeout(() => {
      resolve();
      process.exit(17);
    }, 0));
  `);

  const proc = await pm.spawn('/bin/exit-from-timer');
  await expect(Promise.race([
    proc.exit,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('retained timer exit did not become terminal')), 500)),
  ])).resolves.toBe(17);
}, 5_000);

test('native /bin/sh completes just-bash async continuations', async () => {
  const pm = new ProcessManager(createMemoryBackend());

  const result = await pm.spawnSync('/bin/sh', ['-c', 'echo hello'], { cwd: '/' });

  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('hello\n');
}, 30_000);
