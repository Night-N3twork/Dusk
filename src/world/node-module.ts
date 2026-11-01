const builtins = [
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster',
  'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'dns/promises', 'events', 'fs',
  'fs/promises', 'http', 'http2', 'https', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'querystring', 'readline', 'readline/promises', 'repl', 'stream',
  'stream/promises', 'string_decoder', 'timers', 'timers/promises', 'tls', 'tty', 'url',
  'util', 'util/types', 'v8', 'vm', 'worker_threads', 'zlib',
];

const prefixOnly = ['node:sqlite', 'node:test', 'node:test/reporters'];

type Require = ((request: string) => unknown) & { resolve: (request: string) => string };

export const nodeModule = {
  builtinModules: [...builtins, ...prefixOnly],
  isBuiltin: (id: string): boolean => {
    const bare = id.startsWith('node:') ? id.slice(5) : id;
    return builtins.includes(bare) || prefixOnly.includes(id);
  },
  createRequire: (filename: string): Require => {
    const requireFrom = (globalThis as Record<string, unknown>)['__duskRequireFrom'];
    if (typeof requireFrom !== 'function') throw new Error('require is not installed');
    const dir = filename.split('/').slice(0, -1).join('/') || '/';
    return (requireFrom as (fromDir: string) => Require)(dir);
  },
};
