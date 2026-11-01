import * as git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import { createUnifiedHunks } from '../../protocol/unified-diff';

interface Proc {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: () => string;
  exit?: (code: number) => void;
  stdout: { write: (data: string | Uint8Array) => void };
  stderr: { write: (data: string | Uint8Array) => void };
}

interface PathModule {
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
  join(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string, ext?: string): string;
}

type Fs = git.PromiseFsClient & {
  promises: { writeFile(path: string, data: Uint8Array): Promise<void>; readdir(path: string): Promise<string[]> };
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  mkdirSync(path: string, options: { recursive: boolean }): void;
  statSync(path: string): { isDirectory(): boolean };
  rmSync(path: string, options: { recursive?: boolean; force?: boolean }): void;
};

class GitError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

const load = <T>(id: string): T => ((globalThis as unknown as { require: (id: string) => unknown }).require)(id) as T;

interface Context {
  proc: Proc;
  fs: Fs;
  path: PathModule;
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

interface Repo {
  dir: string;
  gitdir: string;
}

const shortOid = (oid: string): string => oid.slice(0, 7);

const formatDate = (seconds: number, offsetMinutes: number): string => {
  const shifted = new Date((seconds - offsetMinutes * 60) * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number): string => String(n).padStart(2, '0');
  const sign = offsetMinutes <= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${days[shifted.getUTCDay()]} ${months[shifted.getUTCMonth()]} ${shifted.getUTCDate()} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())} ${shifted.getUTCFullYear()} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
};

const indent = (text: string): string => text.replace(/\n$/, '').split('\n').map((line) => (line ? `    ${line}` : '')).join('\n');

const parseIni = (text: string): Map<string, string> => {
  const values = new Map<string, string>();
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]\s"]+)(?:\s+"([^"]*)")?\]$/.exec(line);
    if (header) {
      section = header[2] !== undefined ? `${header[1]!.toLowerCase()}.${header[2]}` : header[1]!.toLowerCase();
      continue;
    }
    const pair = /^([^=\s]+)\s*(?:=\s*(.*))?$/.exec(line);
    if (pair) values.set(`${section}.${pair[1]!.toLowerCase()}`, (pair[2] ?? 'true').replace(/^"(.*)"$/, '$1'));
  }
  return values;
};

const serializeIni = (values: Map<string, string>): string => {
  const sections = new Map<string, string[]>();
  for (const [key, value] of values) {
    const dot = key.lastIndexOf('.');
    const section = key.slice(0, dot);
    const name = key.slice(dot + 1);
    const lines = sections.get(section) ?? [];
    lines.push(`\t${name} = ${value}`);
    sections.set(section, lines);
  }
  let out = '';
  for (const [section, lines] of sections) {
    const dot = section.indexOf('.');
    out += dot === -1 ? `[${section}]\n` : `[${section.slice(0, dot)} "${section.slice(dot + 1)}"]\n`;
    out += lines.join('\n') + '\n';
  }
  return out;
};

const globalConfigPath = (ctx: Context): string => ctx.path.join(ctx.proc.env['HOME'] || '/', '.gitconfig');

const readGlobalConfig = (ctx: Context): Map<string, string> => {
  const file = globalConfigPath(ctx);
  try {
    return ctx.fs.existsSync(file) ? parseIni(ctx.fs.readFileSync(file, 'utf8')) : new Map();
  } catch {
    return new Map();
  }
};

const findRepo = async (ctx: Context): Promise<Repo> => {
  try {
    const dir = await git.findRoot({ fs: ctx.fs, filepath: ctx.cwd });
    return { dir, gitdir: ctx.path.join(dir, '.git') };
  } catch {
    throw new GitError('fatal: not a git repository (or any of the parent directories): .git', 128);
  }
};

const configValue = async (ctx: Context, repo: Repo | undefined, key: string): Promise<string | undefined> => {
  if (repo) {
    const local = await git.getConfig({ fs: ctx.fs, dir: repo.dir, path: key }).catch(() => undefined);
    if (local !== undefined && local !== null) return String(local);
  }
  return readGlobalConfig(ctx).get(key.toLowerCase());
};

const identity = async (ctx: Context, repo: Repo): Promise<{ name: string; email: string }> => {
  const name = ctx.proc.env['GIT_AUTHOR_NAME'] ?? await configValue(ctx, repo, 'user.name');
  const email = ctx.proc.env['GIT_AUTHOR_EMAIL'] ?? await configValue(ctx, repo, 'user.email');
  if (!name || !email) {
    throw new GitError([
      'Author identity unknown',
      '',
      '*** Please tell me who you are.',
      '',
      'Run',
      '',
      '  git config --global user.email "you@example.com"',
      '  git config --global user.name "Your Name"',
      '',
      "to set your account's default identity.",
    ].join('\n'), 128);
  }
  return { name, email };
};

interface RemoteOptions {
  http: git.HttpClient;
  corsProxy?: string;
  onAuth: git.AuthCallback;
  onMessage: git.MessageCallback;
}

const remoteOptions = (ctx: Context): RemoteOptions => {
  const env = ctx.proc.env;
  const token = env['GIT_TOKEN'] ?? env['GITHUB_TOKEN'] ?? env['GH_TOKEN'];
  return {
    http,
    ...(env['GIT_CORS_PROXY'] ? { corsProxy: env['GIT_CORS_PROXY'] } : {}),
    onAuth: () => {
      if (env['GIT_USERNAME'] || env['GIT_PASSWORD']) return { username: env['GIT_USERNAME'] ?? '', password: env['GIT_PASSWORD'] ?? '' };
      if (token) return { username: token, password: 'x-oauth-basic' };
      return { cancel: true } as git.GitAuth;
    },
    onMessage: (message: string) => ctx.err(`remote: ${message.endsWith('\n') ? message : message + '\n'}`),
  };
};

const expandShortFlags = (args: string[], valueFlags: string): string[] => {
  const out: string[] = [];
  for (const arg of args) {
    if (!/^-[A-Za-z]{2,}/.test(arg)) {
      out.push(arg);
      continue;
    }
    for (let i = 1; i < arg.length; i++) {
      const letter = arg[i]!;
      if (valueFlags.includes(letter)) {
        out.push(`-${letter}`);
        if (i + 1 < arg.length) out.push(arg.slice(i + 1));
        break;
      }
      out.push(`-${letter}`);
    }
  }
  return out;
};

const takeOption = (args: string[], names: string[], withValue: boolean): string | boolean | undefined => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    for (const name of names) {
      if (arg === name) {
        if (!withValue) {
          args.splice(i, 1);
          return true;
        }
        const value = args[i + 1];
        args.splice(i, 2);
        return value;
      }
      if (withValue && name.startsWith('--') && arg.startsWith(name + '=')) {
        args.splice(i, 1);
        return arg.slice(name.length + 1);
      }
      if (withValue && !name.startsWith('--') && arg.startsWith(name) && arg.length > name.length) {
        args.splice(i, 1);
        return arg.slice(name.length);
      }
    }
  }
  return undefined;
};

const flag = (args: string[], ...names: string[]): boolean => takeOption(args, names, false) === true;
const option = (args: string[], ...names: string[]): string | undefined => {
  const value = takeOption(args, names, true);
  return typeof value === 'string' ? value : undefined;
};

const repoPath = (ctx: Context, repo: Repo, file: string): string => {
  const relative = ctx.path.relative(repo.dir, ctx.path.resolve(ctx.cwd, file));
  return relative === '' ? '.' : relative;
};

const displayPath = (ctx: Context, repo: Repo, file: string): string => ctx.path.relative(ctx.cwd, ctx.path.join(repo.dir, file)) || '.';

const isBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, 8000).includes(0);

const decoder = new TextDecoder();

const fileDiff = (path: string, before: Uint8Array | undefined, after: Uint8Array | undefined, beforeOid?: string, afterOid?: string): string => {
  const header = [`diff --git a/${path} b/${path}`];
  if (!before) header.push('new file mode 100644');
  if (!after) header.push('deleted file mode 100644');
  header.push(`index ${(beforeOid ?? '0000000').slice(0, 7)}..${(afterOid ?? '0000000').slice(0, 7)}${before && after ? ' 100644' : ''}`);
  if ((before && isBinary(before)) || (after && isBinary(after))) {
    return header.join('\n') + `\nBinary files ${before ? `a/${path}` : '/dev/null'} and ${after ? `b/${path}` : '/dev/null'} differ\n`;
  }
  const hunks = createUnifiedHunks(before ? decoder.decode(before) : '', after ? decoder.decode(after) : '');
  if (!hunks) return '';
  return `${header.join('\n')}\n--- ${before ? `a/${path}` : '/dev/null'}\n+++ ${after ? `b/${path}` : '/dev/null'}\n${hunks}`;
};

const gitHashBlob = async (content: Uint8Array): Promise<string> => {
  const header = new TextEncoder().encode(`blob ${content.length}\0`);
  const data = new Uint8Array(header.length + content.length);
  data.set(header);
  data.set(content, header.length);
  const digest = await crypto.subtle.digest('SHA-1', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

type Side = 'head' | 'stage' | 'workdir';

const entryContent = async (ctx: Context, repo: Repo, entry: git.WalkerEntry): Promise<Uint8Array> => {
  const content = await entry.content();
  if (content) return content;
  const oid = await entry.oid();
  return (await git.readBlob({ fs: ctx.fs, dir: repo.dir, oid })).blob;
};

const treeDiff = async (ctx: Context, repo: Repo, left: Side | { ref: string }, right: Side | { ref: string }, filter?: string[]): Promise<string> => {
  const walker = (side: Side | { ref: string }): git.Walker => {
    if (side === 'head') return git.TREE({ ref: 'HEAD' });
    if (side === 'stage') return git.STAGE();
    if (side === 'workdir') return git.WORKDIR();
    return git.TREE({ ref: side.ref });
  };
  const chunks: string[] = await git.walk({
    fs: ctx.fs,
    dir: repo.dir,
    trees: [walker(left), walker(right)],
    map: async (file: string, [a, b]: Array<git.WalkerEntry | null>) => {
      if (file === '.') return undefined;
      if (filter && filter.length > 0 && !filter.some((prefix) => file === prefix || file.startsWith(prefix + '/') || prefix === '.')) {
        const isTree = (await a?.type()) === 'tree' || (await b?.type()) === 'tree';
        return isTree && filter.some((prefix) => prefix.startsWith(file + '/')) ? undefined : null;
      }
      const aType = await a?.type();
      const bType = await b?.type();
      if (aType === 'tree' || bType === 'tree') return undefined;
      if (right === 'workdir' && !a && b) return null;
      const aContent = a ? await entryContent(ctx, repo, a) : undefined;
      const bContent = b ? await entryContent(ctx, repo, b) : undefined;
      const aOid = a ? await a.oid() : undefined;
      let bOid = b ? await b.oid() : undefined;
      if (b && right === 'workdir' && bContent) bOid = await gitHashBlob(bContent);
      if (aOid && bOid && aOid === bOid) return undefined;
      const diff = fileDiff(file, aContent, bContent, aOid, bOid);
      return diff || undefined;
    },
  });
  return (chunks ?? []).flat(Infinity).filter((chunk): chunk is string => typeof chunk === 'string').join('');
};

const status = async (ctx: Context, repo: Repo, args: string[]): Promise<void> => {
  const short = flag(args, '-s', '--short', '--porcelain');
  const showBranch = flag(args, '-b', '--branch');
  const branch = await git.currentBranch({ fs: ctx.fs, dir: repo.dir, fullname: false }).catch(() => undefined);
  const matrix = await git.statusMatrix({ fs: ctx.fs, dir: repo.dir });
  const staged: Array<[string, string]> = [];
  const unstaged: Array<[string, string]> = [];
  const untracked: string[] = [];
  for (const [file, head, workdir, stage] of matrix) {
    if (head === 0 && stage === 0 && workdir === 2) {
      untracked.push(file);
      continue;
    }
    if (head === 0 && stage !== 0) staged.push(['A', file]);
    else if (head === 1 && stage === 0) staged.push(['D', file]);
    else if (head === 1 && (stage === 3 || (stage === 2 && workdir === 2))) staged.push(['M', file]);
    if (stage !== 0 && workdir === 0) unstaged.push(['D', file]);
    else if (stage !== 0 && workdir !== 0 && (stage === 3 || (stage === 1 && workdir === 2) || (stage === 2 && workdir === 1))) unstaged.push(['M', file]);
  }
  if (short) {
    if (showBranch) ctx.out(`## ${branch ?? 'HEAD (no branch)'}\n`);
    const codes = new Map<string, [string, string]>();
    for (const [code, file] of staged) codes.set(file, [code, ' ']);
    for (const [code, file] of unstaged) codes.set(file, [codes.get(file)?.[0] ?? ' ', code]);
    for (const [file, [x, y]] of [...codes].sort()) ctx.out(`${x}${y} ${displayPath(ctx, repo, file)}\n`);
    for (const file of untracked.sort()) ctx.out(`?? ${displayPath(ctx, repo, file)}\n`);
    return;
  }
  ctx.out(branch ? `On branch ${branch}\n` : 'HEAD detached\n');
  const hasHead = await git.resolveRef({ fs: ctx.fs, dir: repo.dir, ref: 'HEAD' }).then(() => true, () => false);
  if (!hasHead) ctx.out('\nNo commits yet\n');
  const label = (code: string): string => (code === 'A' ? 'new file:   ' : code === 'D' ? 'deleted:    ' : 'modified:   ');
  if (staged.length > 0) {
    ctx.out(`\nChanges to be committed:\n  (use "git restore --staged <file>..." to unstage)\n`);
    for (const [code, file] of staged) ctx.out(`\t${label(code)}${displayPath(ctx, repo, file)}\n`);
  }
  if (unstaged.length > 0) {
    ctx.out(`\nChanges not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n  (use "git restore <file>..." to discard changes in working directory)\n`);
    for (const [code, file] of unstaged) ctx.out(`\t${label(code)}${displayPath(ctx, repo, file)}\n`);
  }
  if (untracked.length > 0) {
    ctx.out(`\nUntracked files:\n  (use "git add <file>..." to include in what will be committed)\n`);
    for (const file of untracked) ctx.out(`\t${displayPath(ctx, repo, file)}\n`);
  }
  if (staged.length === 0 && unstaged.length === 0) {
    if (untracked.length > 0) ctx.out('\nnothing added to commit but untracked files present (use "git add" to track)\n');
    else ctx.out(hasHead ? '\nnothing to commit, working tree clean\n' : '\nnothing to commit (create/copy files and use "git add" to track)\n');
  } else if (staged.length === 0) {
    ctx.out('\nno changes added to commit (use "git add" and/or "git commit -a")\n');
  }
};

const addPaths = async (ctx: Context, repo: Repo, paths: string[], all: boolean): Promise<void> => {
  const matrix = await git.statusMatrix({ fs: ctx.fs, dir: repo.dir });
  const targets = all ? ['.'] : paths.map((file) => repoPath(ctx, repo, file));
  const matches = (file: string): boolean => targets.some((target) => target === '.' || file === target || file.startsWith(target + '/'));
  let matched = false;
  for (const [file, , workdir] of matrix) {
    if (!matches(file)) continue;
    matched = true;
    if (workdir === 0) await git.remove({ fs: ctx.fs, dir: repo.dir, filepath: file });
    else await git.add({ fs: ctx.fs, dir: repo.dir, filepath: file });
  }
  if (!matched) {
    for (const target of targets) {
      if (target === '.') continue;
      if (!ctx.fs.existsSync(ctx.path.join(repo.dir, target))) throw new GitError(`fatal: pathspec '${target}' did not match any files`, 128);
    }
  }
};

const commit = async (ctx: Context, repo: Repo, rawArgs: string[]): Promise<void> => {
  const args = expandShortFlags(rawArgs, 'mFC');
  const messages: string[] = [];
  while (true) {
    const message = option(args, '-m', '--message');
    if (message === undefined) break;
    messages.push(message);
  }
  const file = option(args, '-F', '--file');
  if (file) messages.push(ctx.fs.readFileSync(ctx.path.resolve(ctx.cwd, file), 'utf8'));
  const all = flag(args, '-a', '--all');
  const amend = flag(args, '--amend');
  const allowEmpty = flag(args, '--allow-empty');
  const quiet = flag(args, '-q', '--quiet');
  if (all) {
    const matrix = await git.statusMatrix({ fs: ctx.fs, dir: repo.dir });
    for (const [path, head, workdir] of matrix) {
      if (head === 0) continue;
      if (workdir === 0) await git.remove({ fs: ctx.fs, dir: repo.dir, filepath: path });
      else await git.add({ fs: ctx.fs, dir: repo.dir, filepath: path });
    }
  }
  if (messages.length === 0 && !amend) throw new GitError('error: no commit message given (use -m)', 1);
  const author = await identity(ctx, repo);
  const matrix = await git.statusMatrix({ fs: ctx.fs, dir: repo.dir });
  const changes = matrix.filter(([, head, , stage]) => head !== stage && !(head === 1 && stage === 1));
  const hasHead = await git.resolveRef({ fs: ctx.fs, dir: repo.dir, ref: 'HEAD' }).then(() => true, () => false);
  if (changes.filter(([, head, workdir, stage]) => !(head === 1 && stage === 2 && workdir === 1)).length === 0 && !allowEmpty && !amend && hasHead) {
    ctx.out('nothing to commit, working tree clean\n');
    throw new GitError('', 1);
  }
  const message = messages.length > 0 ? messages.join('\n\n') : undefined;
  const oid = await git.commit({ fs: ctx.fs, dir: repo.dir, author, ...(message !== undefined ? { message } : {}), amend });
  if (quiet) return;
  const branch = await git.currentBranch({ fs: ctx.fs, dir: repo.dir }).catch(() => undefined);
  const subject = (message ?? (await git.readCommit({ fs: ctx.fs, dir: repo.dir, oid })).commit.message).split('\n')[0];
  ctx.out(`[${branch ?? 'detached HEAD'}${hasHead ? '' : ' (root-commit)'} ${shortOid(oid)}] ${subject}\n`);
  ctx.out(` ${changes.length} file${changes.length === 1 ? '' : 's'} changed\n`);
};

const log = async (ctx: Context, repo: Repo, args: string[]): Promise<void> => {
  const oneline = flag(args, '--oneline');
  let depth: number | undefined;
  const count = option(args, '-n', '--max-count');
  if (count) depth = Number(count);
  for (let i = 0; i < args.length; i++) {
    if (/^-\d+$/.test(args[i]!)) {
      depth = Number(args[i]!.slice(1));
      args.splice(i, 1);
      i--;
    }
  }
  const ref = args.find((arg) => !arg.startsWith('-')) ?? 'HEAD';
  let entries: git.ReadCommitResult[];
  try {
    entries = await git.log({ fs: ctx.fs, dir: repo.dir, ref, ...(depth ? { depth } : {}) });
  } catch {
    const branch = await git.currentBranch({ fs: ctx.fs, dir: repo.dir }).catch(() => 'HEAD');
    throw new GitError(`fatal: your current branch '${branch}' does not have any commits yet`, 128);
  }
  for (const entry of entries) {
    const { commit: c } = entry;
    if (oneline) {
      ctx.out(`${shortOid(entry.oid)} ${c.message.split('\n')[0]}\n`);
      continue;
    }
    ctx.out(`commit ${entry.oid}\n`);
    if (c.parent.length > 1) ctx.out(`Merge: ${c.parent.map(shortOid).join(' ')}\n`);
    ctx.out(`Author: ${c.author.name} <${c.author.email}>\nDate:   ${formatDate(c.author.timestamp, c.author.timezoneOffset)}\n\n${indent(c.message)}\n\n`);
  }
};

const show = async (ctx: Context, repo: Repo, args: string[]): Promise<void> => {
  const ref = args.find((arg) => !arg.startsWith('-')) ?? 'HEAD';
  const oid = await resolveCommitish(ctx, repo, ref);
  const { commit: c } = await git.readCommit({ fs: ctx.fs, dir: repo.dir, oid });
  ctx.out(`commit ${oid}\nAuthor: ${c.author.name} <${c.author.email}>\nDate:   ${formatDate(c.author.timestamp, c.author.timezoneOffset)}\n\n${indent(c.message)}\n\n`);
  const parent = c.parent[0];
  if (parent) ctx.out(await treeDiff(ctx, repo, { ref: parent }, { ref: oid }));
  else {
    const files = await git.listFiles({ fs: ctx.fs, dir: repo.dir, ref: oid });
    for (const file of files) {
      const { blob, oid: blobOid } = await git.readBlob({ fs: ctx.fs, dir: repo.dir, oid, filepath: file });
      ctx.out(fileDiff(file, undefined, blob, undefined, blobOid));
    }
  }
};

const resolveCommitish = async (ctx: Context, repo: Repo, ref: string): Promise<string> => {
  const match = /^(.*?)((?:[~^]\d*)*)$/.exec(ref)!;
  let base = match[1] || 'HEAD';
  let oid: string;
  try {
    oid = await git.resolveRef({ fs: ctx.fs, dir: repo.dir, ref: base });
  } catch {
    try {
      oid = /^[0-9a-f]{4,40}$/.test(base) ? await git.expandOid({ fs: ctx.fs, dir: repo.dir, oid: base }) : '';
    } catch {
      oid = '';
    }
    if (!oid) throw new GitError(`fatal: ambiguous argument '${ref}': unknown revision or path not in the working tree.`, 128);
  }
  const { type } = await git.readObject({ fs: ctx.fs, dir: repo.dir, oid }).catch(() => ({ type: 'commit' as const }));
  if (type === 'tag') oid = (await git.readTag({ fs: ctx.fs, dir: repo.dir, oid })).tag.object;
  for (const step of match[2]!.match(/[~^]\d*/g) ?? []) {
    const n = step.length > 1 ? Number(step.slice(1)) : 1;
    if (step[0] === '~') {
      for (let i = 0; i < n; i++) {
        const parent = (await git.readCommit({ fs: ctx.fs, dir: repo.dir, oid })).commit.parent[0];
        if (!parent) throw new GitError(`fatal: ambiguous argument '${ref}': unknown revision`, 128);
        oid = parent;
      }
    } else {
      const parent = (await git.readCommit({ fs: ctx.fs, dir: repo.dir, oid })).commit.parent[n - 1];
      if (!parent) throw new GitError(`fatal: ambiguous argument '${ref}': unknown revision`, 128);
      oid = parent;
    }
  }
  base = oid;
  return base;
};

const branchCommand = async (ctx: Context, repo: Repo, args: string[]): Promise<void> => {
  const remote = flag(args, '-r', '--remotes');
  const all = flag(args, '-a', '--all');
  const deleteName = option(args, '-d', '--delete') ?? option(args, '-D');
  const move = flag(args, '-m', '--move');
  if (deleteName) {
    await git.deleteBranch({ fs: ctx.fs, dir: repo.dir, ref: deleteName });
    ctx.out(`Deleted branch ${deleteName}.\n`);
    return;
  }
  if (move) {
    const [from, to] = args.length >= 2 ? args : [await git.currentBranch({ fs: ctx.fs, dir: repo.dir }) ?? '', args[0]!];
    await git.renameBranch({ fs: ctx.fs, dir: repo.dir, oldref: from!, ref: to!, checkout: true });
    return;
  }
  const name = args.find((arg) => !arg.startsWith('-'));
  if (name) {
    const start = args[args.indexOf(name) + 1];
    await git.branch({ fs: ctx.fs, dir: repo.dir, ref: name, ...(start ? { object: await resolveCommitish(ctx, repo, start) } : {}) });
    return;
  }
  const current = await git.currentBranch({ fs: ctx.fs, dir: repo.dir }).catch(() => undefined);
  if (!remote) {
    for (const branch of (await git.listBranches({ fs: ctx.fs, dir: repo.dir })).sort()) ctx.out(`${branch === current ? '*' : ' '} ${branch}\n`);
  }
  if (remote || all) {
    for (const { remote: remoteName } of await git.listRemotes({ fs: ctx.fs, dir: repo.dir })) {
      for (const branch of (await git.listBranches({ fs: ctx.fs, dir: repo.dir, remote: remoteName })).sort()) {
        ctx.out(`  ${all ? 'remotes/' : ''}${remoteName}/${branch}\n`);
      }
    }
  }
};

const checkoutCommand = async (ctx: Context, repo: Repo, args: string[], mode: 'checkout' | 'switch'): Promise<void> => {
  const create = option(args, mode === 'switch' ? '-c' : '-b', mode === 'switch' ? '--create' : '-B');
  const force = flag(args, '-f', '--force');
  const separator = args.indexOf('--');
  if (mode === 'checkout' && separator !== -1) {
    const files = args.slice(separator + 1).map((file) => repoPath(ctx, repo, file));
    const source = args.slice(0, separator)[0];
    await restoreFiles(ctx, repo, files, source ?? null, false);
    return;
  }
  if (create) {
    const start = args.find((arg) => !arg.startsWith('-'));
    await git.branch({ fs: ctx.fs, dir: repo.dir, ref: create, ...(start ? { object: await resolveCommitish(ctx, repo, start) } : {}) });
    await git.checkout({ fs: ctx.fs, dir: repo.dir, ref: create, noCheckout: !start, force });
    ctx.err(`Switched to a new branch '${create}'\n`);
    return;
  }
  const target = args.find((arg) => !arg.startsWith('-'));
  if (!target) throw new GitError(mode === 'switch' ? 'fatal: missing branch or commit argument' : 'fatal: you must specify path(s) to restore', 128);
  const branches = await git.listBranches({ fs: ctx.fs, dir: repo.dir });
  if (!branches.includes(target) && mode === 'checkout') {
    const paths = args.filter((arg) => !arg.startsWith('-'));
    if (paths.every((path) => ctx.fs.existsSync(ctx.path.resolve(ctx.cwd, path)))) {
      await restoreFiles(ctx, repo, paths.map((path) => repoPath(ctx, repo, path)), null, false);
      return;
    }
  }
  const remotes = await git.listRemotes({ fs: ctx.fs, dir: repo.dir });
  const remoteHasBranch = !branches.includes(target) && remotes.length > 0
    ? (await git.listBranches({ fs: ctx.fs, dir: repo.dir, remote: remotes[0]!.remote })).includes(target)
    : false;
  try {
    await git.checkout({ fs: ctx.fs, dir: repo.dir, ref: target, force, ...(remoteHasBranch ? { remote: remotes[0]!.remote, track: true } : {}) });
  } catch (error) {
    if ((error as { code?: string }).code === 'CheckoutConflictError') {
      const data = (error as { data?: { filepaths?: string[] } }).data;
      throw new GitError(`error: Your local changes to the following files would be overwritten by checkout:\n${(data?.filepaths ?? []).map((file) => `\t${file}`).join('\n')}\nPlease commit your changes or stash them before you switch branches.\nAborting`, 1);
    }
    if ((error as { code?: string }).code === 'NotFoundError') throw new GitError(`error: pathspec '${target}' did not match any file(s) known to git`, 1);
    throw error;
  }
  if (branches.includes(target) || remoteHasBranch) ctx.err(`Switched to branch '${target}'\n`);
  else ctx.err(`HEAD is now at ${shortOid(await git.resolveRef({ fs: ctx.fs, dir: repo.dir, ref: 'HEAD' }))}\n`);
};

const restoreFiles = async (ctx: Context, repo: Repo, files: string[], source: string | null, stagedOnly: boolean): Promise<void> => {
  const ref = source ?? 'HEAD';
  const oid = await resolveCommitish(ctx, repo, ref).catch(() => undefined);
  for (const file of files) {
    if (stagedOnly) {
      await git.resetIndex({ fs: ctx.fs, dir: repo.dir, filepath: file, ...(oid ? { ref: oid } : {}) });
      continue;
    }
    if (source === null) {
      const index = await git.walk({
        fs: ctx.fs,
        dir: repo.dir,
        trees: [git.STAGE()],
        map: async (path: string, [entry]: Array<git.WalkerEntry | null>) => {
          if (path === '.' || (await entry?.type()) === 'tree') return path === file || file.startsWith(path + '/') || path.startsWith(file + '/') || path === '.' ? undefined : null;
          if (path !== file && !path.startsWith(file + '/') && file !== '.') return null;
          return entry ? { path, content: await entryContent(ctx, repo, entry) } : null;
        },
      }) as unknown[];
      const restored = (index ?? []).flat(Infinity).filter((item): item is { path: string; content: Uint8Array } => !!item && typeof item === 'object' && 'path' in item);
      if (restored.length === 0) throw new GitError(`error: pathspec '${file}' did not match any file(s) known to git`, 1);
      for (const item of restored) {
        const target = ctx.path.join(repo.dir, item.path);
        ctx.fs.mkdirSync(ctx.path.dirname(target), { recursive: true });
        await ctx.fs.promises.writeFile(target, item.content ?? new Uint8Array(0));
      }
      continue;
    }
    if (!oid) throw new GitError(`fatal: invalid reference: ${ref}`, 128);
    const { blob } = await git.readBlob({ fs: ctx.fs, dir: repo.dir, oid, filepath: file });
    await ctx.fs.promises.writeFile(ctx.path.join(repo.dir, file), blob);
    await git.add({ fs: ctx.fs, dir: repo.dir, filepath: file });
  }
};

const reset = async (ctx: Context, repo: Repo, args: string[]): Promise<void> => {
  const hard = flag(args, '--hard');
  const soft = flag(args, '--soft');
  flag(args, '--mixed');
  const separator = args.indexOf('--');
  const positional = args.filter((arg, i) => !arg.startsWith('-') && (separator === -1 || i < separator));
  const paths = separator !== -1 ? args.slice(separator + 1) : positional.slice(1);
  const target = positional[0];
  if (target && paths.length === 0 && !await resolveCommitish(ctx, repo, target).then(() => true, () => false)) {
    await restoreFiles(ctx, repo, [repoPath(ctx, repo, target)], null, true);
    return;
  }
  if (paths.length > 0) {
    await restoreFiles(ctx, repo, paths.map((path) => repoPath(ctx, repo, path)), target ?? 'HEAD', true);
    return;
  }
  const oid = await resolveCommitish(ctx, repo, target ?? 'HEAD');
  const branch = await git.currentBranch({ fs: ctx.fs, dir: repo.dir, fullname: true });
  if (branch) await git.writeRef({ fs: ctx.fs, dir: repo.dir, ref: branch, value: oid, force: true });
  else await git.writeRef({ fs: ctx.fs, dir: repo.dir, ref: 'HEAD', value: oid, force: true });
  if (soft) return;
  if (hard) {
    await git.checkout({ fs: ctx.fs, dir: repo.dir, ref: branch ?? oid, force: true });
    const matrix = await git.statusMatrix({ fs: ctx.fs, dir: repo.dir });
    for (const [file, head] of matrix) if (head === 1) await git.resetIndex({ fs: ctx.fs, dir: repo.dir, filepath: file });
    const { commit: c } = await git.readCommit({ fs: ctx.fs, dir: repo.dir, oid });
    ctx.out(`HEAD is now at ${shortOid(oid)} ${c.message.split('\n')[0]}\n`);
    return;
  }
  const matrix = await git.statusMatrix({ fs: ctx.fs, dir: repo.dir });
  for (const [file] of matrix) await git.resetIndex({ fs: ctx.fs, dir: repo.dir, filepath: file, ref: oid });
};

const config = async (ctx: Context, args: string[]): Promise<void> => {
  const globalScope = flag(args, '--global');
  const list = flag(args, '-l', '--list');
  const unset = flag(args, '--unset');
  flag(args, '--get', '--local');
  const repo = await findRepo(ctx).catch(() => undefined);
  if (list) {
    const values = new Map(readGlobalConfig(ctx));
    if (repo && !globalScope) {
      const text = ctx.fs.readFileSync(ctx.path.join(repo.gitdir, 'config'), 'utf8');
      for (const [key, value] of parseIni(text)) values.set(key, value);
    }
    for (const [key, value] of values) ctx.out(`${key}=${value}\n`);
    return;
  }
  const [key, value] = args;
  if (!key) throw new GitError('usage: git config [<options>]', 129);
  if (globalScope || !repo) {
    if (!globalScope && value !== undefined) throw new GitError('fatal: not in a git directory', 128);
    const values = readGlobalConfig(ctx);
    if (unset) values.delete(key.toLowerCase());
    else if (value === undefined) {
      const found = values.get(key.toLowerCase());
      if (found === undefined) throw new GitError('', 1);
      ctx.out(`${found}\n`);
      return;
    } else values.set(key.toLowerCase(), value);
    ctx.fs.writeFileSync(globalConfigPath(ctx), serializeIni(values));
    return;
  }
  if (unset) {
    await git.setConfig({ fs: ctx.fs, dir: repo.dir, path: key, value: undefined });
    return;
  }
  if (value === undefined) {
    const found = await configValue(ctx, repo, key);
    if (found === undefined) throw new GitError('', 1);
    ctx.out(`${found}\n`);
    return;
  }
  await git.setConfig({ fs: ctx.fs, dir: repo.dir, path: key, value });
};

const remoteCommand = async (ctx: Context, repo: Repo, args: string[]): Promise<void> => {
  const verbose = flag(args, '-v', '--verbose');
  const [sub, name, url] = args;
  if (sub === 'add') {
    if (!name || !url) throw new GitError('usage: git remote add <name> <url>', 129);
    await git.addRemote({ fs: ctx.fs, dir: repo.dir, remote: name, url });
    return;
  }
  if (sub === 'remove' || sub === 'rm') {
    if (!name) throw new GitError('usage: git remote remove <name>', 129);
    await git.deleteRemote({ fs: ctx.fs, dir: repo.dir, remote: name });
    return;
  }
  if (sub === 'get-url') {
    const found = (await git.listRemotes({ fs: ctx.fs, dir: repo.dir })).find((remote) => remote.remote === name);
    if (!found) throw new GitError(`error: No such remote '${name}'`, 2);
    ctx.out(`${found.url}\n`);
    return;
  }
  if (sub === 'set-url') {
    if (!name || !url) throw new GitError('usage: git remote set-url <name> <newurl>', 129);
    await git.addRemote({ fs: ctx.fs, dir: repo.dir, remote: name, url, force: true });
    return;
  }
  for (const remote of await git.listRemotes({ fs: ctx.fs, dir: repo.dir })) {
    ctx.out(verbose ? `${remote.remote}\t${remote.url} (fetch)\n${remote.remote}\t${remote.url} (push)\n` : `${remote.remote}\n`);
  }
};

const tagCommand = async (ctx: Context, repo: Repo, args: string[]): Promise<void> => {
  const remove = option(args, '-d', '--delete');
  const message = option(args, '-m', '--message');
  const annotate = flag(args, '-a', '--annotate') || message !== undefined;
  if (remove) {
    await git.deleteTag({ fs: ctx.fs, dir: repo.dir, ref: remove });
    ctx.out(`Deleted tag '${remove}'\n`);
    return;
  }
  const [name, target] = args.filter((arg) => !arg.startsWith('-'));
  if (!name) {
    for (const tag of (await git.listTags({ fs: ctx.fs, dir: repo.dir })).sort()) ctx.out(`${tag}\n`);
    return;
  }
  const object = await resolveCommitish(ctx, repo, target ?? 'HEAD');
  if (annotate) {
    await git.annotatedTag({ fs: ctx.fs, dir: repo.dir, ref: name, object, message: message ?? name, tagger: await identity(ctx, repo) });
  } else {
    await git.tag({ fs: ctx.fs, dir: repo.dir, ref: name, object });
  }
};

const progress = (ctx: Context, quiet: boolean) => (event: git.GitProgressEvent): void => {
  if (quiet) return;
  const amount = event.total ? `${Math.round((event.loaded / event.total) * 100)}% (${event.loaded}/${event.total})` : `${event.loaded}`;
  ctx.err(`\r${event.phase}: ${amount}${event.total && event.loaded >= event.total ? ', done.\n' : ''}`);
};

const clone = async (ctx: Context, args: string[]): Promise<void> => {
  const depth = option(args, '--depth');
  const branch = option(args, '-b', '--branch');
  const quiet = flag(args, '-q', '--quiet');
  const singleBranch = flag(args, '--single-branch');
  const noCheckout = flag(args, '-n', '--no-checkout');
  const [url, target] = args.filter((arg) => !arg.startsWith('-'));
  if (!url) throw new GitError('fatal: You must specify a repository to clone.', 129);
  const name = target ?? ctx.path.basename(url.replace(/\/+$/, ''), '.git');
  const dir = ctx.path.resolve(ctx.cwd, name);
  if (ctx.fs.existsSync(dir) && (await ctx.fs.promises.readdir(dir)).length > 0) {
    throw new GitError(`fatal: destination path '${name}' already exists and is not an empty directory.`, 128);
  }
  ctx.err(`Cloning into '${name}'...\n`);
  ctx.fs.mkdirSync(dir, { recursive: true });
  try {
    await git.clone({
      fs: ctx.fs,
      dir,
      url,
      ...remoteOptions(ctx),
      onProgress: progress(ctx, quiet),
      ...(depth ? { depth: Number(depth) } : {}),
      ...(branch ? { ref: branch } : {}),
      singleBranch: singleBranch || !!depth,
      noCheckout,
    });
  } catch (error) {
    ctx.fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
};

const fetchCommand = async (ctx: Context, repo: Repo, args: string[], mode: 'fetch' | 'pull'): Promise<void> => {
  const quiet = flag(args, '-q', '--quiet');
  const ffOnly = flag(args, '--ff-only');
  flag(args, '--rebase', '--no-rebase');
  const [remote, ref] = args.filter((arg) => !arg.startsWith('-'));
  const branch = await git.currentBranch({ fs: ctx.fs, dir: repo.dir }) ?? undefined;
  const common = {
    fs: ctx.fs,
    dir: repo.dir,
    ...remoteOptions(ctx),
    onProgress: progress(ctx, quiet),
    ...(remote ? { remote } : {}),
  };
  if (mode === 'fetch') {
    const result = await git.fetch({ ...common, ...(ref ? { ref } : {}), tags: true });
    if (!quiet && result.fetchHead) ctx.err(`From ${result.defaultBranch ?? remote ?? 'origin'}\n`);
    return;
  }
  const author = await identity(ctx, repo).catch(() => ({ name: 'Dusk', email: 'dusk@localhost' }));
  const before = await git.resolveRef({ fs: ctx.fs, dir: repo.dir, ref: 'HEAD' }).catch(() => undefined);
  await git.pull({
    ...common,
    ...(ref ?? branch ? { ref: ref ?? branch } : {}),
    singleBranch: true,
    fastForwardOnly: ffOnly,
    author,
  });
  const after = await git.resolveRef({ fs: ctx.fs, dir: repo.dir, ref: 'HEAD' });
  if (quiet) return;
  ctx.out(before === after ? 'Already up to date.\n' : `Updating ${before ? shortOid(before) : '0000000'}..${shortOid(after)}\nFast-forward\n`);
};

const push = async (ctx: Context, repo: Repo, args: string[]): Promise<void> => {
  const force = flag(args, '-f', '--force');
  const setUpstream = flag(args, '-u', '--set-upstream');
  const deleteRef = flag(args, '-d', '--delete');
  const quiet = flag(args, '-q', '--quiet');
  const [remote = 'origin', refspec] = args.filter((arg) => !arg.startsWith('-'));
  const current = await git.currentBranch({ fs: ctx.fs, dir: repo.dir }) ?? undefined;
  const [local, remoteRef] = (refspec ?? current ?? '').split(':');
  if (!local && !deleteRef) throw new GitError('fatal: You are not currently on a branch.', 128);
  const result = await git.push({
    fs: ctx.fs,
    dir: repo.dir,
    ...remoteOptions(ctx),
    onProgress: progress(ctx, quiet),
    remote,
    ref: local,
    ...(remoteRef ? { remoteRef } : {}),
    force,
    delete: deleteRef,
  });
  if (!result.ok) throw new GitError(`error: failed to push some refs\n${JSON.stringify(result.refs)}`, 1);
  if (setUpstream && local) {
    await git.setConfig({ fs: ctx.fs, dir: repo.dir, path: `branch.${local}.remote`, value: remote });
    await git.setConfig({ fs: ctx.fs, dir: repo.dir, path: `branch.${local}.merge`, value: `refs/heads/${remoteRef ?? local}` });
  }
  if (!quiet) ctx.err(`To ${(await git.listRemotes({ fs: ctx.fs, dir: repo.dir })).find((r) => r.remote === remote)?.url ?? remote}\n   ${local} -> ${remoteRef ?? local}\n`);
};

const merge = async (ctx: Context, repo: Repo, args: string[]): Promise<void> => {
  const message = option(args, '-m', '--message');
  const ffOnly = flag(args, '--ff-only');
  const noFf = flag(args, '--no-ff');
  const abort = flag(args, '--abort');
  if (abort) {
    await git.abortMerge({ fs: ctx.fs, dir: repo.dir });
    return;
  }
  const theirs = args.find((arg) => !arg.startsWith('-'));
  if (!theirs) throw new GitError('fatal: No remote for the current branch.', 128);
  const ours = await git.currentBranch({ fs: ctx.fs, dir: repo.dir }) ?? 'HEAD';
  try {
    const result = await git.merge({
      fs: ctx.fs,
      dir: repo.dir,
      ours,
      theirs,
      fastForward: !noFf,
      fastForwardOnly: ffOnly,
      author: await identity(ctx, repo),
      abortOnConflict: false,
      ...(message ? { message } : {}),
    });
    if (result.alreadyMerged) {
      ctx.out('Already up to date.\n');
      return;
    }
    await git.checkout({ fs: ctx.fs, dir: repo.dir, ref: ours });
    ctx.out(result.fastForward ? `Fast-forward\n` : `Merge made by the 'ort' strategy.\n`);
  } catch (error) {
    if ((error as { code?: string }).code === 'MergeConflictError') {
      const files = (error as { data?: { filepaths?: string[] } }).data?.filepaths ?? [];
      for (const file of files) ctx.out(`CONFLICT (content): Merge conflict in ${file}\n`);
      throw new GitError('Automatic merge failed; fix conflicts and then commit the result.', 1);
    }
    throw error;
  }
};

const stashCommand = async (ctx: Context, repo: Repo, args: string[]): Promise<void> => {
  const sub = args[0] && !args[0].startsWith('-') ? args.shift()! : 'push';
  const message = option(args, '-m', '--message');
  const op = (sub === 'save' ? 'push' : sub) as 'push' | 'pop' | 'apply' | 'drop' | 'list' | 'clear';
  const added: string[] = [];
  if (op === 'push') {
    const who = await identity(ctx, repo);
    for (const [key, value] of [['user.name', who.name], ['user.email', who.email]] as const) {
      const local = await git.getConfig({ fs: ctx.fs, dir: repo.dir, path: key }).catch(() => undefined);
      if (local === undefined || local === null) {
        await git.setConfig({ fs: ctx.fs, dir: repo.dir, path: key, value });
        added.push(key);
      }
    }
  }
  let result: unknown;
  try {
    result = await git.stash({ fs: ctx.fs, dir: repo.dir, op, ...(message ? { message } : {}) });
  } finally {
    for (const key of added) await git.setConfig({ fs: ctx.fs, dir: repo.dir, path: key, value: undefined });
  }
  if (op === 'list' && Array.isArray(result)) for (const [i, entry] of (result as string[]).entries()) ctx.out(`stash@{${i}}: ${entry}\n`);
  else if (op === 'push') ctx.out('Saved working directory and index state\n');
};

const revParse = async (ctx: Context, args: string[]): Promise<void> => {
  const repo = await findRepo(ctx);
  const abbrev = flag(args, '--abbrev-ref');
  const shortFlag = flag(args, '--short');
  for (const arg of args) {
    if (arg === '--show-toplevel') ctx.out(`${repo.dir}\n`);
    else if (arg === '--git-dir') ctx.out(`${ctx.path.relative(ctx.cwd, repo.gitdir) || '.git'}\n`);
    else if (arg === '--is-inside-work-tree') ctx.out('true\n');
    else if (abbrev && arg === 'HEAD') ctx.out(`${await git.currentBranch({ fs: ctx.fs, dir: repo.dir }) ?? 'HEAD'}\n`);
    else {
      const oid = await resolveCommitish(ctx, repo, arg);
      ctx.out(`${shortFlag ? shortOid(oid) : oid}\n`);
    }
  }
};

const HELP = `usage: git [-C <path>] <command> [<args>]

These are the common Git commands available in Dusk:

start a working area
   clone      Clone a repository into a new directory
   init       Create an empty Git repository

work on the current change
   add        Add file contents to the index
   rm         Remove files from the working tree and from the index
   restore    Restore working tree files
   reset      Reset current HEAD to the specified state
   stash      Stash the changes in a dirty working directory away

examine the history and state
   diff       Show changes between commits, commit and working tree, etc
   log        Show commit logs
   show       Show a commit
   status     Show the working tree status

grow, mark and tweak your common history
   branch     List, create, or delete branches
   commit     Record changes to the repository
   merge      Join two development histories together
   switch     Switch branches
   checkout   Switch branches or restore working tree files
   tag        Create, list or delete tags

collaborate
   fetch      Download objects and refs from another repository
   pull       Fetch from and integrate with another repository
   push       Update remote refs along with associated objects
   remote     Manage set of tracked repositories

Credentials come from GIT_USERNAME/GIT_PASSWORD or GIT_TOKEN/GITHUB_TOKEN.
`;

const dispatch = async (ctx: Context, command: string, args: string[]): Promise<void> => {
  switch (command) {
    case 'init': {
      const bare = flag(args, '--bare');
      const quiet = flag(args, '-q', '--quiet');
      const initialBranch = option(args, '-b', '--initial-branch') ?? readGlobalConfig(ctx).get('init.defaultbranch') ?? 'main';
      const dir = ctx.path.resolve(ctx.cwd, args.find((arg) => !arg.startsWith('-')) ?? '.');
      const existed = ctx.fs.existsSync(ctx.path.join(dir, bare ? 'config' : '.git'));
      ctx.fs.mkdirSync(dir, { recursive: true });
      await git.init({ fs: ctx.fs, dir, bare, defaultBranch: initialBranch });
      if (!quiet) ctx.out(`${existed ? 'Reinitialized existing' : 'Initialized empty'} Git repository in ${bare ? dir : ctx.path.join(dir, '.git')}/\n`);
      return;
    }
    case 'clone': return clone(ctx, args);
    case 'config': return config(ctx, args);
    case 'rev-parse': return revParse(ctx, args);
    case 'help': case '--help': case '-h':
      ctx.out(HELP);
      return;
    case 'version': case '--version':
      ctx.out(`git version 2.44.0 (isomorphic-git ${git.version()})\n`);
      return;
  }
  const repo = await findRepo(ctx);
  switch (command) {
    case 'status': return status(ctx, repo, args);
    case 'add': {
      const all = flag(args, '-A', '--all') || flag(args, '-u', '--update');
      const paths = args.filter((arg) => !arg.startsWith('-'));
      if (!all && paths.length === 0) {
        ctx.out('Nothing specified, nothing added.\n');
        return;
      }
      return addPaths(ctx, repo, paths, all);
    }
    case 'rm': {
      const cached = flag(args, '--cached');
      flag(args, '-r', '-f', '--force');
      for (const file of args.filter((arg) => !arg.startsWith('-'))) {
        const path = repoPath(ctx, repo, file);
        const tracked = (await git.listFiles({ fs: ctx.fs, dir: repo.dir })).filter((entry) => entry === path || entry.startsWith(path + '/'));
        if (tracked.length === 0) throw new GitError(`fatal: pathspec '${file}' did not match any files`, 128);
        for (const entry of tracked) {
          await git.remove({ fs: ctx.fs, dir: repo.dir, filepath: entry });
          if (!cached) ctx.fs.rmSync(ctx.path.join(repo.dir, entry), { force: true });
          ctx.out(`rm '${entry}'\n`);
        }
      }
      return;
    }
    case 'commit': return commit(ctx, repo, args);
    case 'log': return log(ctx, repo, args);
    case 'show': return show(ctx, repo, args);
    case 'diff': {
      const cached = flag(args, '--cached', '--staged');
      const nameOnly = flag(args, '--name-only');
      const separator = args.indexOf('--');
      const positional = args.filter((arg, i) => !arg.startsWith('-') && (separator === -1 || i < separator));
      const refs: string[] = [];
      const paths: string[] = separator !== -1 ? args.slice(separator + 1) : [];
      for (const arg of positional) {
        if (separator === -1 && await resolveCommitish(ctx, repo, arg).then(() => true, () => false)) refs.push(arg);
        else paths.push(arg);
      }
      const filter = paths.map((path) => repoPath(ctx, repo, path));
      let output: string;
      if (refs.length >= 2) output = await treeDiff(ctx, repo, { ref: await resolveCommitish(ctx, repo, refs[0]!) }, { ref: await resolveCommitish(ctx, repo, refs[1]!) }, filter);
      else if (refs.length === 1) output = await treeDiff(ctx, repo, { ref: await resolveCommitish(ctx, repo, refs[0]!) }, cached ? 'stage' : 'workdir', filter);
      else if (cached) output = await treeDiff(ctx, repo, 'head', 'stage', filter);
      else output = await treeDiff(ctx, repo, 'stage', 'workdir', filter);
      if (nameOnly) output = [...output.matchAll(/^diff --git a\/(.+) b\//gm)].map((match) => `${match[1]}\n`).join('');
      ctx.out(output);
      return;
    }
    case 'branch': return branchCommand(ctx, repo, args);
    case 'checkout': return checkoutCommand(ctx, repo, args, 'checkout');
    case 'switch': return checkoutCommand(ctx, repo, args, 'switch');
    case 'restore': {
      const staged = flag(args, '-S', '--staged');
      const source = option(args, '-s', '--source');
      const files = args.filter((arg) => !arg.startsWith('-') && arg !== '--').map((file) => repoPath(ctx, repo, file));
      if (files.length === 0) throw new GitError('fatal: you must specify path(s) to restore', 128);
      return restoreFiles(ctx, repo, files, source ?? (staged ? 'HEAD' : null), staged);
    }
    case 'reset': return reset(ctx, repo, args);
    case 'merge': return merge(ctx, repo, args);
    case 'fetch': return fetchCommand(ctx, repo, args, 'fetch');
    case 'pull': return fetchCommand(ctx, repo, args, 'pull');
    case 'push': return push(ctx, repo, args);
    case 'remote': return remoteCommand(ctx, repo, args);
    case 'tag': return tagCommand(ctx, repo, args);
    case 'stash': return stashCommand(ctx, repo, args);
    case 'ls-files':
      for (const file of await git.listFiles({ fs: ctx.fs, dir: repo.dir })) ctx.out(`${displayPath(ctx, repo, file)}\n`);
      return;
    default:
      throw new GitError(`git: '${command}' is not a git command. See 'git --help'.`, 1);
  }
};

export const main = async (): Promise<number> => {
  const proc = (globalThis as { process?: Proc }).process;
  if (!proc) return 1;
  const path = load<PathModule>('path');
  const fs = load<Fs>('fs');
  const args = proc.argv.slice(1);
  let cwd = proc.cwd();
  while (args[0] === '-C' || args[0] === '-c' || args[0] === '--no-pager' || args[0] === '-P') {
    const flagName = args.shift()!;
    if (flagName === '-C') cwd = path.resolve(cwd, args.shift() ?? '.');
    else if (flagName === '-c') args.shift();
  }
  const command = args.shift() ?? 'help';
  const ctx: Context = {
    proc,
    fs,
    path,
    cwd,
    out: (text) => proc.stdout.write(text),
    err: (text) => proc.stderr.write(text),
  };
  let code = 0;
  try {
    await dispatch(ctx, command, args);
  } catch (error) {
    if (error instanceof GitError) {
      if (error.message) ctx.err(`${error.message}\n`);
      code = error.code;
    } else {
      const known = error as { code?: string; message?: string };
      ctx.err(`fatal: ${known.message ?? String(error)}\n`);
      code = 128;
    }
  }
  proc.exit?.(code);
  return code;
};

