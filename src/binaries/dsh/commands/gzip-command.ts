import type { Command, CommandContext, ExecResult } from '../../../vendor/just-bash/types';
import { isGzip } from '../../../protocol/tar';
import { bytesResult, errorMessage, resolvePath, stdinBytes, textResult, zlib } from './command-io';

interface GzipOptions {
  decompress: boolean;
  toStdout: boolean;
  keep: boolean;
  force: boolean;
  verbose: boolean;
  files: string[];
}

const parse = (name: string, args: string[]): GzipOptions | string => {
  const options: GzipOptions = {
    decompress: name !== 'gzip',
    toStdout: name === 'zcat',
    keep: false,
    force: false,
    verbose: false,
    files: [],
  };
  let operandsOnly = false;
  for (const arg of args) {
    if (operandsOnly || arg === '-' || !arg.startsWith('-')) {
      options.files.push(arg);
      continue;
    }
    if (arg === '--') { operandsOnly = true; continue; }
    if (arg.startsWith('--')) {
      switch (arg) {
        case '--decompress': case '--uncompress': options.decompress = true; break;
        case '--stdout': case '--to-stdout': options.toStdout = true; break;
        case '--keep': options.keep = true; break;
        case '--force': options.force = true; break;
        case '--verbose': options.verbose = true; break;
        case '--quiet': break;
        case '--best': case '--fast': break;
        case '--help': return `Usage: ${name} [OPTION]... [FILE]...\n  -c  write to standard output\n  -d  decompress\n  -f  force overwrite\n  -k  keep input files\n  -v  verbose\n`;
        default: return `${name}: unrecognized option '${arg}'`;
      }
      continue;
    }
    for (const flag of arg.slice(1)) {
      if (flag === 'd') options.decompress = true;
      else if (flag === 'c') options.toStdout = true;
      else if (flag === 'k') options.keep = true;
      else if (flag === 'f') options.force = true;
      else if (flag === 'v') options.verbose = true;
      else if (flag === 'q' || flag === 'n' || flag === 'N' || /\d/.test(flag)) continue;
      else return `${name}: invalid option -- '${flag}'`;
    }
  }
  return options;
};

const transform = (options: GzipOptions, data: Uint8Array): Uint8Array => {
  if (!options.decompress) return zlib('compress', 'gzip', data);
  if (!isGzip(data)) {
    if (options.force && options.toStdout) return data;
    throw new Error('not in gzip format');
  }
  return zlib('decompress', 'gzip', data);
};

const run = async (name: string, args: string[], ctx: CommandContext): Promise<ExecResult> => {
  const options = parse(name, args);
  if (typeof options === 'string') return options.startsWith('Usage') ? textResult(options) : textResult('', options + '\n', 1);
  if (options.files.length === 0) options.files.push('-');
  const out: Uint8Array[] = [];
  let stderr = '';
  let exitCode = 0;
  for (const file of options.files) {
    try {
      if (file === '-') {
        out.push(transform(options, stdinBytes(ctx)));
        continue;
      }
      const source = resolvePath(ctx, file);
      if (options.decompress && !options.toStdout && !/\.(gz|tgz|z)$/i.test(file)) {
        stderr += `${name}: ${file}: unknown suffix -- ignored\n`;
        exitCode = Math.max(exitCode, 2);
        continue;
      }
      const data = transform(options, await ctx.fs.readFileBuffer(source));
      if (options.toStdout) {
        out.push(data);
        continue;
      }
      const target = options.decompress ? source.replace(/\.tgz$/i, '.tar').replace(/\.(gz|z)$/i, '') : source + '.gz';
      if (!options.force && await ctx.fs.exists(target)) {
        stderr += `${name}: ${target} already exists; not overwritten\n`;
        exitCode = Math.max(exitCode, 2);
        continue;
      }
      await ctx.fs.writeFile(target, data);
      if (!options.keep) await ctx.fs.rm(source, { force: true });
      if (options.verbose) stderr += `${file}:\t${options.decompress ? 'decompressed' : 'compressed'} -> ${target}\n`;
    } catch (error) {
      stderr += `${name}: ${file}: ${errorMessage(error)}\n`;
      exitCode = 1;
    }
  }
  let total = 0;
  for (const chunk of out) total += chunk.length;
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of out) { joined.set(chunk, at); at += chunk.length; }
  return bytesResult(joined, stderr, exitCode);
};

export const gzipCommand: Command = { name: 'gzip', execute: (args, ctx) => run('gzip', args, ctx) };
export const gunzipCommand: Command = { name: 'gunzip', execute: (args, ctx) => run('gunzip', args, ctx) };
export const zcatCommand: Command = { name: 'zcat', execute: (args, ctx) => run('zcat', args, ctx) };
