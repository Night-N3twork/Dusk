const scope = new URL(self.location.href).searchParams.get('scope') || new URL('./__dusk_preview__/', self.location.href).pathname;
const hosts = new Set();
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'dusk-preview-host' && event.source && event.source.id) hosts.add(event.source.id);
});

const candidateHosts = async () => {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const known = windows.filter((client) => hosts.has(client.id));
  if (known.length > 0) return known;
  return windows.filter((client) => !new URL(client.url).pathname.startsWith(scope));
};

const askHost = (client, message, body) => new Promise((resolve) => {
  const channel = new MessageChannel();
  const timer = setTimeout(() => resolve({ error: 'Dusk preview host did not respond', refused: true }), 30000);
  channel.port1.onmessage = (event) => {
    clearTimeout(timer);
    resolve(event.data);
  };
  client.postMessage(message, body ? [channel.port2, body] : [channel.port2]);
});

const forward = async (request, port, path) => {
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  const message = { type: 'dusk-preview-request', port, method: request.method, path, headers: [...request.headers], body };
  let last = { error: `No Dusk runtime is serving port ${port}`, refused: true };
  for (const client of await candidateHosts()) {
    const copy = body ? body.slice(0) : undefined;
    const reply = await askHost(client, { ...message, body: copy }, copy);
    if (!reply.error) {
      const headers = new Headers(reply.headers);
      if (!headers.has('cross-origin-embedder-policy')) headers.set('cross-origin-embedder-policy', 'require-corp');
      if (!headers.has('cross-origin-resource-policy')) headers.set('cross-origin-resource-policy', 'same-origin');
      return new Response(NULL_BODY.has(reply.status) ? null : reply.body, { status: reply.status, statusText: reply.statusText, headers });
    }
    last = reply;
    if (!reply.refused) break;
  }
  return new Response(last.error, {
    status: 502,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-origin',
    },
  });
};

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(scope)) return;
  const match = /^(\d+)(\/.*)?$/.exec(url.pathname.slice(scope.length));
  if (!match) return;
  event.respondWith(forward(event.request, Number(match[1]), (match[2] || '/') + url.search));
});
