import { defineConfig } from 'vitest/config';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { worldSource } from './vite-world-source';
import { nativeWorkerWithoutHmr } from './vite-native-worker-hmr';
import pkg from './package.json';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const novaPackage = realpathSync(resolve(projectRoot, 'node_modules', '@nightnetwork', 'nova'));

export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    fs: { allow: [projectRoot, novaPackage] },
  },
  plugins: [nativeWorkerWithoutHmr(), worldSource()],
  worker: { format: 'es' },
  optimizeDeps: { include: ['@wasmer/wasi', '@wasmer/wasi/lib/bindings/browser', '@wasmer/wasmfs', 'buffer', '@terbiumos/tfs/browser'], exclude: ['@nightnetwork/nova'] },
  define: {
    __DUSK_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    // Each browser file boots a SpiderMonkey worker. Running them concurrently
    // starves Vite's relay startup; serialize files while preserving test behavior.
    fileParallelism: false,
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      headless: true,
    },
    include: ['test/**/*.test.ts'],
  },
});
