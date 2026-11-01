import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';
import manifest from './fixtures/compat.json';

interface Entry {
  module: string;
  status: 'supported' | 'partial' | 'stub';
  exports: string[];
}

test('the compatibility manifest matches what each builtin module exports', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  try {
    const entries = manifest as Entry[];
    const probe = `
      const entries = ${JSON.stringify(entries.map(({ module, exports }) => ({ module, exports })))};
      const report = {};
      for (const { module, exports } of entries) {
        try {
          const loaded = require('node:' + module);
          report[module] = exports.filter((name) => loaded[name] === undefined);
        } catch (error) {
          report[module] = 'load failed: ' + error.message;
        }
      }
      process.stdout.write(JSON.stringify(report));
    `;
    const result = await repl.processManager.spawnSync('/bin/node', ['-e', probe], { cwd: '/' });
    const report = JSON.parse(new TextDecoder().decode(result.stdout)) as Record<string, string[] | string>;
    const expected = Object.fromEntries(entries.map((entry) => [entry.module, []]));
    expect(report).toEqual(expected);
    const builtins = await repl.processManager.spawnSync('/bin/node', ['-e', "process.stdout.write(JSON.stringify(require('module').builtinModules))"], { cwd: '/' });
    const listed = new Set(JSON.parse(new TextDecoder().decode(builtins.stdout)) as string[]);
    expect(entries.map((entry) => entry.module).filter((name) => !listed.has(name) && !listed.has(`node:${name}`))).toEqual([]);
  } finally {
    await repl.dispose();
  }
}, 60_000);
