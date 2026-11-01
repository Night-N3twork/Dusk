import { waitForActiveHandles } from '../node/main';

interface Proc {
  argv: string[];
  cwd: () => string;
  exitCode?: number;
  exit?: (code: number) => void;
  stdout: { write: (data: string | Uint8Array) => void };
  stderr: { write: (data: string | Uint8Array) => void };
}

interface FsModule {
  existsSync(path: string): boolean;
  statSync(path: string): { isFile(): boolean };
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  unlinkSync(path: string): void;
}

interface PathModule {
  resolve(...parts: string[]): string;
  dirname(path: string): string;
  join(...parts: string[]): string;
  basename(path: string): string;
}

interface EsbuildMessage {
  text: string;
  location?: { file: string; line: number; column: number; lineText: string } | null;
}

interface EsbuildResult {
  outputFiles?: Array<{ text: string }>;
  code?: string;
  errors: EsbuildMessage[];
  warnings: EsbuildMessage[];
}

interface PluginBuild {
  onResolve(options: { filter: RegExp }, callback: (args: { path: string; importer: string; resolveDir: string; kind: string }) => unknown): void;
  onLoad(options: { filter: RegExp; namespace?: string }, callback: (args: { path: string }) => unknown): void;
}

interface Esbuild {
  build(options: Record<string, unknown>): Promise<EsbuildResult>;
  transform(code: string, options: Record<string, unknown>): Promise<EsbuildResult>;
}

type Require = ((id: string) => unknown) & { resolve?: (id: string) => string };

const load = <T>(id: string): T => ((globalThis as { require: Require }).require)(id) as T;

const USAGE = `Usage: tsx [options] <file> [arguments...]

Run TypeScript and modern JavaScript files directly.

Options:
  -e, --eval <code>    evaluate TypeScript code
  -p, --print <code>   evaluate TypeScript code and print the result
  --tsconfig <path>    use a specific tsconfig.json
  -h, --help           show this help
  -v, --version        show the version
`;

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

const loaderFor = (file: string): string => {
  if (/\.[mc]?ts$/.test(file)) return 'ts';
  if (file.endsWith('.tsx')) return 'tsx';
  if (file.endsWith('.jsx')) return 'jsx';
  if (file.endsWith('.json')) return 'json';
  return 'js';
};

const stripJsonComments = (text: string): string =>
  text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, string: string | undefined) => string ?? '')
    .replace(/,(\s*[}\]])/g, '$1');

const formatMessages = (messages: EsbuildMessage[], kind: 'error' | 'warning'): string =>
  messages.map((message) => {
    const where = message.location ? `${message.location.file}:${message.location.line}:${message.location.column}: ` : '';
    const source = message.location?.lineText ? `\n    ${message.location.lineText}` : '';
    return `${where}${kind}: ${message.text}${source}\n`;
  }).join('');

const isFile = (fs: FsModule, path: string): boolean => {
  try {
    return fs.existsSync(path) && fs.statSync(path).isFile();
  } catch {
    return false;
  }
};

const resolveSource = (fs: FsModule, path: PathModule, base: string): string | undefined => {
  if (isFile(fs, base)) return base;
  if (/\.[mc]?jsx?$/.test(base)) {
    const stem = base.replace(/\.([mc]?)jsx?$/, '');
    const ts = base.endsWith('x') ? ['.tsx'] : base.endsWith('.mjs') ? ['.mts'] : base.endsWith('.cjs') ? ['.cts'] : ['.ts', '.tsx'];
    for (const ext of ts) if (isFile(fs, stem + ext)) return stem + ext;
  }
  for (const ext of SOURCE_EXTENSIONS) if (isFile(fs, base + ext)) return base + ext;
  for (const ext of SOURCE_EXTENSIONS) if (isFile(fs, path.join(base, 'index' + ext))) return path.join(base, 'index' + ext);
  return undefined;
};

const findTsconfig = (fs: FsModule, path: PathModule, start: string, explicit?: string): string | undefined => {
  if (explicit) return fs.readFileSync(explicit, 'utf8');
  let dir = start;
  for (let i = 0; i < 64; i++) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (isFile(fs, candidate)) return fs.readFileSync(candidate, 'utf8');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
};

const tsconfigRaw = (text: string | undefined): Record<string, unknown> | undefined => {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(stripJsonComments(text)) as { compilerOptions?: Record<string, unknown> };
    return parsed.compilerOptions ? { compilerOptions: parsed.compilerOptions } : {};
  } catch {
    return undefined;
  }
};

const runCommonJs = (code: string, filename: string, path: PathModule): void => {
  const moduleApi = load<{ createRequire(file: string): Require }>('module');
  const require = moduleApi.createRequire(filename);
  const module = { exports: {} as unknown };
  const wrapper = (0, eval)(`(function (exports, require, module, __filename, __dirname) {${code}\n})`) as
    (exports: unknown, require: Require, module: { exports: unknown }, filename: string, dirname: string) => void;
  wrapper(module.exports, require, module, filename, path.dirname(filename));
};

const bundle = async (esbuild: Esbuild, fs: FsModule, path: PathModule, entry: string, format: 'cjs' | 'esm', tsconfig?: Record<string, unknown>): Promise<EsbuildResult> => {
  const plugin = {
    name: 'dusk-fs',
    setup(build: PluginBuild) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return { path: args.path, namespace: 'dusk' };
        const spec = args.path;
        if (!spec.startsWith('.') && !spec.startsWith('/')) return { path: spec, external: true };
        const resolved = resolveSource(fs, path, path.resolve(args.resolveDir || path.dirname(args.importer), spec));
        if (!resolved) return { errors: [{ text: `Cannot find module '${spec}' imported from ${args.importer}` }] };
        return { path: resolved, namespace: 'dusk' };
      });
      build.onLoad({ filter: /.*/, namespace: 'dusk' }, (args) => ({
        contents: fs.readFileSync(args.path, 'utf8'),
        loader: loaderFor(args.path),
        resolveDir: path.dirname(args.path),
      }));
    },
  };
  return esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format,
    platform: 'node',
    target: 'es2022',
    sourcemap: 'inline',
    keepNames: true,
    logLevel: 'silent',
    plugins: [plugin],
    define: format === 'cjs'
      ? { 'import.meta.url': JSON.stringify('file://' + entry), 'import.meta.filename': JSON.stringify(entry), 'import.meta.dirname': JSON.stringify(path.dirname(entry)) }
      : {},
    ...(tsconfig ? { tsconfigRaw: tsconfig } : {}),
  });
};

const evaluate = async (esbuild: Esbuild, proc: Proc, path: PathModule, code: string, print: boolean): Promise<void> => {
  const source = print ? `module.exports = (${code}\n);` : code;
  const result = await esbuild.transform(source, { loader: 'ts', format: 'cjs', target: 'es2022', logLevel: 'silent' });
  const filename = path.join(proc.cwd(), '[eval].ts');
  const moduleApi = load<{ createRequire(file: string): Require }>('module');
  const module = { exports: {} as unknown };
  const wrapper = (0, eval)(`(function (exports, require, module, __filename, __dirname) {${result.code ?? ''}\n})`) as
    (exports: unknown, require: Require, module: { exports: unknown }, filename: string, dirname: string) => void;
  wrapper(module.exports, moduleApi.createRequire(filename), module, filename, proc.cwd());
  if (print) {
    const util = load<{ inspect(value: unknown): string }>('util');
    const value = await Promise.resolve(module.exports);
    proc.stdout.write((typeof value === 'string' ? value : util.inspect(value)) + '\n');
  }
};

const runFile = async (esbuild: Esbuild, proc: Proc, fs: FsModule, path: PathModule, file: string, rest: string[], tsconfigPath?: string): Promise<void> => {
  const resolved = resolveSource(fs, path, path.resolve(proc.cwd(), file));
  if (!resolved) throw Object.assign(new Error(`Cannot find module '${file}'`), { code: 'ERR_MODULE_NOT_FOUND' });
  const tsconfig = tsconfigRaw(findTsconfig(fs, path, path.dirname(resolved), tsconfigPath && path.resolve(proc.cwd(), tsconfigPath)));
  proc.argv = ['/bin/node', resolved, ...rest];
  let result = await bundle(esbuild, fs, path, resolved, 'cjs', tsconfig).catch((error: { errors?: EsbuildMessage[] }) => {
    if (error.errors) return { errors: error.errors, warnings: [] } as EsbuildResult;
    throw error;
  });
  const needsEsm = result.errors.some((error) => /top-level await/i.test(error.text));
  if (needsEsm) {
    result = await bundle(esbuild, fs, path, resolved, 'esm', tsconfig).catch((error: { errors?: EsbuildMessage[] }) => {
      if (error.errors) return { errors: error.errors, warnings: [] } as EsbuildResult;
      throw error;
    });
  }
  if (result.errors.length > 0) {
    proc.stderr.write(formatMessages(result.errors, 'error'));
    proc.exitCode = 1;
    return;
  }
  const code = result.outputFiles?.[0]?.text ?? '';
  if (!needsEsm) {
    runCommonJs(code, resolved, path);
    return;
  }
  const temp = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${Date.now().toString(36)}.tsx.mjs`);
  fs.writeFileSync(temp, code);
  try {
    const importer = (globalThis as { __import__?: (spec: string) => Promise<unknown> }).__import__;
    if (!importer) throw new Error('ES module loader unavailable');
    await importer(temp);
  } finally {
    try { fs.unlinkSync(temp); } catch { }
  }
};

export const main = async (): Promise<number> => {
  const proc = (globalThis as { process?: Proc }).process;
  if (!proc) return 1;
  const args = proc.argv.slice(1);
  let evalCode: string | undefined;
  let print = false;
  let tsconfigPath: string | undefined;
  let file: string | undefined;
  let rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-h' || arg === '--help') {
      proc.stdout.write(USAGE);
      proc.exit?.(0);
      return 0;
    }
    if (arg === '-v' || arg === '--version') {
      proc.stdout.write('tsx v4.19.0 (dusk)\n');
      proc.exit?.(0);
      return 0;
    }
    if (arg === '-e' || arg === '--eval' || arg === '-p' || arg === '--print') {
      evalCode = args[++i] ?? '';
      print = arg === '-p' || arg === '--print';
      continue;
    }
    if (arg === '--tsconfig') {
      tsconfigPath = args[++i];
      continue;
    }
    if (arg === 'watch') {
      proc.stderr.write('tsx: watch mode is not supported; run the file directly\n');
      proc.exit?.(1);
      return 1;
    }
    if (arg.startsWith('-')) continue;
    file = arg;
    rest = args.slice(i + 1);
    break;
  }
  if (evalCode === undefined && file === undefined) {
    proc.stderr.write(USAGE);
    proc.exit?.(1);
    return 1;
  }
  try {
    const esbuild = load<Esbuild>('esbuild');
    const fs = load<FsModule>('fs');
    const path = load<PathModule>('path');
    if (evalCode !== undefined) await evaluate(esbuild, proc, path, evalCode, print);
    else await runFile(esbuild, proc, fs, path, file!, rest, tsconfigPath);
    await waitForActiveHandles();
    await (globalThis as { __process?: { __duskLifecycle?: { whenIdle(): Promise<void> } } }).__process?.__duskLifecycle?.whenIdle();
    const code = proc.exitCode ?? 0;
    proc.exit?.(code);
    return code;
  } catch (error) {
    const failure = error as { errors?: EsbuildMessage[] };
    if (failure.errors) proc.stderr.write(formatMessages(failure.errors, 'error'));
    else if (error instanceof Error) proc.stderr.write(`${error.stack ?? `${error.name}: ${error.message}`}\n`);
    else proc.stderr.write(`${String(error)}\n`);
    proc.exit?.(1);
    return 1;
  }
};
