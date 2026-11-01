import 'systemjs/s.js';

declare const System: SystemLoader;

interface SystemLoader {
  constructor: new () => SystemLoader;
  import(id: string, parentUrl?: string): Promise<Record<string, unknown>>;
  resolve(id: string, parentUrl?: string): string;
  instantiate(id: string, parentUrl?: string): unknown;
  createContext(id: string): { url: string; filename?: string; dirname?: string; resolve(id: string, parentUrl?: string): string };
  getRegister(id?: string): unknown;
}

interface ModuleMetadata {
  exports: string[];
  imports: Record<string, string[]>;
  stars: string[];
}

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const call = (f: string, extra: Record<string, unknown>): unknown => {
  const result = ipc.send({ f, ...extra });
  if (result.error) throw new Error(result.error);
  return result.value;
};

const dirOf = (path: string): string => path.split('/').slice(0, -1).join('/') || '/';

const fileUrlForVfsPath = (id: string): string =>
  id.startsWith('/')
    ? `file://${encodeURI(id).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
    : id;

const vfsPathForResolution = (id: string): string => {
  if (!id.startsWith('file:')) return id;
  const url = new URL(id);
  return url.protocol === 'file:' && !url.hostname ? decodeURIComponent(url.pathname) : id;
};

const registration = (value: unknown, namespace = false): unknown => [[], (exportValue: (name: string, value: unknown) => void) => ({
  setters: [],
  execute: (): void => {
    if (!namespace) {
      exportValue('default', value);
      return;
    }
    const values = value as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(values)) exportValue(name, values[name]);
  },
})];

export const createSystemLoader = (builtins: Record<string, Record<string, unknown>>): SystemLoader => {
  const loader = new System.constructor();
  const metadata = new Map<string, ModuleMetadata>();
  const formats = new Map<string, 'esm' | 'cjs' | 'json'>();
  const cjsNamespaces = new Map<string, Record<string, unknown>>();

  loader.resolve = (request: string, parentUrl = '/') => {
    if (builtins[request]) return request;
    const resolved = call('module.resolve', { request, fromDir: dirOf(vfsPathForResolution(parentUrl)), mode: 'import' }) as { path: string; format: 'esm' | 'cjs' | 'json' };
    formats.set(resolved.path, resolved.format);
    return resolved.path;
  };
  loader.createContext = (id: string) => {
    const path = vfsPathForResolution(id);
    const local = path.startsWith('/');
    return {
      url: fileUrlForVfsPath(id),
      ...(local ? { filename: path, dirname: dirOf(path) } : {}),
      resolve: (request: string, parentUrl = id): string => {
        const resolved = loader.resolve(request, parentUrl);
        return builtins[resolved] ? (resolved.startsWith('node:') ? resolved : 'node:' + resolved) : fileUrlForVfsPath(resolved);
      },
    };
  };
  loader.instantiate = (id: string): unknown => {
    const builtin = builtins[id];
    if (builtin) return registration(builtin, true);

    const source = call('module.readSource', { path: id, mode: 'import' }) as string;
    if (id.endsWith('.json')) return registration(JSON.parse(source));
    if (formats.get(id) === 'cjs') {
      const requireFrom = (globalThis as Record<string, unknown>)['__duskRequireFrom'] as (fromDir: string) => (request: string) => unknown;
      const value = requireFrom(dirOf(id))(id);
      const namespace = { ...(value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}), default: value };
      cjsNamespaces.set(id, namespace);
      return registration(namespace, true);
    }
    (0, eval)(source + '\n//# sourceURL=' + id);
    const global = globalThis as Record<string, unknown>;
    const moduleMetadata = global['__duskSystemMetadata'] as ModuleMetadata | undefined;
    delete global['__duskSystemMetadata'];
    if (moduleMetadata) metadata.set(id, moduleMetadata);
    const register = loader.getRegister() as [string[], (exportValue: unknown, context: unknown) => { setters?: Array<(namespace: Record<string, unknown>) => void> }] | undefined;
    if (!register) return register;
    const [dependencies, declare] = register;
    return [dependencies, (exportValue: unknown, context: unknown) => {
      const declared = declare(exportValue, context);
      const imports = moduleMetadata?.imports ?? {};
      const hasExport = (dependency: string, name: string, visited = new Set<string>()): boolean => {
        if (visited.has(dependency)) return false;
        visited.add(dependency);
        if (builtins[dependency]) return name in builtins[dependency];
        if (dependency.endsWith('.json')) return name === 'default';
        if (formats.get(dependency) === 'cjs') return name in (cjsNamespaces.get(dependency) ?? {});
        const dependencyMetadata = metadata.get(dependency);
        return Boolean(dependencyMetadata?.exports.includes(name)
          || dependencyMetadata?.stars.some((star) => hasExport(loader.resolve(star, dependency), name, visited)));
      };
      const setters = (declared.setters ?? []).map((setter, index) => (namespace: Record<string, unknown>) => {
        const dependency = loader.resolve(dependencies[index]!, id);
        for (const name of imports[dependencies[index]!] ?? []) {
          if (!hasExport(dependency, name)) throw new SyntaxError(`The requested module '${dependencies[index]}' does not provide an export named '${name}'`);
        }
        setter(namespace);
      });
      return { ...declared, setters };
    }];
  };
  return loader;
};
