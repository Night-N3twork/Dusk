import { defineConfig } from 'vite';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { worldSource } from './vite-world-source';
import { nativeWorkerWithoutHmr } from './vite-native-worker-hmr';
import pkg from './package.json';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const allowedHosts = (process.env['DUSK_ALLOWED_HOSTS'] ?? '').split(',').map((host) => host.trim()).filter(Boolean);

// DuskJS requires cross-origin isolation for SharedArrayBuffer. Both the
// dev server (`vite dev`) and the preview server (`vite preview`, which
// serves the built dist/) need to set COOP/COEP on every response so the
// page is `crossOriginIsolated` and SAB is available.
type CoiServer = {
  middlewares: {
    use: (
      fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void,
    ) => void;
  };
};
const setCoi = (server: CoiServer): void => {
  server.middlewares.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
  });
};
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer: setCoi,
  configurePreviewServer: setCoi,
};

export default defineConfig({
  base: process.env['DUSK_BASE'] ?? '/',
  plugins: [crossOriginIsolation, nativeWorkerWithoutHmr(), worldSource()],
  worker: { format: 'es' },
  server: {
    allowedHosts,
    fs: { allow: [projectRoot] },
  },
  // `npm run preview` serves the built dist/ on port 5173 with COOP/COEP.
  preview: {
    port: 5173,
    strictPort: true,
    host: true,
    allowedHosts,
  },
  define: {
    __DUSK_VERSION__: JSON.stringify(pkg.version),
  },
});
