import { bootRepl, startPreview } from '@nightnetwork/dusk';

const server = `
const http = require('node:http');
http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<h1>Hello from a Dusk process</h1><p>' + req.url + '</p>');
}).listen(3000);
`;

export const previewInIframe = async (frame: HTMLIFrameElement): Promise<() => Promise<void>> => {
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    seed: { '/home/user/server.js': server },
  });
  await repl.processManager.spawn('/bin/node', ['/home/user/server.js'], { cwd: '/home/user' });
  const preview = await startPreview(repl.processManager, { serviceWorkerUrl: '/dusk-preview-sw.js' });
  frame.src = preview.url(3000, '/');
  return async () => {
    await preview.stop({ unregister: true });
    await repl.dispose();
  };
};
