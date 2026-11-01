import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { worldSource } from './vite-world-source';
import pkg from './package.json';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Library build: bundles src/index.ts for Vite browser consumers. The
// worldSource plugin resolves `?worldsrc` imports at build time, but Vite
// still needs to relocate emitted worker and WASM assets for the browser.
// Bare esbuild browser bundling requires a custom worker/asset pipeline
// and handling for Pyodide's node:* imports; it is not supported out of the box.
//
// Output goes to `lib/` (not `dist/`) so it doesn't collide with the
// app-mode build (`npm run build`) which serves the src/demo/ REPL page
// from `dist/`.
export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [worldSource()],
  worker: { format: 'es' },
  define: {
    __DUSK_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'DuskJS',
      formats: ['es'],
      fileName: 'duskjs',
    },
    outDir: 'lib',
    emptyOutDir: true,
    // Externalize runtime deps consumers install themselves. Everything
    // else (including ?worldsrc bundles and worker sources) gets baked in.
    rollupOptions: {
      external: [
        '@nightnetwork/dpm',
        '@nightnetwork/nova',
        '@terbiumos/tfs',
        '@wasmer/wasi',
        '@wasmer/wasmfs',
        // Node.js builtins referenced by transitive worldsrc bundles (fs,
        // path, etc.) — these are stubbed inside the WASM guest, but
        // Rollup will complain if we don't declare them external.
        /^node:/,
      ],
      output: {
        // Keep the wasm/worker chunks addressable.
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
    // No minification for now — helps consumers debug and keeps errors
    // legible. Consumers can minify their own bundle downstream.
    minify: false,
    // Preserve sourcemaps for consumer debugging.
    sourcemap: true,
    // Don't emit an HTML entry — this is a library.
    manifest: false,
  },
});
