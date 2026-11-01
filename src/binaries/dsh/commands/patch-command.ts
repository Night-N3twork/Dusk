import type { Command, CommandContext, ExecResult } from '../../../vendor/just-bash/types';
import { decodeBytesToUtf8 } from '../../../vendor/just-bash/encoding';
import { applyHunks, parsePatch, reverseHunk, stripPath, type FilePatch } from '../../../protocol/unified-diff';
import { ensureDir, errorMessage, parentDir, textResult } from './command-io';

interface PatchOptions {
  strip?: number;
  reverse: boolean;
  dryRun: boolean;
  input?: string;
  directory?: string;
  output?: string;
  silent: boolean;
  forward: boolean;
  backup: boolean;
  target?: string;
}

const USAGE = `Usage: patch [OPTION]... [ORIGFILE [PATCHFILE]]
  -p NUM, --strip=NUM   strip NUM leading components from file names
  -R, --reverse         assume patches were created with old and new files swapped
  -i FILE, --input=FILE read patch from FILE instead of stdin
  -d DIR, --directory=DIR  change the working directory to DIR first
  -o FILE, --output=FILE   output patched files to FILE
  -N, --forward         ignore patches that seem to be reversed or already applied
  -b, --backup          back up the original contents of each file
  -s, --silent          work silently unless an error occurs
      --dry-run         print the results without changing any files
`;

const parse = (args: string[]): PatchOptions | string => {
  const options: PatchOptions = { reverse: false, dryRun: false, silent: false, forward: false, backup: false };
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const long = /^--([a-z-]+)(?:=(.*))?$/s.exec(arg);
    if (long) {
      const value = (): string => long[2] ?? args[++i] ?? '';
      switch (long[1]) {
        case 'strip': options.strip = Number(value()); break;
        case 'reverse': options.reverse = true; break;
        case 'dry-run': options.dryRun = true; break;
        case 'input': options.input = value(); break;
        case 'directory': options.directory = value(); break;
        case 'output': options.output = value(); break;
        case 'silent': case 'quiet': options.silent = true; break;
        case 'forward': options.forward = true; break;
        case 'backup': options.backup = true; break;
        case 'unified': case 'force': case 'batch': break;
        case 'help': return USAGE;
        default: return `patch: unrecognized option '${arg}'`;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j]!;
        const value = (): string => {
          const rest = arg.slice(j + 1);
          j = arg.length;
          return rest || args[++i] || '';
        };
        switch (flag) {
          case 'p': options.strip = Number(value()); break;
          case 'R': options.reverse = true; break;
          case 'i': options.input = value(); break;
          case 'd': options.directory = value(); break;
          case 'o': options.output = value(); break;
          case 's': options.silent = true; break;
          case 'N': options.forward = true; break;
          case 'b': options.backup = true; break;
          case 'u': case 'f': case 't': case 'E': break;
          default: return `patch: invalid option -- '${flag}'`;
        }
      }
      continue;
    }
    operands.push(arg);
  }
  if (operands[0]) options.target = operands[0];
  if (operands[1] && !options.input) options.input = operands[1];
  if (options.strip !== undefined && (!Number.isInteger(options.strip) || options.strip < 0)) return `patch: strip count ${options.strip} is not a number`;
  return options;
};

const chooseTarget = (file: FilePatch, options: PatchOptions): { path: string; creating: boolean; deleting: boolean } => {
  const oldPath = options.reverse ? file.newPath : file.oldPath;
  const newPath = options.reverse ? file.oldPath : file.newPath;
  const creating = oldPath === '/dev/null';
  const deleting = newPath === '/dev/null';
  const source = options.target ?? stripPath(creating ? newPath : deleting ? oldPath : newPath, options.strip);
  return { path: source, creating, deleting };
};

const run = async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
  const options = parse(args);
  if (typeof options === 'string') return options === USAGE ? textResult(USAGE) : textResult('', `${options}\n`, 2);
  const cwd = options.directory ? ctx.fs.resolvePath(ctx.cwd, options.directory) : ctx.cwd;
  let patchText: string;
  try {
    patchText = options.input && options.input !== '-'
      ? await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, options.input))
      : decodeBytesToUtf8(ctx.stdin);
  } catch (error) {
    return textResult('', `patch: can't open patch file ${options.input}: ${errorMessage(error)}\n`, 2);
  }
  const files = parsePatch(patchText);
  if (files.length === 0) return textResult('', 'patch: **** Only garbage was found in the patch input.\n', 2);

  let out = '';
  let stderr = '';
  let failed = false;
  for (const file of files) {
    const { path, creating, deleting } = chooseTarget(file, options);
    const absolute = ctx.fs.resolvePath(cwd, path);
    const hunks = options.reverse ? file.hunks.map(reverseHunk) : file.hunks;
    let original = '';
    const exists = await ctx.fs.exists(absolute);
    if (exists) original = await ctx.fs.readFile(absolute);
    else if (!creating) {
      stderr += `patch: can't find file to patch: ${path}\n`;
      failed = true;
      continue;
    }
    if (!options.silent) out += `${options.dryRun ? 'checking' : 'patching'} file ${path}\n`;
    let result = applyHunks(original, hunks);
    if (result.hunks.some((hunk) => !hunk.applied)) {
      const reversed = applyHunks(original, hunks.map(reverseHunk));
      if (reversed.hunks.every((hunk) => hunk.applied)) {
        if (options.forward) {
          out += 'Reversed (or previously applied) patch detected!  Skipping patch.\n';
          failed = true;
          continue;
        }
        if (!options.silent) out += 'Reversed (or previously applied) patch detected!  Assuming -R.\n';
        result = reversed;
      }
    }
    for (const hunk of result.hunks) {
      if (!hunk.applied) {
        stderr += `Hunk #${hunk.index} FAILED.\n`;
        failed = true;
      } else if (hunk.offset !== 0 && !options.silent) {
        const lines = Math.abs(hunk.offset);
        out += `Hunk #${hunk.index} succeeded with offset ${hunk.offset > 0 ? lines : -lines} line${lines === 1 ? '' : 's'}.\n`;
      }
    }
    if (result.hunks.some((hunk) => !hunk.applied)) {
      const rejected = result.hunks.filter((hunk) => !hunk.applied).length;
      stderr += `${rejected} out of ${result.hunks.length} hunk${result.hunks.length === 1 ? '' : 's'} FAILED -- saving rejects to file ${path}.rej\n`;
      if (!options.dryRun) {
        const rej = hunks.filter((_, i) => !result.hunks[i]!.applied)
          .map((hunk) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}\n`)
          .join('');
        await ctx.fs.writeFile(`${absolute}.rej`, `--- ${file.oldPath}\n+++ ${file.newPath}\n${rej}`);
      }
      continue;
    }
    if (options.dryRun) continue;
    try {
      if (options.backup && exists) await ctx.fs.writeFile(`${absolute}.orig`, original);
      const output = options.output ? ctx.fs.resolvePath(ctx.cwd, options.output) : absolute;
      if (deleting && !options.output && result.text === '') {
        await ctx.fs.rm(absolute, { force: true });
        continue;
      }
      await ensureDir(ctx, parentDir(output));
      await ctx.fs.writeFile(output, result.text);
    } catch (error) {
      stderr += `patch: ${path}: ${errorMessage(error)}\n`;
      failed = true;
    }
  }
  return textResult(out, stderr, failed ? 1 : 0);
};

export const patchCommand: Command = { name: 'patch', execute: run };
