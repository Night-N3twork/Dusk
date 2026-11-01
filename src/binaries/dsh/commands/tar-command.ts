import type { Command, CommandContext, ExecResult } from '../../../vendor/just-bash/types';
import { decodeTar, encodeTar, isGzip, type TarEntry } from '../../../protocol/tar';
import {
  bytesResult, describeMode, ensureDir, errorMessage, formatDate, joinPath, normalizeRelative, parentDir,
  resolvePath, stdinBytes, textResult, walk, zlib, type WalkedEntry,
} from './command-io';

type Mode = 'create' | 'extract' | 'list';

interface TarOptions {
  mode?: Mode;
  file?: string;
  gzip: boolean;
  autoCompress: boolean;
  verbose: boolean;
  directory?: string;
  toStdout: boolean;
  strip: number;
  excludes: RegExp[];
  keepOld: boolean;
  operands: string[];
}

const USAGE = `Usage: tar [OPTION...] [FILE]...
  -c, --create               create a new archive
  -x, --extract, --get       extract files from an archive
  -t, --list                 list the contents of an archive
  -f, --file=ARCHIVE         use archive file ARCHIVE ("-" for stdin/stdout)
  -z, --gzip                 filter the archive through gzip
  -a, --auto-compress        pick compression from the archive suffix
  -C, --directory=DIR        change to directory DIR
  -O, --to-stdout            extract files to standard output
  -k, --keep-old-files       don't replace existing files when extracting
  -v, --verbose              verbosely list files processed
      --strip-components=N   strip N leading path components on extraction
      --exclude=PATTERN      exclude files matching PATTERN
`;

const globToRegExp = (pattern: string): RegExp => {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`(^|/)${source}(/|$)`);
};

const parseArgs = (args: string[]): TarOptions | string => {
  const options: TarOptions = { gzip: false, autoCompress: false, verbose: false, toStdout: false, strip: 0, excludes: [], keepOld: false, operands: [] };
  const queue = [...args];
  if (queue[0] && !queue[0].startsWith('-') && /^[A-Za-z]+$/.test(queue[0])) queue[0] = '-' + queue[0];
  const setMode = (mode: Mode): string | undefined => {
    if (options.mode && options.mode !== mode) return 'tar: You may not specify more than one of -c, -x or -t';
    options.mode = mode;
    return undefined;
  };
  while (queue.length > 0) {
    const arg = queue.shift()!;
    if (arg === '--') {
      options.operands.push(...queue.splice(0));
      break;
    }
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      const value = (): string => inline ?? queue.shift() ?? '';
      let problem: string | undefined;
      switch (name) {
        case 'create': problem = setMode('create'); break;
        case 'extract': case 'get': problem = setMode('extract'); break;
        case 'list': problem = setMode('list'); break;
        case 'file': options.file = value(); break;
        case 'gzip': case 'gunzip': case 'ungzip': options.gzip = true; break;
        case 'auto-compress': options.autoCompress = true; break;
        case 'directory': options.directory = value(); break;
        case 'to-stdout': options.toStdout = true; break;
        case 'keep-old-files': options.keepOld = true; break;
        case 'verbose': options.verbose = true; break;
        case 'strip-components': options.strip = Number(value()) || 0; break;
        case 'exclude': options.excludes.push(globToRegExp(value())); break;
        case 'help': return USAGE;
        default: return `tar: unrecognized option '--${name}'`;
      }
      if (problem) return problem;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let i = 1; i < arg.length; i++) {
        const flag = arg[i]!;
        const takeValue = (): string => {
          const rest = arg.slice(i + 1);
          i = arg.length;
          return rest || queue.shift() || '';
        };
        let problem: string | undefined;
        switch (flag) {
          case 'c': problem = setMode('create'); break;
          case 'x': problem = setMode('extract'); break;
          case 't': problem = setMode('list'); break;
          case 'f': options.file = takeValue(); break;
          case 'C': options.directory = takeValue(); break;
          case 'z': options.gzip = true; break;
          case 'a': options.autoCompress = true; break;
          case 'v': options.verbose = true; break;
          case 'O': options.toStdout = true; break;
          case 'k': options.keepOld = true; break;
          case 'p': case 'o': case 'm': break;
          default: return `tar: invalid option -- '${flag}'`;
        }
        if (problem) return problem;
      }
      continue;
    }
    options.operands.push(arg);
  }
  if (!options.mode) return "tar: You must specify one of the '-c', '-x' or '-t' options";
  return options;
};

const wantsGzip = (options: TarOptions): boolean =>
  options.gzip || (options.autoCompress && !!options.file && /\.(t?gz|tgz)$/i.test(options.file));

const createArchive = async (ctx: CommandContext, options: TarOptions): Promise<ExecResult> => {
  if (options.operands.length === 0) return textResult('', 'tar: Cowardly refusing to create an empty archive\n', 2);
  const base = options.directory ? resolvePath(ctx, options.directory) : ctx.cwd;
  const entries: TarEntry[] = [];
  let stderr = '';
  let listing = '';
  let warnedAbsolute = false;
  for (const operand of options.operands) {
    let name = operand.replace(/\/+$/, '') || operand;
    if (name.startsWith('/')) {
      if (!warnedAbsolute) stderr += "tar: Removing leading `/' from member names\n";
      warnedAbsolute = true;
      name = name.replace(/^\/+/, '');
    }
    const walked: WalkedEntry[] = [];
    try {
      await walk(ctx, ctx.fs.resolvePath(base, operand), name, true, walked);
    } catch (error) {
      stderr += `tar: ${operand}: Cannot stat: ${errorMessage(error)}\n`;
      continue;
    }
    for (const item of walked) {
      if (options.excludes.some((pattern) => pattern.test(item.path))) continue;
      if (item.directory) entries.push({ path: item.path, type: 'directory', mode: item.mode & 0o7777, mtimeMs: item.mtimeMs });
      else entries.push({ path: item.path, type: 'file', data: await ctx.fs.readFileBuffer(item.absolute), mode: item.mode & 0o7777, mtimeMs: item.mtimeMs });
      if (options.verbose) listing += item.directory ? `${item.path}/\n` : `${item.path}\n`;
    }
  }
  let archive = encodeTar(entries);
  if (wantsGzip(options)) archive = zlib('compress', 'gzip', archive);
  const exitCode = stderr.includes('Cannot stat') ? 2 : 0;
  if (!options.file || options.file === '-') return bytesResult(archive, listing + stderr, exitCode);
  const target = resolvePath(ctx, options.file);
  await ctx.fs.writeFile(target, archive);
  return textResult(listing, stderr, exitCode);
};

const readArchive = async (ctx: CommandContext, options: TarOptions): Promise<TarEntry[]> => {
  const raw = !options.file || options.file === '-' ? stdinBytes(ctx) : await ctx.fs.readFileBuffer(resolvePath(ctx, options.file));
  return decodeTar(isGzip(raw) ? zlib('decompress', 'gzip', raw) : raw);
};

const selected = (entry: TarEntry, options: TarOptions): boolean => {
  if (options.excludes.some((pattern) => pattern.test(entry.path))) return false;
  if (options.operands.length === 0) return true;
  return options.operands.some((operand) => {
    const name = operand.replace(/\/+$/, '');
    return entry.path === name || entry.path.startsWith(name + '/');
  });
};

const listArchive = async (ctx: CommandContext, options: TarOptions): Promise<ExecResult> => {
  const entries = (await readArchive(ctx, options)).filter((entry) => selected(entry, options));
  let out = '';
  for (const entry of entries) {
    const name = entry.type === 'directory' ? `${entry.path}/` : entry.path;
    if (!options.verbose) {
      out += name + '\n';
      continue;
    }
    const size = String(entry.data?.length ?? 0).padStart(8);
    const link = entry.type === 'symlink' ? ` -> ${entry.linkTarget}` : entry.type === 'hardlink' ? ` link to ${entry.linkTarget}` : '';
    out += `${describeMode(entry.type === 'directory', entry.mode ?? 0o644)} 0/0 ${size} ${formatDate(entry.mtimeMs ?? 0)} ${name}${link}\n`;
  }
  return textResult(out);
};

const extractArchive = async (ctx: CommandContext, options: TarOptions): Promise<ExecResult> => {
  const entries = await readArchive(ctx, options);
  const base = options.directory ? resolvePath(ctx, options.directory) : ctx.cwd;
  const extracted = new Map<string, Uint8Array>();
  const chunks: Uint8Array[] = [];
  let listing = '';
  let stderr = '';
  let failed = false;
  for (const entry of entries) {
    if (!selected(entry, options)) continue;
    const stripped = entry.path.split('/').filter(Boolean).slice(options.strip).join('/');
    if (!stripped) continue;
    const relative = normalizeRelative(stripped);
    if (relative === undefined || relative === '') {
      stderr += `tar: ${entry.path}: Member name contains '..'\n`;
      failed = true;
      continue;
    }
    const target = joinPath(base, relative);
    if (options.verbose) listing += entry.type === 'directory' ? `${entry.path}/\n` : `${entry.path}\n`;
    try {
      if (entry.type === 'directory') {
        if (!options.toStdout) await ensureDir(ctx, target);
        continue;
      }
      const data = entry.type === 'file'
        ? entry.data ?? new Uint8Array(0)
        : entry.type === 'hardlink'
          ? extracted.get(entry.linkTarget ?? '')
          : undefined;
      if (options.toStdout) {
        if (data) chunks.push(data);
        continue;
      }
      if (options.keepOld && await ctx.fs.exists(target)) {
        stderr += `tar: ${relative}: Cannot open: File exists\n`;
        failed = true;
        continue;
      }
      await ensureDir(ctx, parentDir(target));
      if (entry.type === 'symlink') {
        await ctx.fs.symlink(entry.linkTarget ?? '', target);
        continue;
      }
      if (!data) {
        stderr += `tar: ${relative}: Cannot hard link to '${entry.linkTarget}'\n`;
        failed = true;
        continue;
      }
      await ctx.fs.writeFile(target, data);
      extracted.set(entry.path, data);
      if (entry.mode !== undefined) await ctx.fs.chmod(target, entry.mode & 0o7777).catch(() => undefined);
    } catch (error) {
      stderr += `tar: ${relative}: ${errorMessage(error)}\n`;
      failed = true;
    }
  }
  const exitCode = failed ? 2 : 0;
  if (options.toStdout) {
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
    return bytesResult(out, listing + stderr, exitCode);
  }
  return textResult(listing, stderr, exitCode);
};

export const tarCommand: Command = {
  name: 'tar',
  async execute(args, ctx) {
    const options = parseArgs(args);
    if (typeof options === 'string') return options === USAGE ? textResult(USAGE) : textResult('', `${options}\nTry 'tar --help' for more information.\n`, 2);
    try {
      if (options.mode === 'create') return await createArchive(ctx, options);
      if (options.mode === 'list') return await listArchive(ctx, options);
      return await extractArchive(ctx, options);
    } catch (error) {
      return textResult('', `tar: ${errorMessage(error)}\n`, 2);
    }
  },
};
