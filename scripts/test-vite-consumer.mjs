import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const archiveArgument = process.argv[2];
if (!archiveArgument) throw new Error('Usage: node scripts/test-vite-consumer.mjs <dusk-tarball>');
const archive = isAbsolute(archiveArgument) ? archiveArgument : resolve(archiveArgument);
const root = await mkdtemp(join(tmpdir(), 'dusk-vite-consumer-'));
try {
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-package-lock', archive, 'vite@6.4.3', 'playwright@1.61.0'], {
    cwd: root,
    stdio: 'inherit',
  });
  await writeFile(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
  await writeFile(join(root, 'main.js'), `
    import { bootRepl } from '@nightnetwork/dusk';
    void (async () => {
      const output = [];
      try {
        const repl = await bootRepl((text) => output.push(text), { fs: 'memory' });
        const fs = repl.processManager.fs;
        await fs.writeFile('/dep.mjs', 'export const answer = 42;');
        await fs.writeFile('/main.mjs', "import { answer } from './dep.mjs'; export const value = answer;");
        await repl.engine.run("console.log('esm=' + (await import('/main.mjs')).value)");
        const help = await repl.processManager.spawnSync('/bin/dpm', ['--help'], { cwd: '/' });
        const uv = await repl.processManager.spawnSync('/bin/uv', ['--version'], { cwd: '/' });
        await repl.uv?.dispose();
        globalThis.__duskResult = {
          dpmStatus: help.status,
          help: new TextDecoder().decode(help.stdout),
          uvStatus: uv.status,
          uv: new TextDecoder().decode(uv.stdout) + new TextDecoder().decode(uv.stderr),
          output: output.join(''),
        };
        await repl.engine.terminate();
      } catch (error) {
        globalThis.__duskResult = { error: String(error?.stack ?? error) };
      }
    })();
  `);
  const vite = await import(pathToFileURL(join(root, 'node_modules/vite/dist/node/index.js')).href);
  const { chromium } = await import(pathToFileURL(join(root, 'node_modules/playwright/index.mjs')).href);
  await vite.build({
    root,
    configFile: false,
    build: { outDir: join(root, 'dist') },
    logLevel: 'warn',
  });

  const assets = await readdir(join(root, 'dist', 'assets'));
  for (const pattern of [/^browser\.min(?:-[\w-]+)?\.js$/, /^esbuild(?:-[\w-]+)?\.wasm$/, /^dpm_wasm_bg(?:-[\w-]+)?\.wasm$/, /^engine_bg(?:-[\w-]+)?\.wasm$/, /^uv-worker(?:-[\w-]+)?\.js$/]) {
    const asset = assets.find((name) => pattern.test(name));
    assert.ok(asset, `Vite consumer did not emit ${pattern}`);
    assert.ok((await readFile(join(root, 'dist', 'assets', asset))).byteLength > 0, `Empty Vite asset ${asset}`);
  }
  const server = await vite.preview({
    root,
    configFile: false,
    preview: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
    build: { outDir: join(root, 'dist') },
    logLevel: 'warn',
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() => globalThis.__duskResult !== undefined, undefined, { timeout: 120_000 });
    const result = await page.evaluate(() => globalThis.__duskResult);
    assert.deepEqual(errors, []);
    assert.ok(!result.error, result.error);
    assert.equal(result.dpmStatus, 0);
    assert.match(result.help, /Dusk Package Manager/);
    assert.match(result.output, /esm=42/);
    assert.equal(result.uvStatus, 0, result.uv);
    assert.match(result.uv, /^uv \d+\.\d+\.\d+/);
  } finally {
    await browser.close();
    await new Promise((resolveClose, rejectClose) => server.httpServer.close((error) => error ? rejectClose(error) : resolveClose()));
  }
  console.log('Packed Vite consumer booted Dusk, transformed ESM, ran DPM help and booted uv');
} finally {
  await rm(root, { recursive: true, force: true });
}
