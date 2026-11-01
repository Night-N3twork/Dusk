import { expect, test } from 'vitest';
import { bootRepl } from '../src';
import type { FSBackend } from '../src/host/fs-backend';
import type { RelayListener, RelaySocket } from '../src/host/process-manager';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const viteRegistrationRegression = 'Vite 5.4.21 CLI must consume its transformed SystemJS registration and run cli.parse()';

const tar = (files: Record<string, string>): Uint8Array => {
  const entries: Uint8Array[] = [];
  for (const [name, contents] of Object.entries(files)) {
    const body = new TextEncoder().encode(contents);
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode(`package/${name}`));
    header.set(new TextEncoder().encode('0000644\0'), 100);
    header.set(new TextEncoder().encode(body.length.toString(8).padStart(11, '0') + '\0'), 124);
    header[156] = '0'.charCodeAt(0);
    header.set(new TextEncoder().encode('ustar\0'), 257);
    header.set(new TextEncoder().encode('00'), 263);
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.set(new TextEncoder().encode(checksum.toString(8).padStart(6, '0') + '\0 '), 148);
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body);
    entries.push(header, padded);
  }
  const archive = new Uint8Array(entries.reduce((size, entry) => size + entry.length, 1024));
  let offset = 0;
  for (const entry of entries) {
    archive.set(entry, offset);
    offset += entry.length;
  }
  return archive;
};

const integrity = async (bytes: Uint8Array): Promise<string> => {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes.slice().buffer));
  return `sha512-${btoa(String.fromCharCode(...hash))}`;
};

class ViteRelaySocket implements RelaySocket {
  readonly sent: Uint8Array[] = [];
  readonly closeReasons: Array<number | undefined> = [];
  private readonly dataHandlers = new Set<(data: Uint8Array) => void>();
  private readonly closeHandlers = new Set<(reason: number) => void>();
  private readonly sentWaiters = new Set<() => void>();

  onData(callback: (data: Uint8Array) => void): () => void {
    this.dataHandlers.add(callback);
    return () => this.dataHandlers.delete(callback);
  }

  onClose(callback: (reason: number) => void): () => void {
    this.closeHandlers.add(callback);
    return () => this.closeHandlers.delete(callback);
  }

  send(data: Uint8Array): void {
    this.sent.push(data.slice());
    for (const notify of [...this.sentWaiters]) notify();
  }

  close(reason?: number): void {
    this.closeReasons.push(reason);
  }

  receive(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    for (const callback of [...this.dataHandlers]) callback(bytes);
  }

  waitForSent(predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve) => {
      const notify = () => {
        if (!predicate()) return;
        this.sentWaiters.delete(notify);
        resolve();
      };
      this.sentWaiters.add(notify);
    });
  }

  get listenerCount(): number {
    return this.dataHandlers.size + this.closeHandlers.size;
  }
}

class ViteRelayListener implements RelayListener {
  authorizeListen = (): boolean => true;
  readonly registrations: Array<{ host: string; port: number }> = [];
  readonly unregistrations: Array<{ host: string; port: number }> = [];
  private readonly handlers = new Map<string, (socket: RelaySocket) => void>();
  private readonly listenerWaiters = new Set<() => void>();

  registerListener(host: string, port: number, handler: (socket: RelaySocket) => void): () => void {
    const key = `${host}:${port}`;
    if (this.handlers.has(key)) throw new Error(`EADDRINUSE: address already in use ${key}`);
    this.registrations.push({ host, port });
    this.handlers.set(key, handler);
    for (const notify of [...this.listenerWaiters]) notify();
    return () => {
      if (!this.handlers.delete(key)) return;
      this.unregistrations.push({ host, port });
    };
  }

  connect(socket: RelaySocket, host = 'dusk.local', port = 5173): void {
    const handler = this.handlers.get(`${host}:${port}`);
    if (!handler) throw new Error(`relay listener is not registered for ${host}:${port}`);
    handler(socket);
  }

  waitForListener(host: string, port: number): Promise<void> {
    const key = `${host}:${port}`;
    if (this.handlers.has(key)) return Promise.resolve();
    return new Promise((resolve) => {
      const notify = () => {
        if (!this.handlers.has(key)) return;
        this.listenerWaiters.delete(notify);
        resolve();
      };
      this.listenerWaiters.add(notify);
    });
  }

  get listenerCount(): number {
    return this.handlers.size;
  }
}

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

const relayText = (socket: ViteRelaySocket): string => decode(concat(socket.sent));

const waitFor = async (predicate: () => boolean, description: string | (() => string), timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!predicate()) throw new Error(typeof description === 'function' ? description() : description);
};

const websocketMessages = (socket: ViteRelaySocket): string[] => {
  const bytes = concat(socket.sent);
  const headerEnd = decode(bytes).indexOf('\r\n\r\n');
  if (headerEnd < 0) return [];
  let offset = headerEnd + 4;
  const messages: string[] = [];
  while (offset + 2 <= bytes.length) {
    const first = bytes[offset++]!;
    let length = bytes[offset++]! & 0x7f;
    if (length === 126) {
      if (offset + 2 > bytes.length) break;
      length = (bytes[offset++]! << 8) | bytes[offset++]!;
    } else if (length === 127) {
      if (offset + 8 > bytes.length) break;
      length = 0;
      for (let index = 0; index < 8; index++) length = length * 256 + bytes[offset++]!;
    }
    if (offset + length > bytes.length) break;
    const payload = bytes.subarray(offset, offset + length);
    offset += length;
    if ((first & 0x0f) === 1) messages.push(decode(payload));
  }
  return messages;
};

test('DPM routes the pinned Vite ESM bin through the ESM loader and executes its transformed CLI registration', async () => {
  const viteResponse = await fetch(new URL('./fixtures/vite-5.4.21.tgz', import.meta.url));
  const esbuildResponse = await fetch(new URL('./fixtures/esbuild-wasm-0.21.5.tgz', import.meta.url));
  const rollupResponse = await fetch(new URL('./fixtures/rollup-4.20.0.tgz', import.meta.url));
  expect(viteResponse.ok, 'the exact cached Vite archive must be checked in as a fixture').toBe(true);
  expect(esbuildResponse.ok, 'the exact official esbuild-wasm archive must be checked in as a fixture').toBe(true);
  expect(rollupResponse.ok, 'the exact official Rollup archive must be checked in as a fixture').toBe(true);
  const archives = new Map<string, Uint8Array>([
    ['vite@5.4.21', new Uint8Array(await viteResponse.arrayBuffer())],
    ['esbuild@0.21.5', new Uint8Array(await esbuildResponse.arrayBuffer())],
    ['rollup@4.20.0', new Uint8Array(await rollupResponse.arrayBuffer())],
    ['rollup@3.29.4', tar({ 'package.json': '{"name":"rollup","version":"3.29.4"}\n' })],
    ['postcss@8.4.43', tar({ 'package.json': '{"name":"postcss","version":"8.4.43"}\n' })],
  ]);
  const versions = {
    vite: { '5.4.21': { dependencies: { esbuild: '0.21.5', postcss: '8.4.43', rollup: '4.20.0' } } },
    esbuild: { '0.21.5': { dependencies: {} } },
    rollup: { '3.29.4': { dependencies: {} }, '4.20.0': { dependencies: {} } },
    postcss: { '8.4.43': { dependencies: {} } },
  };
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: {
      loadLibcurl: async () => ({
        load_wasm: async () => {},
        set_websocket: (_url: string) => {},
        fetch: async (url: string) => {
          const name = Object.keys(versions).find((candidate) => url.endsWith(`/${candidate}`) || url.includes(`/${candidate}-`));
          if (!name) throw new Error(`unexpected registry request: ${url}`);
          const packageVersions = versions[name as keyof typeof versions];
          if (url.includes('.tgz')) {
            const version = Object.keys(packageVersions).find((candidate) => url.endsWith(`/${name}-${candidate}.tgz`));
            if (!version) throw new Error(`unexpected tarball request: ${url}`);
            const archive = archives.get(`${name}@${version}`)!;
            return { status: 200, statusText: 'OK', headers: new Map(), arrayBuffer: async () => archive.buffer } as unknown as Response;
          }
          return {
            status: 200,
            statusText: 'OK',
            headers: new Map([['content-type', 'application/json']]),
            text: async () => JSON.stringify({
              name,
              'dist-tags': { latest: Object.keys(packageVersions)[0]! },
              versions: Object.fromEntries(await Promise.all(Object.entries(packageVersions).map(async ([version, manifest]) => [
                version,
                {
                  name,
                  version,
                  dependencies: manifest.dependencies,
                  dist: {
                    tarball: `https://registry.example/${name}-${version}.tgz`,
                    integrity: await integrity(archives.get(`${name}@${version}`)!),
                  },
                },
              ]))),
            }),
          } as unknown as Response;
        },
        WebSocket: class {
          addEventListener() {}
          send() {}
          close() {}
        } as unknown as new (url: string, protocols?: string[]) => WebSocket,
      }) as never,
      proxyUrl: 'wss://stub/ws/',
    },
  });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;

  try {
    await fs.mkdir('/project', { recursive: true });
    await fs.writeFile('/project/package.json', '{"name":"vite-fixture"}\n');
    const installRootRollup = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', 'rollup@3.29.4'], { cwd: '/project' });
    expect(installRootRollup.status, decode(installRootRollup.stderr)).toBe(0);
    const install = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', 'vite@5.4.21'], { cwd: '/project' });

    expect(install.status, decode(install.stderr)).toBe(0);
    const packages = JSON.parse(await fs.readFile('/project/package-lock.json')).packages;
    expect(packages).toMatchObject({
      'node_modules/vite': { version: '5.4.21' },
      'node_modules/vite/node_modules/esbuild': { version: '0.21.5' },
      'node_modules/rollup': { version: '3.29.4' },
      'node_modules/vite/node_modules/rollup': { version: '4.20.0' },
      'node_modules/vite/node_modules/postcss': { version: '8.4.43' },
    });
    expect(JSON.parse(await fs.readFile('/project/node_modules/vite/node_modules/rollup/package.json'))).toMatchObject({ version: '4.20.0' });
    expect(await fs.readFile('/project/node_modules/.bin/vite')).toContain('/project/node_modules/vite/bin/vite.js');

    const launch = await repl.processManager.spawnSync('/bin/dsh', ['-c', './node_modules/.bin/vite --help'], { cwd: '/project' });
    expect(launch.status).toBe(0);

    await fs.mkdir('/project/src', { recursive: true });
    await fs.writeFile('/project/index.html', '<div id="app"></div><script type="module" src="/src/main.js"></script>\n');
    await fs.writeFile('/project/src/main.js', 'document.querySelector("#app").textContent = "Vite fixture";\n');
    const build = await repl.processManager.spawnSync('/bin/node', [
      '--input-type=module',
      '-e',
      '(async () => { process.argv = ["node", "vite", "build"]; await import("/project/node_modules/vite/dist/node/cli.js"); for (let i = 0; i < 300 && !__fs.exists("/project/dist/index.html") && globalThis.__process?._exitCode === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 100)); if (!__fs.exists("/project/dist/index.html")) throw new Error("Vite CLI completed without /project/dist/index.html"); })().catch((error) => { console.error(error.stack ?? error); process.exit(1); })',
    ], { cwd: '/project' });

    expect(build.status, `${viteRegistrationRegression}\n${decode(build.stderr)}`).toBe(0);
    expect(decode(build.stderr), viteRegistrationRegression).not.toContain('Cannot find module esbuild');
    expect(await fs.exists('/project/dist/index.html'), viteRegistrationRegression).toBe(true);
    expect(await fs.readFile('/project/dist/index.html')).toContain('/assets/index-');
    expect(await fs.readdir('/project/dist/assets')).toContainEqual(expect.stringMatching(/^index-.*\.js$/));

    const directRequire = await repl.processManager.spawnSync('/bin/node', ['-e', 'require("/project/node_modules/vite/bin/vite.js")'], { cwd: '/project' });
    expect(directRequire.status).toBe(1);
    expect(decode(directRequire.stderr)).toContain('ERR_REQUIRE_ASYNC_MODULE');
  } finally {
    await repl.engine.terminate();
  }
}, 60_000);

test('serves Vite 5.4.21 through the relay and broadcasts HMR for host mutations', async () => {
  const viteResponse = await fetch(new URL('./fixtures/vite-5.4.21.tgz', import.meta.url));
  const esbuildResponse = await fetch(new URL('./fixtures/esbuild-wasm-0.21.5.tgz', import.meta.url));
  const rollupResponse = await fetch(new URL('./fixtures/rollup-4.20.0.tgz', import.meta.url));
  expect(viteResponse.ok).toBe(true);
  expect(esbuildResponse.ok).toBe(true);
  expect(rollupResponse.ok).toBe(true);
  const archives = new Map<string, Uint8Array>([
    ['vite@5.4.21', new Uint8Array(await viteResponse.arrayBuffer())],
    ['esbuild@0.21.5', new Uint8Array(await esbuildResponse.arrayBuffer())],
    ['rollup@4.20.0', new Uint8Array(await rollupResponse.arrayBuffer())],
    ['postcss@8.4.43', tar({ 'package.json': '{"name":"postcss","version":"8.4.43"}\n' })],
  ]);
  const versions = {
    vite: { '5.4.21': { dependencies: { esbuild: '0.21.5', postcss: '8.4.43', rollup: '4.20.0' } } },
    esbuild: { '0.21.5': { dependencies: {} } },
    rollup: { '4.20.0': { dependencies: {} } },
    postcss: { '8.4.43': { dependencies: {} } },
  };
  const relay = new ViteRelayListener();
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: {
      relay,
      loadLibcurl: async () => ({
        load_wasm: async () => {},
        set_websocket: (_url: string) => {},
        fetch: async (url: string) => {
          const name = Object.keys(versions).find((candidate) => url.endsWith(`/${candidate}`) || url.includes(`/${candidate}-`));
          if (!name) throw new Error(`unexpected registry request: ${url}`);
          const packageVersions = versions[name as keyof typeof versions];
          if (url.includes('.tgz')) {
            const version = Object.keys(packageVersions).find((candidate) => url.endsWith(`/${name}-${candidate}.tgz`));
            if (!version) throw new Error(`unexpected tarball request: ${url}`);
            const archive = archives.get(`${name}@${version}`)!;
            return { status: 200, statusText: 'OK', headers: new Map(), arrayBuffer: async () => archive.buffer } as unknown as Response;
          }
          return {
            status: 200,
            statusText: 'OK',
            headers: new Map([['content-type', 'application/json']]),
            text: async () => JSON.stringify({
              name,
              'dist-tags': { latest: Object.keys(packageVersions)[0]! },
              versions: Object.fromEntries(await Promise.all(Object.entries(packageVersions).map(async ([version, manifest]) => [
                version,
                {
                  name,
                  version,
                  dependencies: manifest.dependencies,
                  dist: {
                    tarball: `https://registry.example/${name}-${version}.tgz`,
                    integrity: await integrity(archives.get(`${name}@${version}`)!),
                  },
                },
              ]))),
            }),
          } as unknown as Response;
        },
        WebSocket: class {
          addEventListener() {}
          send() {}
          close() {}
        } as unknown as new (url: string, protocols?: string[]) => WebSocket,
      }) as never,
      proxyUrl: 'wss://stub/ws/',
    },
  });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  const subscribe = fs.subscribe.bind(fs);
  let notifyWatchSubscribed!: () => void;
  const watchSubscribed = new Promise<void>((resolve) => { notifyWatchSubscribed = resolve; });
  fs.subscribe = (listener) => {
    notifyWatchSubscribed();
    return subscribe(listener);
  };
  let server: Awaited<ReturnType<typeof repl.processManager.spawn>> | undefined;
  const sockets: ViteRelaySocket[] = [];

  try {
    await fs.mkdir('/project/src', { recursive: true });
    await fs.writeFile('/project/package.json', '{"name":"vite-dev-hmr-fixture"}\n');
    await fs.writeFile('/project/index.html', '<div id="app"></div><script type="module" src="/src/main.js"></script>\n');
    await fs.writeFile('/project/src/main.js', 'document.querySelector("#app").textContent = "before";\n');
    const install = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', 'vite@5.4.21'], { cwd: '/project' });
    expect(install.status, decode(install.stderr)).toBe(0);

    server = await repl.processManager.spawn('/bin/node', [
      '--input-type=module',
      '-e',
      '(async () => { process.argv = ["node", "vite", "--host", "dusk.local", "--port", "5173"]; await import("/project/node_modules/vite/dist/node/cli.js"); })().catch((error) => { console.error(error.stack ?? error); process.exit(1); })',
    ], { cwd: '/project' });
    let serverOutput = '';
    const capture = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const reader = stream.getReader();
      for (;;) {
        const result = await reader.read();
        if (result.done) return;
        serverOutput += decode(result.value);
      }
    };
    void capture(server.stdout);
    void capture(server.stderr);
    await relay.waitForListener('dusk.local', 5173);
    expect(relay.registrations).toEqual([{ host: 'dusk.local', port: 5173 }]);

    const page = new ViteRelaySocket();
    sockets.push(page);
    const pageResponse = page.waitForSent(() => relayText(page).includes('@vite/client'));
    relay.connect(page);
    page.receive('GET / HTTP/1.1\r\nHost: dusk.local\r\nConnection: close\r\n\r\n');
    await pageResponse;
    expect(relayText(page)).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(relayText(page)).toContain('<script type="module" src="/@vite/client"></script>');

    const module = new ViteRelaySocket();
    sockets.push(module);
    const moduleResponse = module.waitForSent(() => relayText(module).includes('before'));
    relay.connect(module);
    module.receive('GET /src/main.js HTTP/1.1\r\nHost: dusk.local\r\nConnection: close\r\n\r\n');
    await moduleResponse;

    const hmr = new ViteRelaySocket();
    sockets.push(hmr);
    const hmrConnected = hmr.waitForSent(() => websocketMessages(hmr).some((message) => message.includes('"connected"')));
    relay.connect(hmr);
    hmr.receive('GET / HTTP/1.1\r\nHost: dusk.local\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n');
    await hmrConnected;
    expect(relayText(hmr)).toContain('HTTP/1.1 101 Switching Protocols');
    expect(relayText(hmr)).toContain('Sec-WebSocket-Protocol: vite-hmr');
    expect(websocketMessages(hmr)).toContainEqual(expect.stringContaining('"type":"connected"'));

    await watchSubscribed;
    await fs.writeFile('/project/src/main.js', 'document.querySelector("#app").textContent = "after";\n');
    await hmr.waitForSent(() => websocketMessages(hmr).some((message) => message.includes('"type":"update"') || message.includes('"type":"full-reload"')));
  } finally {
    for (const socket of sockets) socket.close();
    server?.kill();
    await repl.engine.terminate();
    expect(relay.listenerCount).toBe(0);
    expect(sockets.every((socket) => socket.listenerCount === 0)).toBe(true);
  }
}, 60_000);

test('node:v8 exposes a startupSnapshot that reports no snapshot build', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;

  try {
    await fs.mkdir('/project/node_modules/vite/dist/node', { recursive: true });
    await fs.writeFile('/project/node_modules/vite/package.json', '{"type":"module"}\n');
    await fs.writeFile('/project/node_modules/vite/dist/node/snapshot.mjs', "import v8 from 'node:v8'; export const building = v8.startupSnapshot.isBuildingSnapshot();\n");

    const viteImport = await repl.processManager.spawnSync('/bin/node', [
      '--input-type=module',
      '-e',
      '(async () => { let result; let failure; import("/project/node_modules/vite/dist/node/snapshot.mjs").then((value) => { result = value; }, (error) => { failure = error; }); for (let i = 0; i < 20 && !result && !failure; i++) await new Promise((resolve) => setTimeout(resolve, 10)); if (failure) throw failure; if (!result) throw new Error("Vite snapshot fixture did not load"); process.stdout.write(String(result.building) + "\\n"); })().catch((error) => { console.error(error.stack ?? error); process.exit(1); })',
    ], { cwd: '/project' });
    expect(viteImport.status, decode(viteImport.stderr)).toBe(0);
    expect(decode(viteImport.stdout)).toBe('false\n');

    const namedImport = await repl.processManager.spawnSync('/bin/node', [
      '--input-type=module',
      '-e',
      '(async () => { const v8 = await import("node:v8"); process.stdout.write(String(v8.startupSnapshot.isBuildingSnapshot()) + "\\n"); })()',
    ], { cwd: '/project' });
    expect(namedImport.status, decode(namedImport.stderr)).toBe(0);
    expect(decode(namedImport.stdout)).toBe('false\n');
  } finally {
    await repl.engine.terminate();
  }
}, 60_000);
