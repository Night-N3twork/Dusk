import { expect, test } from 'vitest';
import { createMemoryBackend } from '../src/host/fs-backend';
import { resolveModule } from '../src/host/module-resolver';
import { createFuncs } from '../src/host/funcs';
import { createRunner } from '../src/host/runner';
import { ProcessManager } from '../src/host/process-manager';
import { createNativePackageRegistry } from '../src/host/native-package-registry';

const writeScopedExportsPackage = async () => {
  const fs = createMemoryBackend();
  await fs.mkdir('/app/node_modules/@scope/exports-only/dist', { recursive: true });
  await fs.writeFile('/app/node_modules/@scope/exports-only/package.json', JSON.stringify({
    type: 'module',
    exports: { '.': { import: './dist/import.mjs', require: './dist/require.cjs' } },
  }));
  await fs.writeFile('/app/node_modules/@scope/exports-only/dist/import.mjs', "export const value = 'import';");
  await fs.writeFile('/app/node_modules/@scope/exports-only/dist/require.cjs', "module.exports = 'require';");
  await fs.writeFile('/app/main.mjs', "export { value } from '@scope/exports-only';");
  return fs;
};

test('resolves scoped exports and formats by module mode', async () => {
  const fs = await writeScopedExportsPackage();

  await expect(resolveModule(fs, '@scope/exports-only', '/app', 'import')).resolves.toEqual({
    path: '/app/node_modules/@scope/exports-only/dist/import.mjs', format: 'esm',
  });
  await expect(resolveModule(fs, '@scope/exports-only', '/app', 'require')).resolves.toEqual({
    path: '/app/node_modules/@scope/exports-only/dist/require.cjs', format: 'cjs',
  });
});

test('CommonJS require.resolve resolves relative files and exported package subpaths', async () => {
  const fs = createMemoryBackend();
  await fs.mkdir('/app/node_modules/exports-only', { recursive: true });
  await fs.writeFile('/app/node_modules/exports-only/package.json', JSON.stringify({
    exports: { './feature': { require: './feature.cjs' } },
  }));
  await fs.writeFile('/app/node_modules/exports-only/feature.cjs', 'module.exports = "feature";');
  await fs.writeFile('/app/relative.js', 'module.exports = "relative";');
  await fs.writeFile('/app/main.cjs', `
    let missing;
    try { require.resolve('missing-module'); } catch (error) { missing = String(error); }
    module.exports = [
      require.resolve('./relative'),
      require.resolve('exports-only/feature'),
      missing,
    ];
  `);
  const out: string[] = [];
  const runner = await createRunner(createFuncs(fs, (text) => out.push(text)));

  await runner.run('console.log(JSON.stringify(require("/app/main.cjs")));');
  runner.stop();

  expect(JSON.parse(out.join(''))).toEqual([
    '/app/relative.js',
    '/app/node_modules/exports-only/feature.cjs',
    expect.stringContaining('Cannot find module missing-module'),
  ]);
}, 60_000);

test('resolves conditional package imports aliases', async () => {
  const fs = createMemoryBackend();
  await fs.mkdir('/app/src', { recursive: true });
  await fs.writeFile('/app/package.json', JSON.stringify({
    imports: { '#alias': { import: './src/import.mjs', require: './src/require.cjs' } },
  }));
  await fs.writeFile('/app/src/import.mjs', 'export const value = 1;');
  await fs.writeFile('/app/src/require.cjs', 'module.exports = 1;');

  await expect(resolveModule(fs, '#alias', '/app', 'import')).resolves.toEqual({
    path: '/app/src/import.mjs', format: 'esm',
  });
  await expect(resolveModule(fs, '#alias', '/app', 'require')).resolves.toEqual({
    path: '/app/src/require.cjs', format: 'cjs',
  });
});

test('scopes the Vite Rollup browser replacement to Vite 5.4.21\'s nested Rollup 4.20.0', async () => {
  const fs = createMemoryBackend();
  await fs.mkdir('/project/node_modules/rollup', { recursive: true });
  await fs.writeFile('/project/node_modules/rollup/package.json', JSON.stringify({ version: '4.24.0', main: './index.js' }));
  await fs.writeFile('/project/node_modules/rollup/index.js', 'module.exports = "user Rollup";');
  await fs.mkdir('/project/node_modules/vite/node_modules/rollup/dist', { recursive: true });
  await fs.writeFile('/project/node_modules/vite/node_modules/rollup/package.json', JSON.stringify({ version: '4.20.0', main: './dist/rollup.js' }));
  await fs.writeFile('/project/node_modules/vite/node_modules/rollup/dist/rollup.js', 'module.exports = "Vite Rollup";');
  await fs.mkdir('/project/node_modules/vite/dist/node/chunks', { recursive: true });
  await fs.writeFile('/project/node_modules/vite/dist/node/chunks/resolve-rollup.cjs', 'const path = require("path"); const rollup = require.resolve("rollup"); module.exports = [rollup, path.resolve(rollup, "../../package.json")];');
  await fs.mkdir('/project/node_modules/vite-next/node_modules/rollup', { recursive: true });
  await fs.writeFile('/project/node_modules/vite-next/node_modules/rollup/package.json', JSON.stringify({ version: '4.21.0', main: './index.js' }));
  await fs.writeFile('/project/node_modules/vite-next/node_modules/rollup/index.js', 'module.exports = "wrong Vite Rollup";');
  await fs.mkdir('/project/node_modules/custom/node_modules/rollup', { recursive: true });
  await fs.writeFile('/project/node_modules/custom/node_modules/rollup/package.json', JSON.stringify({ version: '4.20.0', main: './index.js' }));
  await fs.writeFile('/project/node_modules/custom/node_modules/rollup/index.js', 'module.exports = "non-Vite Rollup";');
  const registry = createNativePackageRegistry([
    ['rollup', 'module.exports = "browser Rollup";', { packageVersion: '4.20.0', packagePathSuffix: '/node_modules/vite/node_modules/rollup' }],
  ]);

  await expect(resolveModule(fs, 'rollup', '/project', 'require', new Set(), registry)).resolves.toMatchObject({
    path: '/project/node_modules/rollup/index.js',
  });
  await expect(resolveModule(fs, 'rollup', 'file:///project/node_modules/vite/dist/node/chunks', 'require', new Set(), registry)).resolves.toMatchObject({
    path: '/project/node_modules/vite/node_modules/rollup/dist/rollup.js',
  });
  await expect(resolveModule(fs, 'rollup', '/project/node_modules/vite-next', 'require', new Set(), registry)).resolves.toMatchObject({
    path: '/project/node_modules/vite-next/node_modules/rollup/index.js',
  });
  await expect(resolveModule(fs, 'rollup', '/project/node_modules/custom', 'require', new Set(), registry)).resolves.toMatchObject({
    path: '/project/node_modules/custom/node_modules/rollup/index.js',
  });

  const out: string[] = [];
  const runner = await createRunner(createFuncs(fs, (text) => out.push(text), registry));
  await runner.run('console.log(JSON.stringify(require("/project/node_modules/vite/dist/node/chunks/resolve-rollup.cjs")));');
  runner.stop();

  expect(registry.readSource('/project/node_modules/vite/node_modules/rollup/dist/rollup.js')).toBe('module.exports = "browser Rollup";');
  expect(JSON.parse(out.join(''))).toEqual([
    '/project/node_modules/vite/node_modules/rollup/dist/rollup.js',
    '/project/node_modules/vite/node_modules/rollup/package.json',
  ]);
});

test('re-resolves registered native virtual IDs for SystemJS imports and CommonJS requires', async () => {
  const fs = createMemoryBackend();
  const registry = createNativePackageRegistry({ 'rollup/parseAst': 'module.exports = {};' });
  const virtualId = registry.resolve('rollup/parseAst')!;

  await expect(resolveModule(fs, virtualId, '/app', 'import', new Set(), registry)).resolves.toEqual({
    path: virtualId,
    format: 'cjs',
  });
  await expect(resolveModule(fs, virtualId, '/app', 'require', new Set(), registry)).resolves.toEqual({
    path: virtualId,
    format: 'cjs',
  });
  await expect(resolveModule(fs, '/.dusk-native-fallback/unregistered.js', '/app', 'require', new Set(), registry))
    .rejects.toThrow();
});

test('resolves package imports aliases to external packages in the active mode', async () => {
  const fs = createMemoryBackend();
  await fs.mkdir('/app/node_modules/target', { recursive: true });
  await fs.writeFile('/app/package.json', JSON.stringify({ imports: { '#target': 'target' } }));
  await fs.writeFile('/app/node_modules/target/package.json', JSON.stringify({
    exports: { '.': { import: './import.mjs', require: './require.cjs' } },
  }));
  await fs.writeFile('/app/node_modules/target/import.mjs', 'export {};');
  await fs.writeFile('/app/node_modules/target/require.cjs', 'module.exports = {};');

  await expect(resolveModule(fs, '#target', '/app', 'import')).resolves.toMatchObject({ path: '/app/node_modules/target/import.mjs', format: 'esm' });
  await expect(resolveModule(fs, '#target', '/app', 'require')).resolves.toMatchObject({ path: '/app/node_modules/target/require.cjs', format: 'cjs' });
});

test('rejects unsafe package targets and null import conditions', async () => {
  const fs = createMemoryBackend();
  await fs.mkdir('/app/node_modules/pkg', { recursive: true });
  await fs.writeFile('/app/package.json', JSON.stringify({ imports: { '#blocked': { import: null, default: './fallback.mjs' } } }));
  await fs.writeFile('/app/node_modules/pkg/package.json', JSON.stringify({
    exports: { '.': './../escape.mjs', './node': './node_modules/escape.mjs' },
  }));

  await expect(resolveModule(fs, '#blocked', '/app', 'import')).rejects.toThrow('not defined');
  await expect(resolveModule(fs, 'pkg', '/app', 'import')).rejects.toThrow('Invalid package target');
  await expect(resolveModule(fs, 'pkg/node', '/app', 'import')).rejects.toThrow('Invalid package target');
});

test('classifies JavaScript by the nearest package type', async () => {
  const fs = createMemoryBackend();
  await fs.mkdir('/app/module/nested', { recursive: true });
  await fs.mkdir('/app/commonjs/nested', { recursive: true });
  await fs.writeFile('/app/module/package.json', JSON.stringify({ type: 'module' }));
  await fs.writeFile('/app/commonjs/package.json', JSON.stringify({ type: 'commonjs' }));
  await fs.writeFile('/app/module/nested/index.js', 'export {};');
  await fs.writeFile('/app/commonjs/nested/index.js', 'module.exports = {};');

  await expect(resolveModule(fs, './nested/index.js', '/app/module', 'import')).resolves.toMatchObject({ format: 'esm' });
  await expect(resolveModule(fs, './nested/index.js', '/app/commonjs', 'import')).resolves.toMatchObject({ format: 'cjs' });
});

test('rejects direct and indirect cyclic package imports aliases', async () => {
  const fs = createMemoryBackend();
  await fs.writeFile('/package.json', JSON.stringify({ imports: { '#direct': '#direct', '#first': '#second', '#second': '#first' } }));

  await expect(resolveModule(fs, '#direct', '/', 'import')).rejects.toThrow('cyclic package imports');
  await expect(resolveModule(fs, '#first', '/', 'import')).rejects.toThrow('cyclic package imports');
});

test('resolves an exports-only scoped package identically through both host runners', async () => {
  const directFs = await writeScopedExportsPackage();
  const directOut: string[] = [];
  const direct = await createRunner(createFuncs(directFs, (text) => directOut.push(text)));
  await direct.run("console.log((await import('/app/main.mjs')).value);");
  direct.stop();

  const managerFs = await writeScopedExportsPackage();
  const managerOut: string[] = [];
  const manager = new ProcessManager(managerFs);
  const engine = await manager.createPidZero({}, (text) => managerOut.push(text));
  await engine.run("console.log((await import('/app/main.mjs')).value);");
  await engine.terminate();

  expect(directOut.join('')).toContain('import');
  expect(managerOut.join('')).toContain('import');
}, 60_000);
