import { test, expect } from 'vitest';
import { bootRepl, fetchLoopback, startPreview } from '../src/index';

const startServer = async (port: number) => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  const server = await repl.processManager.spawn('/bin/node', ['-e', `
    const http = require('node:http');
    http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url === '/chunked') { res.write('part1-'); res.end('part2'); return; }
        res.setHeader('content-type', 'text/html');
        res.end('<p id="msg">' + req.method + ' ' + req.url + ' ' + body + '</p>');
      });
    }).listen(${port}, () => console.log('listening'));
  `], { cwd: '/' });
  const reader = server.stdout.getReader();
  let text = '';
  while (!text.includes('listening')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return { repl, server };
};

test('fetchLoopback speaks HTTP/1.1 to in-runtime servers', async () => {
  const { repl, server } = await startServer(4100);
  try {
    const get = await fetchLoopback(repl.processManager, 4100, { path: '/a?b=1' });
    const post = await fetchLoopback(repl.processManager, 4100, { method: 'POST', path: '/p', body: 'xyz', headers: { 'content-type': 'text/plain' } });
    const chunked = await fetchLoopback(repl.processManager, 4100, { path: '/chunked' });
    const decode = (b: Uint8Array) => new TextDecoder().decode(b);
    expect(get.status).toBe(200);
    expect(decode(get.body)).toBe('<p id="msg">GET /a?b=1 </p>');
    expect(decode(post.body)).toBe('<p id="msg">POST /p xyz</p>');
    expect(decode(chunked.body)).toBe('part1-part2');
    await expect(fetchLoopback(repl.processManager, 4999)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  } finally {
    server.kill();
    await repl.dispose();
  }
}, 60_000);

test('startPreview serves in-runtime HTTP servers to iframes through a service worker', async () => {
  const { repl, server } = await startServer(4200);
  const preview = await startPreview(repl.processManager, {
    serviceWorkerUrl: new URL('../src/preview/preview-sw.js', import.meta.url),
    scope: './__dusk_preview__/',
  });
  const frame = document.createElement('iframe');
  try {
    frame.src = preview.url(4200, '/from-iframe?x=1');
    const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
    document.body.appendChild(frame);
    await loaded;
    expect(frame.contentDocument?.getElementById('msg')?.textContent).toBe('GET /from-iframe?x=1 ');
    const missing = document.createElement('iframe');
    missing.src = preview.url(4999, '/');
    const missingLoaded = new Promise((resolve) => missing.addEventListener('load', resolve, { once: true }));
    document.body.appendChild(missing);
    await missingLoaded;
    expect(missing.contentDocument?.body.textContent).toContain('4999');
    missing.remove();
  } finally {
    frame.remove();
    await preview.stop({ unregister: true });
    server.kill();
    await repl.dispose();
  }
}, 60_000);
