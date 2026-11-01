import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';
import type { FSBackend } from '../src/host/fs-backend';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

test('tsx runs TypeScript with local imports, node_modules, tsconfig and arguments', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  try {
    await fs.mkdir('/app/src/lib', { recursive: true });
    await fs.mkdir('/app/node_modules/greeter', { recursive: true });
    await fs.writeFile('/app/node_modules/greeter/package.json', '{"name":"greeter","main":"index.js"}');
    await fs.writeFile('/app/node_modules/greeter/index.js', 'module.exports = (name) => `hello ${name}`;');
    await fs.writeFile('/app/tsconfig.json', '{\n  // comments are allowed\n  "compilerOptions": { "experimentalDecorators": true, },\n}');
    await fs.writeFile('/app/src/lib/math.ts', 'export const add = (a: number, b: number): number => a + b;\nexport enum Color { Red = "red" }\n');
    await fs.writeFile('/app/src/main.ts', [
      "import { add, Color } from './lib/math.js';",
      "import greet from 'greeter';",
      'interface Options { verbose?: boolean }',
      'const opts: Options = { verbose: true };',
      "console.log(greet('tsx'), add(2, 3), Color.Red, opts.verbose, process.argv.slice(2).join(','));",
      'console.log(typeof __filename, import.meta.url.endsWith("main.ts"));',
    ].join('\n'));
    const run = await repl.processManager.spawnSync('/bin/tsx', ['src/main.ts', 'a', 'b'], { cwd: '/app' });
    expect(decode(run.stderr)).toBe('');
    expect(decode(run.stdout)).toBe('hello tsx 5 red true a,b\nstring true\n');

    await fs.writeFile('/app/top.ts', 'const value: number = await Promise.resolve(41);\nconsole.log(value + 1);\n');
    const tla = await repl.processManager.spawnSync('/bin/tsx', ['top.ts'], { cwd: '/app' });
    expect(decode(tla.stdout)).toBe('42\n');
    expect((await fs.readdir('/app')).filter((name) => name.includes('.tsx.mjs'))).toEqual([]);

    const printed = await repl.processManager.spawnSync('/bin/dsh', ['-c', "tsx -p '[1, 2].map((n: number) => n * 2)'"], { cwd: '/app' });
    expect(decode(printed.stdout)).toBe('[ 2, 4 ]\n');

    await fs.writeFile('/app/bad.ts', 'const x: number = ;\n');
    const bad = await repl.processManager.spawnSync('/bin/tsx', ['bad.ts'], { cwd: '/app' });
    expect(bad.status).toBe(1);
    expect(decode(bad.stderr)).toContain('bad.ts:1');
  } finally {
    await repl.dispose();
  }
}, 120_000);
