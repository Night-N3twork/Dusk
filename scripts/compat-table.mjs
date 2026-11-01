import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('test/fixtures/compat.json', root), 'utf8'));
const readmePath = fileURLToPath(new URL('README.md', root));

const LABELS = { supported: 'Supported', partial: 'Partial', stub: 'Stub' };

const rows = manifest
  .slice()
  .sort((a, b) => a.module.localeCompare(b.module))
  .map(({ module, status, notes }) => `| \`node:${module}\` | ${LABELS[status]} | ${notes} |`);

const table = ['| Module | Status | Notes |', '|--------|--------|-------|', ...rows].join('\n');

const readme = readFileSync(readmePath, 'utf8');
const heading = '## Node.js Compatibility';
const start = readme.indexOf(heading);
if (start === -1) throw new Error(`README.md has no "${heading}" section`);
const tableStart = readme.indexOf('| Module |', start);
const next = readme.indexOf('\n## ', start + heading.length);
const tableEnd = readme.indexOf('\n\n', tableStart);
if (tableStart === -1 || (next !== -1 && tableStart > next)) throw new Error('Compatibility section has no table');

const updated = readme.slice(0, tableStart) + table + readme.slice(tableEnd === -1 ? readme.length : tableEnd);

if (process.argv.includes('--check')) {
  if (updated !== readme) {
    console.error('README.md compatibility table is out of date; run `node scripts/compat-table.mjs`');
    process.exit(1);
  }
} else {
  writeFileSync(readmePath, updated);
}
