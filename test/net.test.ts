import { test, expect } from 'vitest';
import { createRunner } from '../src/host/runner';
import { createMemoryBackend } from '../src/host/fs-backend';
import { createFuncs } from '../src/host/funcs';
import { createNet } from '../src/host/net';
import { bootRepl } from '../src/index';

// NOTE: The default test uses a STUBBED libcurl because this headless CI env has
// no Wisp proxy at wss://<host>/ws/. The stub exercises the full async
// event-pump bridge: in-engine fetch() -> net.fetch func -> stub fetch ->
// fire('response') -> runner.dispatch -> __net.dispatch -> promise resolves ->
// console.log on the host. The live-proxy variant is documented as test.skip.

const makeStubLibcurl = () => ({
  load_wasm: async () => {},
  set_websocket: (_url: string) => {},
  fetch: async (_url: string, _opts?: unknown) =>
    ({
      status: 200,
      statusText: 'OK',
      headers: new Map<string, string>([['content-type', 'text/plain']]),
      text: async () => 'hello world',
      arrayBuffer: async () => Uint8Array.from([0, 255, 1]).buffer,
    }) as unknown as Response,
  WebSocket: class {
    constructor(_url: string, _protocols?: string[]) {}
    addEventListener() {}
    send() {}
    close() {}
  } as unknown as new (url: string, protocols?: string[]) => WebSocket,
  HTTPSession: class {
    constructor(_opts?: unknown) {}
    fetch = async (_url: string, _opts?: unknown) => ({ status: 200, statusText: 'OK', headers: new Map(), text: async () => 'SESSION-BODY' }) as unknown as Response;
    close() {}
  } as unknown as new (opts?: unknown) => { fetch(url: string, opts?: unknown): Promise<Response>; close(): void },
  TLSSocket: class {
    onopen: (() => void) | null = null;
    onmessage: ((d: Uint8Array) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(_host: string, _port: number, _opts?: unknown) {
      setTimeout(() => { this.onopen?.(); this.onmessage?.(Uint8Array.from([72, 73])); }, 0);
    }
    send(_data: Uint8Array) {}
    close() {}
  } as unknown as new (host: string, port: number, opts?: unknown) => unknown,
});

test('fetch round-trips through the async event-pump (stubbed libcurl)', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const net = createNet(
    async () => makeStubLibcurl() as never,
    (js) => runner.dispatch(js),
    'wss://stub/ws/',
  );
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('fetch("https://example.com").then(r => r.text()).then(t => console.log(t.length > 0))');

  // The response dispatch arrives on a SUBSEQUENT wait/eval cycle (after run()
  // has already resolved). Poll `out` until the round-trip completes.
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('true') === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  runner.stop();
  expect(out.join('')).toContain('true');
}, 60_000);

test('fetch exposes an ok response and preserves binary response bytes', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const net = createNet(
    async () => makeStubLibcurl() as never,
    (js) => runner.dispatch(js),
    'wss://stub/ws/',
  );
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('fetch("https://example.com").then(async (r) => { const b = new Uint8Array(await r.arrayBuffer()); console.log(r.ok && b.length === 3 && b[0] === 0 && b[1] === 255 && b[2] === 1); })');

  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('true') === -1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  runner.stop();
  expect(out.join('')).toContain('true');
}, 60_000);

test('synchronous XHR returns a body through libcurl.js', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const net = createNet(
    async () => makeStubLibcurl() as never,
    (js) => runner.dispatch(js),
    'wss://stub/ws/',
  );
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('const x = new XMLHttpRequest(); x.open("GET", "https://example.com", false); x.send(); console.log(x.responseText.length > 0)');
  runner.stop();
  expect(out.join('')).toContain('true');
}, 60_000);

test('synchronous XHR decodes byte-array response bodies into responseText', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const net = createNet(
    async () => ({
      ...makeStubLibcurl(),
      fetch: async () => ({
        status: 200,
        statusText: 'OK',
        headers: new Map<string, string>(),
        text: async () => 'byte response',
        arrayBuffer: async () => new TextEncoder().encode('byte response').buffer,
      }) as unknown as Response,
    }) as never,
    (js) => runner.dispatch(js),
    'wss://stub/ws/',
  );
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('const x = new XMLHttpRequest(); x.open("GET", "https://example.com", false); x.send(); console.log(x.responseText === "byte response")');
  runner.stop();

  expect(out.join('')).toContain('true');
}, 60_000);

test('host registry: registerLibcurl + swap routes fetch through the named instance', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const second = makeStubLibcurl();
  second.fetch = async () => ({ status: 200, statusText: 'OK', headers: new Map(), text: async () => 'SECOND' }) as unknown as Response;
  const net = createNet(async () => makeStubLibcurl() as never, (js) => runner.dispatch(js), 'wss://stub/ws/');
  net.registerLibcurl('alt', second as never);
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('dusk.libcurl = "alt"; fetch("https://x").then(r => r.text()).then(t => console.log(t))');
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('SECOND') === -1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  runner.stop();
  expect(out.join('')).toContain('SECOND');
}, 60_000);

test('dusk.libcurl selects a registered Nova Wisp factory without assigning transport', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const factory = () => undefined;
  let selectedFactory: unknown;
  const stub = makeStubLibcurl() as unknown as { set_wisp_transport: (value: unknown) => void };
  stub.set_wisp_transport = (value) => { selectedFactory = value; };
  Object.defineProperty(stub, 'transport', {
    set: () => { throw new Error('immutable transport was assigned'); },
  });
  const net = createNet(async () => stub as never, (js) => runner.dispatch(js), 'wss://stub/ws/');
  net.registerWispTransport('nova-wisp', factory);
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('dusk.libcurl.transport = "nova-wisp"; console.log("configured")');
  runner.stop();

  expect(selectedFactory).toBe(factory);
  expect(out.join('')).toContain('configured');
}, 60_000);

test('bootRepl exposes Wisp transport registration to spawned processes', async () => {
  const factory = () => undefined;
  let selectedFactory: unknown;
  const stub = makeStubLibcurl() as unknown as { set_wisp_transport: (value: unknown) => void };
  stub.set_wisp_transport = (value) => { selectedFactory = value; };
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    layout: false,
    skipPidZero: true,
    net: { loadLibcurl: async () => stub as never, proxyUrl: 'wss://stub/ws/' },
  });

  try {
    repl.registerWispTransport('nova-wisp', factory);
    repl.processManager.registerBinary('/bin/select-wisp', 'dusk.libcurl.transport = "nova-wisp"; process.exit(0);');

    const result = await repl.processManager.spawnSync('/bin/select-wisp', [], { cwd: '/' });
    expect(result.status).toBe(0);
    expect(selectedFactory).toBe(factory);
  } finally {
    await repl.engine.terminate();
  }
}, 60_000);

test('dusk.libcurl transport wisp resets a readonly Nova instance to its configured websocket', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const stub = makeStubLibcurl() as unknown as { set_websocket: (url: string) => void; wsCalls: string[] };
  stub.wsCalls = [];
  stub.set_websocket = (url) => { stub.wsCalls.push(url); };
  Object.defineProperty(stub, 'transport', { get: () => 'wisp' });
  const net = createNet(async () => stub as never, (js) => runner.dispatch(js), 'wss://stub/ws/');
  runner = await createRunner({ ...createFuncs(vfs, (text) => out.push(text)), ...net.funcs });
  await runner.run([
    'dusk.libcurl.set_websocket("wss://configured/ws/");',
    'try { dusk.libcurl.transport = "wisp"; console.log("configured"); }',
    'catch (error) { console.log(String(error)); }',
  ].join('\n'));
  runner.stop();

  expect(out.join('')).toContain('configured');
  expect(stub.wsCalls).toEqual(['wss://stub/ws/', 'wss://configured/ws/', 'wss://configured/ws/']);
}, 60_000);

test('dusk.libcurl rejects wsproxy for a Nova instance without mutating transport', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  let transportWrites = 0;
  const stub = makeStubLibcurl() as unknown as { set_wisp_transport: (value: unknown) => void };
  stub.set_wisp_transport = () => {};
  Object.defineProperty(stub, 'transport', {
    set: () => { transportWrites++; },
  });
  const net = createNet(async () => stub as never, (js) => runner.dispatch(js), 'wss://stub/ws/');
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('try { dusk.libcurl.transport = "wsproxy"; console.log("no error"); } catch (e) { console.log(String(e)); }');
  runner.stop();

  expect(transportWrites).toBe(0);
  expect(out.join('')).toContain('Nova LibCurl does not support wsproxy');
}, 60_000);

test('remote socket terminal events release host socket entries', async () => {
  let ws: EventedWebSocket | undefined;
  let tls: EventedTLSSocket | undefined;
  class EventedWebSocket {
    private readonly listeners = new Map<string, (() => void)[]>();
    sent = 0;
    constructor(_url: string, _protocols?: string[]) { ws = this; }
    addEventListener(kind: string, listener: () => void): void {
      const listeners = this.listeners.get(kind) ?? [];
      listeners.push(listener);
      this.listeners.set(kind, listeners);
    }
    emit(kind: string): void { for (const listener of this.listeners.get(kind) ?? []) listener(); }
    send(_data: string): void { this.sent++; }
    close(): void {}
  }
  class EventedTLSSocket {
    onopen: (() => void) | null = null;
    onmessage: ((d: Uint8Array) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    sent = 0;
    constructor(_host: string, _port: number, _opts?: unknown) { tls = this; }
    send(_data: Uint8Array): void { this.sent++; }
    close(): void {}
  }
  const stub = makeStubLibcurl() as unknown as { WebSocket: unknown; TLSSocket: unknown };
  stub.WebSocket = EventedWebSocket;
  stub.TLSSocket = EventedTLSSocket;
  const net = createNet(async () => stub as never, () => {}, 'wss://stub/ws/');
  const invoke = (name: string, message: Record<string, unknown>): Promise<{ value?: unknown }> =>
    new Promise((resolve) => net.funcs[name]!(message, (reply) => resolve(reply as { value?: unknown })));

  const wsId = (await invoke('net.ws.open', { url: 'wss://example.test' })).value as number;
  await new Promise((resolve) => setTimeout(resolve, 0));
  ws!.emit('close');
  await invoke('net.ws.send', { id: wsId, data: 'ignored' });

  const tlsId = (await invoke('net.tls.open', { host: 'example.test', port: 443 })).value as number;
  await new Promise((resolve) => setTimeout(resolve, 0));
  tls!.onerror?.(new Error('remote error'));
  await invoke('net.tls.send', { id: tlsId, data: [1] });

  expect(ws!.sent).toBe(0);
  expect(tls!.sent).toBe(0);
}, 60_000);

test('async fetch, WebSocket, and TLS events retain their originating pid', async () => {
  let ws: EventedWebSocket | undefined;
  let tls: EventedTLSSocket | undefined;
  const delivered: Array<{ js: string; pid: number | undefined }> = [];

  class EventedWebSocket {
    private readonly listeners = new Map<string, Array<(event?: MessageEvent) => void>>();
    constructor(_url: string, _protocols?: string[]) { ws = this; }
    addEventListener(kind: string, listener: (event?: MessageEvent) => void): void {
      const listeners = this.listeners.get(kind) ?? [];
      listeners.push(listener);
      this.listeners.set(kind, listeners);
    }
    emit(kind: string, data?: unknown): void {
      for (const listener of this.listeners.get(kind) ?? []) listener({ data } as MessageEvent);
    }
    send(): void {}
    close(): void {}
  }

  class EventedTLSSocket {
    onopen: (() => void) | null = null;
    onmessage: ((data: Uint8Array) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;
    constructor(_host: string, _port: number, _opts?: unknown) { tls = this; }
    send(): void {}
    close(): void {}
  }

  const stub = makeStubLibcurl() as unknown as { WebSocket: unknown; TLSSocket: unknown };
  stub.WebSocket = EventedWebSocket;
  stub.TLSSocket = EventedTLSSocket;
  const net = createNet(async () => stub as never, (js, pid) => delivered.push({ js, pid }), 'wss://stub/ws/');
  const invoke = (name: string, message: Record<string, unknown>): Promise<{ value?: unknown }> =>
    new Promise((resolve) => net.funcs[name]!(message, (reply) => resolve(reply as { value?: unknown })));

  const pid = 41;
  await invoke('net.fetch', { url: 'https://example.test', pid });
  let deadline = Date.now() + 1_000;
  while (delivered.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const wsId = (await invoke('net.ws.open', { url: 'wss://example.test', pid })).value as number;
  void wsId;
  deadline = Date.now() + 1_000;
  while (!ws && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const tlsId = (await invoke('net.tls.open', { host: 'example.test', port: 443, pid })).value as number;
  void tlsId;
  deadline = Date.now() + 1_000;
  while (!tls && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(ws).toBeDefined();
  expect(tls).toBeDefined();
  ws!.emit('open');
  ws!.emit('message', 'websocket');
  tls!.onopen?.();
  tls!.onmessage?.(Uint8Array.from([1]));

  deadline = Date.now() + 1_000;
  while (delivered.length < 5 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(delivered).toHaveLength(5);
  expect(delivered.map((event) => event.pid)).toEqual([pid, pid, pid, pid, pid]);
}, 60_000);

test('concurrent first network operations share default LibCurl initialization', async () => {
  let socket: InitializingWebSocket | undefined;
  const delivered: string[] = [];

  class InitializingWebSocket {
    constructor(_url: string, _protocols?: string[]) { socket = this; }
    addEventListener(): void {}
    send(): void {}
    close(): void {}
  }

  const stub = makeStubLibcurl() as unknown as { WebSocket: unknown };
  stub.WebSocket = InitializingWebSocket;
  const net = createNet(async () => stub as never, (js) => delivered.push(js), 'wss://stub/ws/');
  const invoke = (name: string, message: Record<string, unknown>): Promise<{ value?: unknown }> =>
    new Promise((resolve) => net.funcs[name]!(message, (reply) => resolve(reply as { value?: unknown })));

  await invoke('net.fetch', { url: 'https://example.test' });
  await invoke('net.ws.open', { url: 'wss://example.test' });

  const deadline = Date.now() + 1_000;
  while (!socket && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(socket).toBeDefined();
  expect(delivered.join('')).not.toContain('"error"');
}, 60_000);

test('network cleanup closes WebSocket, TLS, and session resources owned by an exited pid', async () => {
  const webSockets: OwnedWebSocket[] = [];
  const tlsSockets: OwnedTLSSocket[] = [];
  const sessions: OwnedSession[] = [];

  class OwnedWebSocket {
    closed = 0;
    constructor(_url: string, _protocols?: string[]) { webSockets.push(this); }
    addEventListener(): void {}
    send(): void {}
    close(): void { this.closed++; }
  }

  class OwnedTLSSocket {
    closed = 0;
    onopen: (() => void) | null = null;
    onmessage: ((data: Uint8Array) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;
    constructor(_host: string, _port: number, _opts?: unknown) { tlsSockets.push(this); }
    send(): void {}
    close(): void { this.closed++; }
  }

  class OwnedSession {
    closed = 0;
    constructor(_opts?: unknown) { sessions.push(this); }
    fetch = async () => makeStubLibcurl().fetch('https://example.test');
    close(): void { this.closed++; }
  }

  const stub = makeStubLibcurl() as unknown as { WebSocket: unknown; TLSSocket: unknown; HTTPSession: unknown };
  stub.WebSocket = OwnedWebSocket;
  stub.TLSSocket = OwnedTLSSocket;
  stub.HTTPSession = OwnedSession;
  const net = createNet(async () => stub as never, () => {}, 'wss://stub/ws/');
  const invoke = (name: string, message: Record<string, unknown>): Promise<{ value?: unknown }> =>
    new Promise((resolve) => net.funcs[name]!(message, (reply) => resolve(reply as { value?: unknown })));

  const pid = 52;
  await invoke('net.ws.open', { url: 'wss://example.test', pid });
  let deadline = Date.now() + 1_000;
  while (webSockets.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await invoke('net.tls.open', { host: 'example.test', port: 443, pid });
  deadline = Date.now() + 1_000;
  while (tlsSockets.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await invoke('net.session.create', { pid });

  const cleanupForPid = (net as typeof net & { cleanupForPid?: (processId: number) => void }).cleanupForPid;
  expect(cleanupForPid).toBeTypeOf('function');
  cleanupForPid?.(pid);

  expect(webSockets[0]!.closed).toBe(1);
  expect(tlsSockets[0]!.closed).toBe(1);
  expect(sessions[0]!.closed).toBe(1);
}, 60_000);

test('network cleanup closes a WebSocket that finishes opening after its owner exits', async () => {
  let socket: LateWebSocket | undefined;
  let releaseLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });

  class LateWebSocket {
    closed = 0;
    constructor(_url: string, _protocols?: string[]) { socket = this; }
    addEventListener(): void {}
    send(): void {}
    close(): void { this.closed++; }
  }

  const stub = makeStubLibcurl() as unknown as { WebSocket: unknown };
  stub.WebSocket = LateWebSocket;
  const net = createNet(async () => {
    await loadGate;
    return stub as never;
  }, () => {}, 'wss://stub/ws/');
  const invoke = (name: string, message: Record<string, unknown>): Promise<{ value?: unknown }> =>
    new Promise((resolve) => net.funcs[name]!(message, (reply) => resolve(reply as { value?: unknown })));

  await invoke('net.ws.open', { url: 'wss://example.test', pid: 63 });
  net.cleanupForPid(63);
  releaseLoad();

  const deadline = Date.now() + 1_000;
  while (!socket && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(socket!.closed).toBe(1);
}, 60_000);

test('network resources reject access from a different pid', async () => {
  const webSockets: OwnedWebSocket[] = [];
  const tlsSockets: OwnedTLSSocket[] = [];
  const sessions: OwnedSession[] = [];
  class OwnedWebSocket {
    constructor(_url: string, _protocols?: string[]) { webSockets.push(this); }
    addEventListener(): void {}
    send(): void {}
    close(): void {}
  }
  class OwnedTLSSocket {
    onopen: (() => void) | null = null;
    onmessage: ((data: Uint8Array) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;
    constructor(_host: string, _port: number, _opts?: unknown) { tlsSockets.push(this); }
    send(): void {}
    close(): void {}
  }
  class OwnedSession {
    constructor(_opts?: unknown) { sessions.push(this); }
    fetch = async () => makeStubLibcurl().fetch('https://example.test');
    close(): void {}
  }
  const stub = makeStubLibcurl() as unknown as { WebSocket: unknown; TLSSocket: unknown; HTTPSession: unknown };
  stub.WebSocket = OwnedWebSocket;
  stub.TLSSocket = OwnedTLSSocket;
  stub.HTTPSession = OwnedSession;
  const net = createNet(async () => stub as never, () => {}, 'wss://stub/ws/');
  const invoke = (name: string, message: Record<string, unknown>): Promise<{ value?: unknown; error?: string }> =>
    new Promise((resolve) => net.funcs[name]!(message, (reply) => resolve(reply as { value?: unknown; error?: string })));

  const wsId = (await invoke('net.ws.open', { url: 'wss://example.test', pid: 1 })).value as number;
  const tlsId = (await invoke('net.tls.open', { host: 'example.test', port: 443, pid: 1 })).value as number;
  const sessionId = (await invoke('net.session.create', { pid: 1 })).value as number;
  await new Promise((resolve) => setTimeout(resolve, 0));

  await expect(invoke('net.ws.send', { id: wsId, data: 'x', pid: 2 })).resolves.toMatchObject({ error: 'resource belongs to another process' });
  await expect(invoke('net.tls.close', { id: tlsId, pid: 2 })).resolves.toMatchObject({ error: 'resource belongs to another process' });
  await expect(invoke('net.session.close', { sid: sessionId, pid: 2 })).resolves.toMatchObject({ error: 'resource belongs to another process' });
  expect(webSockets).toHaveLength(1);
  expect(tlsSockets).toHaveLength(1);
  expect(sessions).toHaveLength(1);
}, 60_000);

test('network cleanup drops an in-flight fetch response owned by the exited pid', async () => {
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
  const delivered: string[] = [];
  const net = createNet(async () => ({
    ...makeStubLibcurl(),
    fetch: async () => {
      await fetchGate;
      return makeStubLibcurl().fetch('https://example.test');
    },
  }) as never, (js) => delivered.push(js), 'wss://stub/ws/');
  const invoke = (name: string, message: Record<string, unknown>): Promise<{ value?: unknown }> =>
    new Promise((resolve) => net.funcs[name]!(message, (reply) => resolve(reply as { value?: unknown })));

  await invoke('net.fetch', { url: 'https://example.test', pid: 7 });
  net.cleanupForPid(7);
  releaseFetch();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(delivered).toEqual([]);
}, 60_000);

test('WebSocket binary messages retain bytes across the host-world bridge', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  let socket: BrowserWebSocket | undefined;

  class BrowserWebSocket {
    private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
    constructor(_url: string, _protocols?: string[]) { socket = this; }
    addEventListener(kind: string, listener: (event: MessageEvent) => void): void {
      const listeners = this.listeners.get(kind) ?? [];
      listeners.push(listener);
      this.listeners.set(kind, listeners);
    }
    emit(data: unknown): void {
      for (const listener of this.listeners.get('message') ?? []) listener({ data } as MessageEvent);
    }
    send(): void {}
    close(): void {}
  }

  const stub = makeStubLibcurl() as unknown as { WebSocket: unknown };
  stub.WebSocket = BrowserWebSocket;
  const net = createNet(async () => stub as never, (js) => runner.dispatch(js), 'wss://stub/ws/');
  runner = await createRunner({ ...createFuncs(vfs, (text) => out.push(text)), ...net.funcs });
  await runner.run([
    'const socket = new WebSocket("wss://example.test");',
    'const bytes = [];',
    'socket.onmessage = (event) => {',
    '  const data = event.data;',
    '  bytes.push(data instanceof Uint8Array ? Array.from(data).join(":") : "not-bytes");',
    '  if (bytes.length === 3) console.log(bytes.sort().join("|"));',
    '};',
  ].join('\n'));

  const deadline = Date.now() + 1_000;
  while (!socket && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  socket!.emit(Uint8Array.from([4, 5]));
  socket!.emit(Uint8Array.from([6, 7]).buffer);
  socket!.emit(new Blob([Uint8Array.from([0, 255, 1])]));

  const outputDeadline = Date.now() + 1_000;
  while (!out.join('').includes('0:255:1|4:5|6:7') && Date.now() < outputDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  runner.stop();

  expect(out.join('')).toContain('0:255:1|4:5|6:7');
}, 60_000);

test('WebSocket Blob messages preserve native event order across the host-world bridge', async () => {
  let socket: BrowserWebSocket | undefined;
  const delivered: string[] = [];
  class BrowserWebSocket {
    private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
    constructor(_url: string, _protocols?: string[]) { socket = this; }
    addEventListener(kind: string, listener: (event: MessageEvent) => void): void {
      this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), listener]);
    }
    emit(data: unknown): void {
      for (const listener of this.listeners.get('message') ?? []) listener({ data } as MessageEvent);
    }
    send(): void {}
    close(): void {}
  }
  const stub = makeStubLibcurl() as unknown as { WebSocket: unknown };
  stub.WebSocket = BrowserWebSocket;
  const net = createNet(async () => stub as never, (js) => delivered.push(js), 'wss://stub/ws/');
  const invoke = (name: string, message: Record<string, unknown>): Promise<{ value?: unknown }> =>
    new Promise((resolve) => net.funcs[name]!(message, (reply) => resolve(reply as { value?: unknown })));
  await invoke('net.ws.open', { url: 'wss://example.test', pid: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  socket!.emit(new Blob([Uint8Array.from([1])]))
  socket!.emit(Uint8Array.from([2]));
  const deadline = Date.now() + 1_000;
  while (delivered.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(delivered.map((js) => JSON.parse(js.match(/, (\[[^)]*\]|"[^"]*")\)$/)?.[1] ?? 'null'))).toEqual([[1], [2]]);
}, 60_000);

test('WebSocket dispatches a Blob message before its following close event', async () => {
  let socket: BrowserWebSocket | undefined;
  const delivered: string[] = [];
  class BrowserWebSocket {
    private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
    constructor(_url: string, _protocols?: string[]) { socket = this; }
    addEventListener(kind: string, listener: (event: MessageEvent) => void): void {
      this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), listener]);
    }
    emit(kind: string, data?: unknown): void {
      for (const listener of this.listeners.get(kind) ?? []) listener({ data } as MessageEvent);
    }
    send(): void {}
    close(): void {}
  }
  const stub = makeStubLibcurl() as unknown as { WebSocket: unknown };
  stub.WebSocket = BrowserWebSocket;
  const net = createNet(async () => stub as never, (js) => delivered.push(js), 'wss://stub/ws/');
  const invoke = (name: string, message: Record<string, unknown>): Promise<{ value?: unknown }> =>
    new Promise((resolve) => net.funcs[name]!(message, (reply) => resolve(reply as { value?: unknown })));
  await invoke('net.ws.open', { url: 'wss://example.test', pid: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  socket!.emit('message', new Blob([Uint8Array.from([1])]))
  socket!.emit('close');
  const deadline = Date.now() + 1_000;
  while (delivered.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));

  expect(delivered).toHaveLength(2);
  expect(delivered.map((js) => js.match(/, "([^"]+)"/)?.[1])).toEqual(['message', 'close']);
}, 60_000);

test('session fetch drops a response when its session closes while awaiting it', async () => {
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
  const delivered: string[] = [];
  class PendingSession {
    fetch = async () => {
      await fetchGate;
      return makeStubLibcurl().fetch('https://example.test');
    };
    close(): void {}
  }
  const stub = makeStubLibcurl() as unknown as { HTTPSession: unknown };
  stub.HTTPSession = PendingSession;
  const net = createNet(async () => stub as never, (js) => delivered.push(js), 'wss://stub/ws/');
  const invoke = (name: string, message: Record<string, unknown>): Promise<{ value?: unknown }> =>
    new Promise((resolve) => net.funcs[name]!(message, (reply) => resolve(reply as { value?: unknown })));
  const sid = (await invoke('net.session.create', { pid: 1 })).value as number;
  await invoke('net.session.fetch', { sid, url: 'https://example.test', pid: 1 });
  await invoke('net.session.close', { sid, pid: 1 });
  releaseFetch();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(delivered).toEqual([]);
}, 60_000);

test('skipPidZero routes a child WebSocket event through ProcessManager', async () => {
  class ChildWebSocket {
    private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
    constructor(_url: string, _protocols?: string[]) {
      setTimeout(() => {
        for (const listener of this.listeners.get('message') ?? []) {
          listener({ data: Uint8Array.from([7, 8]) } as MessageEvent);
        }
      }, 10);
    }
    addEventListener(kind: string, listener: (event: MessageEvent) => void): void {
      const listeners = this.listeners.get(kind) ?? [];
      listeners.push(listener);
      this.listeners.set(kind, listeners);
    }
    send(): void {}
    close(): void {}
  }

  const stub = makeStubLibcurl() as unknown as { WebSocket: unknown };
  stub.WebSocket = ChildWebSocket;
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    layout: false,
    skipPidZero: true,
    net: { loadLibcurl: async () => stub as never, proxyUrl: 'wss://stub/ws/' },
  });

  try {
    repl.processManager.registerBinary('/bin/wait-for-websocket', [
      'globalThis.__process._exitReserved = true;',
      'const socket = new WebSocket("wss://example.test");',
      'socket.onmessage = (event) => {',
      '  console.log(event.data instanceof Uint8Array && event.data[0] === 7 ? "child-message" : "wrong-message");',
      '  process.exit(0);',
      '};',
    ].join('\n'));
    const result = await Promise.race([
      repl.processManager.spawnSync('/bin/wait-for-websocket', [], { cwd: '/' }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('child did not receive WebSocket event')), 3_000)),
    ]);

    expect(result.status).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain('child-message');
  } finally {
    await repl.engine.terminate();
  }
}, 60_000);

test('dusk.libcurl.set_websocket + transport forward to the host', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const stub = makeStubLibcurl() as unknown as { set_websocket: (u: string) => void; transport: unknown; wsCalls: string[] };
  stub.wsCalls = [];
  stub.set_websocket = (u: string) => { stub.wsCalls.push(u); };
  const net = createNet(async () => stub as never, (js) => runner.dispatch(js), 'wss://stub/ws/');
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('dusk.libcurl.set_websocket("ws://p/"); dusk.libcurl.transport = "wsproxy"; console.log(String(dusk.libcurl.transport))');
  runner.stop();
  expect(stub.wsCalls).toContain('ws://p/');
  expect(out.join('')).toContain('wsproxy');
}, 60_000);

test('dusk.libcurl reassignment to a non-string throws in the sandbox', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const net = createNet(async () => makeStubLibcurl() as never, (js) => runner.dispatch(js), 'wss://stub/ws/');
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('try { dusk.libcurl = 123; console.log("no-throw"); } catch (e) { console.log("threw"); }');
  runner.stop();
  expect(out.join('')).toContain('threw');
}, 60_000);

test('dusk.libcurl swap to unregistered name throws', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const net = createNet(async () => makeStubLibcurl() as never, (js) => runner.dispatch(js), 'wss://stub/ws/');
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('try { dusk.libcurl = "nope"; console.log("no-throw"); } catch (e) { console.log("threw"); }');
  runner.stop();
  expect(out.join('')).toContain('threw');
}, 60_000);

test('dusk.libcurl.HTTPSession fetch round-trips', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const net = createNet(async () => makeStubLibcurl() as never, (js) => runner.dispatch(js), 'wss://stub/ws/');
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('const s = new dusk.libcurl.HTTPSession(); s.fetch("https://x").then(r => r.text()).then(t => { console.log(t); s.close(); })');
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('SESSION-BODY') === -1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  runner.stop();
  expect(out.join('')).toContain('SESSION-BODY');
}, 60_000);

test('dusk.libcurl.TLSSocket receives a message', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const net = createNet(async () => makeStubLibcurl() as never, (js) => runner.dispatch(js), 'wss://stub/ws/');
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('const s = new dusk.libcurl.TLSSocket("h", 443); s.onmessage = (d) => console.log("bytes:" + d.length); s.onopen = () => console.log("open")');
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('bytes:2') === -1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  runner.stop();
  expect(out.join('')).toContain('bytes:2');
}, 60_000);

test('per-request proxy opt reaches the active instance fetch', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const stub = makeStubLibcurl() as unknown as { fetch: (u: string, o?: unknown) => Promise<Response>; seenOpts: unknown[] };
  stub.seenOpts = [];
  stub.fetch = async (_u: string, o?: unknown) => {
    stub.seenOpts.push(o);
    return ({ status: 200, statusText: 'OK', headers: new Map(), text: async () => 'ok' }) as unknown as Response;
  };
  const net = createNet(async () => stub as never, (js) => runner.dispatch(js), 'wss://stub/ws/');
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('fetch("https://x", { proxy: "socks5h://127.0.0.1:1080" }).then(r => r.text()).then(t => console.log(t))');
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('ok') === -1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  runner.stop();
  expect(out.join('')).toContain('ok');
  expect(JSON.stringify(stub.seenOpts)).toContain('socks5h://127.0.0.1:1080');
}, 60_000);

test.skip('fetch returns a body through Nova (live Wisp proxy)', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const net = createNet(
    async () => {
      const nova = await import('@nightnetwork/nova');
      await nova.default();
      return new nova.LibCurl() as never;
    },
    (js) => runner.dispatch(js),
    `wss://${location.hostname}/ws/`,
  );
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('fetch("https://example.com").then(r => r.text()).then(t => console.log(t.length > 0))');
  runner.stop();
  expect(out.join('')).toContain('true');
}, 60_000);
