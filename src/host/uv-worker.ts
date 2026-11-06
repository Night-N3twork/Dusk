// Worker entry for the uv engine (tholus).
//
// tholus ships its own worker.js, but it finds the engine by a path relative
// to itself, which a bundler that renames assets breaks. Running
// createEngineWorker here instead keeps the engine's location in Dusk's hands.
//
// Before the engine boots, the host sends one `dusk:uv-setup` message:
// - `moduleUrl` and `wasmUrl`, resolved on the main thread. A bundler building
//   an app on top of Dusk's library build only sees asset URLs in main-thread
//   code, not inside this already-built worker, so that is where they must be
//   resolved for the app to emit them.
// - optionally `policy`, a MessagePort. Each fetch then asks the host whether
//   its target is allowed and fails like a blocked request when it is not.

import { createEngineWorker, type EngineExports } from '@tholus/core';

interface Scope {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  fetch: typeof fetch;
  location: { href: string };
}

interface Setup {
  type: 'dusk:uv-setup';
  moduleUrl: string;
  wasmUrl: string;
  policy?: MessagePort;
}

const scope = globalThis as unknown as Scope;

let resolveSetup!: (setup: Setup) => void;
const setup = new Promise<Setup>((resolve) => { resolveSetup = resolve; });

let policyPort: MessagePort | undefined;
let nextQuery = 0;
const pendingQueries = new Map<number, (allowed: boolean) => void>();
// Dusk's own assets are not uv's traffic, and the engine cannot boot without them.
const ownAssets = new Set<string>();

const ask = (url: string): Promise<boolean> => {
  const port = policyPort;
  if (!port || ownAssets.has(url)) return Promise.resolve(true);
  const id = nextQuery++;
  return new Promise((resolve) => {
    pendingQueries.set(id, resolve);
    port.postMessage({ id, url });
  });
};

const platformFetch = scope.fetch.bind(scope);
scope.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, scope.location.href).href;
  if (!(await ask(url))) {
    throw new TypeError(`ERR_DUSK_NETWORK_BLOCKED: network policy blocked ${new URL(url).origin}`);
  }
  return platformFetch(input, init);
}) as typeof fetch;

const worker = createEngineWorker({
  load: async (): Promise<EngineExports> => (await import(/* @vite-ignore */ (await setup).moduleUrl)) as EngineExports,
  wasm: async () => new URL((await setup).wasmUrl),
  emit: (message) => scope.postMessage(message),
});

scope.addEventListener('message', (event) => {
  const data = event.data as Partial<Setup> | undefined;
  if (data?.type === 'dusk:uv-setup' && data.moduleUrl && data.wasmUrl) {
    const moduleUrl = new URL(data.moduleUrl, scope.location.href).href;
    const wasmUrl = new URL(data.wasmUrl, scope.location.href).href;
    ownAssets.add(moduleUrl);
    ownAssets.add(wasmUrl);
    if (data.policy) {
      policyPort = data.policy;
      policyPort.onmessage = (reply: MessageEvent<{ id: number; allowed: boolean }>) => {
        pendingQueries.get(reply.data.id)?.(reply.data.allowed);
        pendingQueries.delete(reply.data.id);
      };
    }
    resolveSetup({ type: 'dusk:uv-setup', moduleUrl, wasmUrl });
    return;
  }
  worker.receive(event.data);
});
