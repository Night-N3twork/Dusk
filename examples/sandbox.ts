import { bootRepl, createDohResolver } from '@nightnetwork/dusk';
import * as nova from '@nightnetwork/nova';

export const runUntrusted = async (source: string): Promise<{ code: number; output: string }> => {
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    seed: { '/home/user/task.js': source },
    net: {
      loadLibcurl: async () => {
        await nova.default();
        return new nova.LibCurl();
      },
      proxyUrl: 'wss://example.com/wisp/',
      dns: createDohResolver('https://cloudflare-dns.com/dns-query'),
      allow: ['https://registry.npmjs.org', '*.github.com:443'],
    },
    limits: { maxProcesses: 8, timeoutMs: 30_000, maxOutputBytes: 1 << 20 },
  });
  const decoder = new TextDecoder();
  let output = '';
  repl.processManager.on('stdout', ({ chunk }) => { output += decoder.decode(chunk, { stream: true }); });
  repl.processManager.on('exit', ({ pid, code, signal }) => {
    console.info(`process ${pid} exited with ${signal ?? code}`);
  });
  try {
    const result = await repl.processManager.spawnSync('/bin/node', ['/home/user/task.js'], { cwd: '/home/user' });
    return { code: result.status, output };
  } finally {
    await repl.dispose();
  }
};
