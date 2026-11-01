import type { Command, CommandContext, ExecResult } from '../../../vendor/just-bash/types';
import { decodeZip, encodeZip, type ZipEntry } from '../../../protocol/zip';
import {
  bytesResult, ensureDir, errorMessage, formatDate, joinPath, normalizeRelative, parentDir, resolvePath, textResult, walk, zlib, type WalkedEntry,
} from './command-io';

const inflateRaw = (data: Uint8Array): Uint8Array => zlib('decompress', 'deflate-raw', data);
const deflateRaw = (data: Uint8Array): Uint8Array => zlib('compress', 'deflate-raw', data);

const zipUsage = `Usage: zip [-rqjD0] [-x pattern] zipfile file ...
  -r   recurse into directories
  -q   quiet operation
  -j   junk directory names (store just file names)
  -D   do not add directory entries
  -0   store only, no compression
  -d   delete entries from zipfile
  -x   exclude the following names
`;

const wildcard = (pattern: string): RegExp =>
  new RegExp('^' + pattern.split('').map((char) => (char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('') + '$');

const runZip = async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
  let recursive = false;
  let quiet = false;
  let junk = false;
  let noDirs = false;
  let store = false;
  let remove = false;
  const excludes: RegExp[] = [];
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-x' || arg === '--exclude') {
      while (i + 1 < args.length && !args[i + 1]!.startsWith('-')) excludes.push(wildcard(args[++i]!));
      continue;
    }
    if (arg === '-h' || arg === '--help') return textResult(zipUsage);
    if (arg.startsWith('-') && arg.length > 1 && operands.length < 2) {
      for (const flag of arg.slice(1)) {
        if (flag === 'r') recursive = true;
        else if (flag === 'q') quiet = true;
        else if (flag === 'j') junk = true;
        else if (flag === 'D') noDirs = true;
        else if (flag === '0') store = true;
        else if (flag === 'd') remove = true;
        else if (/[1-9v]/.test(flag)) continue;
        else return textResult('', `zip error: Invalid command arguments (short option '${flag}' not supported)\n`, 16);
      }
      continue;
    }
    operands.push(arg);
  }
  const archiveName = operands.shift();
  if (!archiveName) return textResult('', zipUsage, 16);
  const archivePath = resolvePath(ctx, /\.[^/]+$/.test(archiveName) ? archiveName : `${archiveName}.zip`);
  const existing = new Map<string, ZipEntry>();
  if (await ctx.fs.exists(archivePath)) {
    try {
      for (const entry of decodeZip(await ctx.fs.readFileBuffer(archivePath), inflateRaw)) existing.set(entry.path, entry);
    } catch (error) {
      return textResult('', `zip error: ${errorMessage(error)}\n`, 3);
    }
  }
  let out = '';
  if (remove) {
    for (const operand of operands) {
      const pattern = wildcard(operand);
      for (const name of [...existing.keys()]) {
        if (pattern.test(name)) {
          existing.delete(name);
          if (!quiet) out += `deleting: ${name}\n`;
        }
      }
    }
  } else {
    if (operands.length === 0) return textResult('', 'zip error: Nothing to do!\n', 12);
    for (const operand of operands) {
      const walked: WalkedEntry[] = [];
      try {
        await walk(ctx, resolvePath(ctx, operand), operand.replace(/^\/+/, '').replace(/\/+$/, ''), recursive, walked);
      } catch {
        out += `\tzip warning: name not matched: ${operand}\n`;
        continue;
      }
      for (const item of walked) {
        if (excludes.some((pattern) => pattern.test(item.path))) continue;
        if (item.directory && (noDirs || junk)) continue;
        const name = junk ? item.path.slice(item.path.lastIndexOf('/') + 1) : item.path;
        const data = item.directory ? undefined : await ctx.fs.readFileBuffer(item.absolute);
        const verb = existing.has(name) ? 'updating' : 'adding';
        existing.set(name, { path: name, directory: item.directory, ...(data ? { data } : {}), mtimeMs: item.mtimeMs });
        if (quiet) continue;
        if (item.directory || !data || data.length === 0) {
          out += `  ${verb}: ${name}${item.directory ? '/' : ''} (stored 0%)\n`;
        } else {
          const packed = store ? data.length : deflateRaw(data).length;
          const saved = packed < data.length ? Math.round((1 - packed / data.length) * 100) : 0;
          out += `  ${verb}: ${name} (${saved > 0 ? `deflated ${saved}%` : 'stored 0%'})\n`;
        }
      }
    }
  }
  try {
    await ctx.fs.writeFile(archivePath, encodeZip(existing.values(), store ? undefined : deflateRaw));
  } catch (error) {
    return textResult(out, `zip error: ${errorMessage(error)}\n`, 15);
  }
  return textResult(out);
};

const unzipUsage = `Usage: unzip [-lopqn] [-d exdir] file[.zip] [list] [-x xlist]
  -l   list files (short format)
  -p   extract files to pipe, no messages
  -o   overwrite files without prompting
  -n   never overwrite existing files
  -q   quiet mode
  -d   extract files into exdir
`;

const runUnzip = async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
  let list = false;
  let pipe = false;
  let never = false;
  let quiet = false;
  let destination: string | undefined;
  const operands: string[] = [];
  const excludes: RegExp[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-d') { destination = args[++i]; continue; }
    if (arg === '-x') {
      while (i + 1 < args.length) excludes.push(wildcard(args[++i]!));
      continue;
    }
    if (arg === '-h' || arg === '--help') return textResult(unzipUsage);
    if (arg.startsWith('-') && arg.length > 1) {
      for (const flag of arg.slice(1)) {
        if (flag === 'l' || flag === 'v') list = true;
        else if (flag === 'p') pipe = true;
        else if (flag === 'o') never = false;
        else if (flag === 'n') never = true;
        else if (flag === 'q') quiet = true;
        else return textResult('', `unzip:  error:  unknown option '${flag}'\n`, 10);
      }
      continue;
    }
    operands.push(arg);
  }
  const archiveName = operands.shift();
  if (!archiveName) return textResult(unzipUsage);
  let archivePath = resolvePath(ctx, archiveName);
  if (!await ctx.fs.exists(archivePath) && await ctx.fs.exists(archivePath + '.zip')) archivePath += '.zip';
  let entries: ZipEntry[];
  try {
    entries = decodeZip(await ctx.fs.readFileBuffer(archivePath), inflateRaw);
  } catch (error) {
    return textResult('', `unzip:  cannot read ${archiveName}: ${errorMessage(error)}\n`, 9);
  }
  const patterns = operands.map(wildcard);
  const chosen = entries.filter((entry) =>
    (patterns.length === 0 || patterns.some((pattern) => pattern.test(entry.path)))
    && !excludes.some((pattern) => pattern.test(entry.path)));

  if (list) {
    let out = `Archive:  ${archiveName}\n  Length      Date    Time    Name\n---------  ---------- -----   ----\n`;
    let total = 0;
    for (const entry of chosen) {
      const size = entry.data?.length ?? 0;
      total += size;
      out += `${String(size).padStart(9)}  ${formatDate(entry.mtimeMs ?? 0)}   ${entry.path}${entry.directory ? '/' : ''}\n`;
    }
    out += `---------                     -------\n${String(total).padStart(9)}                     ${chosen.length} file${chosen.length === 1 ? '' : 's'}\n`;
    return textResult(out);
  }

  if (pipe) {
    const parts = chosen.filter((entry) => !entry.directory).map((entry) => entry.data ?? new Uint8Array(0));
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return bytesResult(out);
  }

  const base = destination ? resolvePath(ctx, destination) : ctx.cwd;
  let out = quiet ? '' : `Archive:  ${archiveName}\n`;
  let stderr = '';
  let exitCode = 0;
  for (const entry of chosen) {
    const relative = normalizeRelative(entry.path);
    if (!relative) {
      stderr += `warning:  skipped "../" path component(s) in ${entry.path}\n`;
      exitCode = 1;
      continue;
    }
    const target = joinPath(base, relative);
    try {
      if (entry.directory) {
        await ensureDir(ctx, target);
        if (!quiet) out += `   creating: ${relative}/\n`;
        continue;
      }
      if (never && await ctx.fs.exists(target)) continue;
      await ensureDir(ctx, parentDir(target));
      await ctx.fs.writeFile(target, entry.data ?? new Uint8Array(0));
      if (!quiet) out += `  inflating: ${relative}\n`;
    } catch (error) {
      stderr += `error:  cannot create ${relative}: ${errorMessage(error)}\n`;
      exitCode = 50;
    }
  }
  return textResult(out, stderr, exitCode);
};

export const zipCommand: Command = { name: 'zip', execute: runZip };
export const unzipCommand: Command = { name: 'unzip', execute: runUnzip };
