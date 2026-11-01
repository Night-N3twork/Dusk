import { expect, test } from 'vitest';
import manifest from '../package.json';
import license from '../LICENSE?raw';
import archiveArtifactTest from './dpm-browser-archive-artifacts.test.ts?raw';
import fsWatchTest from './fs-watch.test.ts?raw';
import vitestConfig from '../vitest.config.ts?raw';
import libraryConfig from '../vite.lib.config.ts?raw';
import readme from '../README.md?raw';

const releaseManifest = manifest as {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  files?: string[];
  exports?: Record<string, unknown>;
};

test('published Dusk manifest is self-contained and depends on registry runtime artifacts', () => {
  expect(releaseManifest.version).toBe('1.0.1');
  expect(releaseManifest.dependencies?.['@nightnetwork/dpm']).toBe('1.0.0');
  expect(releaseManifest.dependencies?.['@nightnetwork/moonbeam']).toBe('^1.1.1');
  expect(releaseManifest.dependencies?.['@nightnetwork/nova']).toBe('^1.1.0');
  expect(Object.keys(releaseManifest.dependencies ?? {}).sort()).toEqual(['@nightnetwork/dpm', '@nightnetwork/moonbeam', '@nightnetwork/nova']);
  expect(releaseManifest.devDependencies?.['fast-xml-parser']).toBe('^5.10.1');
  expect(releaseManifest.devDependencies?.minimatch).toBe('^10.2.6');
  expect(releaseManifest.devDependencies?.['smol-toml']).toBe('^1.9.0');
  expect(releaseManifest.devDependencies?.vitest).toBe('^4.1.11');
  expect(releaseManifest.devDependencies?.['@vitest/browser']).toBe('^4.1.11');
  expect(releaseManifest.devDependencies?.['@vitest/browser-playwright']).toBe('^4.1.11');
  expect(releaseManifest.dependencies?.['@nightnetwork/lunassh']).toBeUndefined();
  expect(releaseManifest.devDependencies?.['@nightnetwork/lunassh']).toBeUndefined();
  expect(JSON.stringify(releaseManifest)).not.toContain('file:../../LunaSSH');
  expect(JSON.stringify(releaseManifest)).not.toContain('file:');
  expect(releaseManifest.scripts?.prebuild).toBeUndefined();
  expect(releaseManifest.scripts?.predev).toBeUndefined();
  expect(releaseManifest.scripts?.pretest).toBeUndefined();
  expect(releaseManifest.files).toEqual(['lib', 'README.md', 'CHANGELOG.md', 'LICENSE', 'ESBUILD-LICENSE.md']);
});

test('npm pack consumes published DPM and exposes only shipped entrypoints', () => {
  expect(releaseManifest.scripts?.prepack).toBe('npm run build:lib');
  expect(releaseManifest.scripts?.['build:dpm-wasm']).toBeUndefined();
  expect(releaseManifest.scripts?.['test:dpm-wasm']).toBeUndefined();
  expect(releaseManifest.scripts?.['build:dpm-bundles']).toBeUndefined();
  expect(releaseManifest.scripts?.['test:dpm-bundles']).toBeUndefined();
  expect(releaseManifest.scripts?.['verify:release']).toBe('npm test && npm run typecheck && node scripts/verify-release.mjs');
  expect(releaseManifest.scripts?.prepublishOnly).toBe('npm run verify:release');
  expect(releaseManifest.scripts?.prepare).toBeUndefined();
  expect(releaseManifest.exports).toEqual({
    '.': { types: './lib/types/index.d.ts', import: './lib/duskjs.js' },
  });
});

test('library source maps embed source content for consumer debugging', () => {
  expect(libraryConfig).not.toContain('sourcemapExcludeSources');
  expect(libraryConfig).toContain('sourcemap: true');
});

test('browser requirements document origin-wide TFS locking', () => {
  expect(readme).toContain('Web Locks API');
});

test('browser archive fixtures resolve from project-local test fixtures', () => {
  expect(archiveArtifactTest).not.toContain('/home/amplify/');
  expect(archiveArtifactTest).toContain("new URL('./fixtures/dpm-browser-archive/tar-0.1.1.tgz', import.meta.url)");
  expect(archiveArtifactTest).not.toContain('dpm-browser-archive-packages');
  expect(vitestConfig).not.toContain('dpm-browser-archive-packages');
});

test('TFS integration tests do not suppress JSON parse regressions', () => {
  for (const source of [archiveArtifactTest, fsWatchTest]) {
    expect(source).not.toContain("addEventListener('unhandledrejection'");
    expect(source).not.toContain('swallowTfsVendorRejection');
  }
});

test('published license contains the complete Apache 2.0 terms and Night Network notice', () => {
  expect(license).toContain('Apache License\n                           Version 2.0, January 2004');
  for (const section of [
    '1. Definitions.', '2. Grant of Copyright License.', '3. Grant of Patent License.',
    '4. Redistribution.', '5. Submission of Contributions.', '6. Trademarks.',
    '7. Disclaimer of Warranty.', '8. Limitation of Liability.',
    '9. Accepting Warranty or Additional Liability.', 'END OF TERMS AND CONDITIONS',
    'APPENDIX: How to apply the Apache License to your work.',
  ]) {
    expect(license).toContain(section);
  }
  expect(license).toContain('Copyright 2026 Night Network');
});
