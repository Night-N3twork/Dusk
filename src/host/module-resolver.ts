import type { FSBackend } from './fs-backend';
import { dirname, norm } from './vfs';
import { createNativePackageRegistry, type NativePackageRegistry } from './native-package-registry';

export type ModuleMode = 'import' | 'require';
export interface ResolvedModule { path: string; format: 'esm' | 'cjs' | 'json'; }

type PackageMap = string | null | PackageMap[] | { [key: string]: PackageMap };
interface PackageJson { main?: string; type?: 'module' | 'commonjs'; version?: string; exports?: PackageMap; imports?: PackageMap; }

const parsePackageRequest = (request: string): { pkg: string; subpath: string } => {
  const firstSlash = request.indexOf('/');
  const packageEnd = request.startsWith('@') ? request.indexOf('/', firstSlash + 1) : firstSlash;
  if (packageEnd === -1) return { pkg: request, subpath: '.' };
  return { pkg: request.slice(0, packageEnd), subpath: '.' + request.slice(packageEnd) };
};

const matchPattern = (pattern: string, subpath: string): string | undefined => {
  const index = pattern.indexOf('*');
  if (index === -1) return pattern === subpath ? '' : undefined;
  const prefix = pattern.slice(0, index);
  const suffix = pattern.slice(index + 1);
  return subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length
    ? subpath.slice(prefix.length, subpath.length - suffix.length) : undefined;
};

const selectTarget = (map: PackageMap, conditions: Set<string>): string | null => {
  if (map === null || typeof map === 'string') return map;
  if (Array.isArray(map)) {
    for (const target of map) { const selected = selectTarget(target, conditions); if (selected !== null) return selected; }
    return null;
  }
  for (const [condition, target] of Object.entries(map)) {
    if (condition === 'default' || conditions.has(condition)) {
      const selected = selectTarget(target, conditions);
      if (selected === null) return null;
      return selected;
    }
  }
  return null;
};

const selectPackageTarget = (map: PackageMap, subpath: string, conditions: Set<string>): string | null => {
  if (typeof map === 'string' || map === null || Array.isArray(map)) return subpath === '.' ? selectTarget(map, conditions) : null;
  const keys = Object.keys(map);
  if (!keys.every((key) => key.startsWith('.'))) return subpath === '.' ? selectTarget(map, conditions) : null;
  if (map[subpath] !== undefined) return selectTarget(map[subpath]!, conditions);
  for (const key of keys.sort((a, b) => b.length - a.length)) {
    const capture = matchPattern(key, subpath);
    if (capture !== undefined) {
      const target = selectTarget(map[key]!, conditions);
      return target?.replaceAll('*', capture) ?? null;
    }
  }
  return null;
};

const selectImportsTarget = (map: PackageMap, request: string, conditions: Set<string>): string | null => {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return null;
  if (map[request] !== undefined) return selectTarget(map[request]!, conditions);
  for (const key of Object.keys(map).filter((key) => key.startsWith('#')).sort((a, b) => b.length - a.length)) {
    const capture = matchPattern(key, request);
    if (capture !== undefined) {
      const target = selectTarget(map[key]!, conditions);
      return target?.replaceAll('*', capture) ?? null;
    }
  }
  return null;
};

const emptyNativePackageRegistry = createNativePackageRegistry();

export const resolveModule = async (fs: FSBackend, request: string, fromDir: string, mode: ModuleMode, aliases = new Set<string>(), nativePackageRegistry: NativePackageRegistry = emptyNativePackageRegistry): Promise<ResolvedModule> => {
  if (fromDir.startsWith('file:')) {
    const url = new URL(fromDir);
    if (url.protocol === 'file:' && !url.hostname) fromDir = decodeURIComponent(url.pathname);
  }
  const nativeReplacement = nativePackageRegistry.resolve(request);
  if (nativeReplacement !== undefined) return { path: nativeReplacement, format: 'cjs' };
  const conditions = new Set(['node', 'default', mode]);
  const packageType = async (path: string): Promise<'module' | 'commonjs'> => {
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      const manifest = dir + '/package.json';
      if (await fs.exists(manifest)) return (JSON.parse(await fs.readFile(manifest)) as PackageJson).type ?? 'commonjs';
      if (dir === '/') return 'commonjs';
    }
  };
  const format = async (path: string): Promise<ResolvedModule['format']> =>
    path.endsWith('.json') ? 'json' : path.endsWith('.mjs') ? 'esm' : path.endsWith('.cjs') ? 'cjs' : await packageType(path) === 'module' ? 'esm' : 'cjs';
  const asResolved = async (path: string): Promise<ResolvedModule> => {
    const normalized = norm(path);
    if (normalized.endsWith('.node')) nativePackageRegistry.resolve(normalized);
    return { path: normalized, format: await format(normalized) };
  };
  const tryFile = async (path: string): Promise<ResolvedModule | undefined> => {
    const normalized = norm(path);
    if (await fs.exists(normalized) && (await fs.stat(normalized)).isFile) return asResolved(normalized);
    for (const extension of ['.mjs', '.cjs', '.js', '.json']) if (await fs.exists(normalized + extension)) return asResolved(normalized + extension);
    if (!(await fs.exists(normalized)) || !(await fs.stat(normalized)).isDirectory) return undefined;
    const manifest = normalized + '/package.json';
    if (await fs.exists(manifest)) {
      const pkg = JSON.parse(await fs.readFile(manifest)) as PackageJson;
      if (pkg.main) { const resolved = await tryFile(normalized + '/' + pkg.main); if (resolved) return resolved; }
    }
    return tryFile(normalized + '/index');
  };
  const resolveTarget = async (root: string, target: string, requestName: string): Promise<ResolvedModule> => {
    if (!target.startsWith('./') || target.split('/').some((part) => part === '..' || part === 'node_modules')) throw new Error(`Invalid package target '${target}' for ${requestName}`);
    const resolved = await tryFile(root + '/' + target.slice(2));
    if (!resolved) throw new Error(`Module ${requestName}: target '${target}' does not exist`);
    return resolved;
  };

  if (request.startsWith('./') || request.startsWith('../') || request.startsWith('/')) {
    const resolved = await tryFile(request.startsWith('/') ? request : fromDir + '/' + request);
    if (resolved) return resolved;
    throw new Error('Cannot find module ' + request);
  }
  if (request.startsWith('#')) {
    if (aliases.has(request)) throw new Error(`ERR_PACKAGE_IMPORT_CYCLE: cyclic package imports alias ${request}`);
    const nextAliases = new Set(aliases);
    nextAliases.add(request);
    for (let dir = fromDir; ; dir = dirname(dir)) {
      const manifest = dir + '/package.json';
      if (await fs.exists(manifest)) {
        const pkg = JSON.parse(await fs.readFile(manifest)) as PackageJson;
        const target = pkg.imports && selectImportsTarget(pkg.imports, request, conditions);
        if (target) return target.startsWith('./') ? resolveTarget(dir, target, request) : resolveModule(fs, target, dir, mode, nextAliases);
        throw new Error(`Module ${request} is not defined by "imports" in ${manifest}`);
      }
      if (dir === '/') break;
    }
    throw new Error('Cannot find module ' + request);
  }

  const { pkg, subpath } = parsePackageRequest(request);
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const root = dir + '/node_modules/' + pkg;
    const manifest = root + '/package.json';
    if (await fs.exists(manifest)) {
        const packageJson = JSON.parse(await fs.readFile(manifest)) as PackageJson;
        const replaceSource = (resolved: ResolvedModule): ResolvedModule => {
          const nativeReplacement = nativePackageRegistry.resolve(request, {
          packageRoot: root,
          ...(packageJson.version ? { packageVersion: packageJson.version } : {}),
            packageEntryPath: resolved.path,
          });
          return nativeReplacement === undefined ? resolved : { path: nativeReplacement, format: 'cjs' };
        };
        if (packageJson.exports !== undefined) {
        const target = selectPackageTarget(packageJson.exports, subpath, conditions);
        if (target !== null) return replaceSource(await resolveTarget(root, target, request));
        throw new Error(`Module ${request}: subpath '${subpath}' is not defined by "exports" in ${pkg}/package.json`);
      }
      const resolved = await tryFile(root + (subpath === '.' ? '' : subpath.slice(1)));
      if (resolved) return replaceSource(resolved);
      const nativeReplacement = nativePackageRegistry.resolve(request, {
        packageRoot: root,
        ...(packageJson.version ? { packageVersion: packageJson.version } : {}),
      });
      if (nativeReplacement !== undefined) return { path: nativeReplacement, format: 'cjs' };
    }
    if (dir === '/') break;
  }
  throw new Error('Cannot find module ' + request);
};
