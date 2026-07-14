import { defineConfig } from 'vite';
import { worldSource } from './vite-world-source';
import pkg from './package.json';

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
  plugins: [crossOriginIsolation, worldSource()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['libcurl.js'] },
  server: { allowedHosts: ['ddxdevtemp.ampscat.dev'] },
  // `npm run preview` serves the built dist/ on port 5173 with COOP/COEP.
  preview: {
    port: 5173,
    strictPort: true,
    host: true,
    allowedHosts: ['ddxdevtemp.ampscat.dev'],
  },
  define: {
    __DUSK_VERSION__: JSON.stringify(pkg.version),
  },
});
