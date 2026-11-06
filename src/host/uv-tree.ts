// Moving directory trees between Dusk's filesystem and the uv engine's.
//
// The uv engine (tholus) keeps its own filesystem inside its worker. Dusk's
// filesystem stays the source of truth: before a uv command the project is
// copied in with `importTree`, and afterwards whatever uv changed is copied
// back. Both directions use tholus's tree shape — one buffer plus an offset
// table — so a whole site-packages crosses the worker boundary as one
// transfer instead of thousands of messages.

import type { FSBackend } from './fs-backend';

export type TreeEntry =
  | { kind: 'file'; path: string; offset: number; length: number }
  | { kind: 'symlink'; path: string; target: string };

export interface Tree {
  entries: TreeEntry[];
  bytes: Uint8Array;
}

export interface CollectOptions {
  /** Directory names skipped wherever they appear. */
  skip?: ReadonlySet<string>;
  /** Refuse a tree whose files add up to more than this. */
  maxBytes?: number;
}

export interface CollectedTree extends Tree {
  /** Cheap fingerprint (paths, sizes, mtimes, link targets) for change detection. */
  signature: string;
  /** Content digest per relative path, so the trip back can skip what uv left alone. */
  digests: Map<string, string>;
}

/** Directories never worth sending to uv: other ecosystems' state and VCS internals. */
export const DEFAULT_SKIP: ReadonlySet<string> = new Set(['node_modules', '.git', '__pycache__']);

/** 512 MiB: comfortably a scientific stack, well short of exhausting a tab. */
export const DEFAULT_MAX_TREE_BYTES = 512 * 1024 * 1024;

export class TreeTooLargeError extends Error {
  readonly code = 'ERR_DUSK_UV_TREE_TOO_LARGE';
  constructor(root: string, bytes: number, limit: number) {
    super(`${root} holds ${bytes} bytes, more than the ${limit}-byte limit for handing a tree to uv`);
  }
}

const join = (root: string, rel: string): string => (root === '/' ? `/${rel}` : `${root}/${rel}`);

interface Found {
  path: string;
  kind: 'file' | 'symlink';
  size: number;
  mtimeMs: number;
  target?: string;
}

const isSymlink = async (fs: FSBackend, path: string): Promise<boolean> => {
  if (!fs.lstat) return false;
  try { return (await fs.lstat(path)).isSymlink === true; } catch { return false; }
};

const walk = async (fs: FSBackend, root: string, skip: ReadonlySet<string>): Promise<Found[]> => {
  const found: Found[] = [];
  const visit = async (dir: string, prefix: string): Promise<void> => {
    let names: string[];
    try { names = await fs.readdir(dir); } catch { return; }
    for (const name of [...names].sort()) {
      const absolute = dir === '/' ? `/${name}` : `${dir}/${name}`;
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      if (await isSymlink(fs, absolute)) {
        found.push({ path: rel, kind: 'symlink', size: 0, mtimeMs: 0, target: await fs.readlink!(absolute) });
        continue;
      }
      let stat;
      try { stat = await fs.stat(absolute); } catch { continue; }
      if (stat.isDirectory) {
        if (!skip.has(name)) await visit(absolute, rel);
        continue;
      }
      found.push({ path: rel, kind: 'file', size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  await visit(root, '');
  return found;
};

// FNV-1a over the bytes, tagged with the length. Not cryptographic: it only
// decides whether a file uv handed back needs writing.
const digestOf = (bytes: Uint8Array): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.byteLength; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${bytes.byteLength}:${(hash >>> 0).toString(16)}`;
};
const linkDigest = (target: string): string => `l:${target}`;

/**
 * Where symlinks live when the filesystem cannot hold them (TFS, which backs
 * /home, has none). uv's venvs point bin/python at the interpreter with one,
 * and uv will not recognize the venv without it, so a link Dusk cannot create
 * is recorded here and handed back to uv as a link on the next trip.
 */
export const SYMLINK_MANIFEST = '.dusk-symlinks.json';

const readManifest = async (fs: FSBackend, root: string): Promise<Map<string, string>> => {
  try {
    const parsed = JSON.parse(await fs.readFile(join(root, SYMLINK_MANIFEST))) as Record<string, unknown>;
    return new Map(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return new Map();
  }
};

const signatureOf = (found: readonly Found[]): string =>
  found.map((f) => (f.kind === 'symlink' ? `l ${f.path} ${f.target}` : `f ${f.path} ${f.size} ${f.mtimeMs}`)).join('\n');

/** Fingerprint a Dusk directory without reading any file contents. */
export const signTree = async (fs: FSBackend, root: string, options: CollectOptions = {}): Promise<string> => {
  if (!(await fs.exists(root))) return '';
  return signatureOf(await walk(fs, root, options.skip ?? DEFAULT_SKIP));
};

/** Read a Dusk directory into one buffer plus an offset table. */
export const collectTree = async (fs: FSBackend, root: string, options: CollectOptions = {}): Promise<CollectedTree> => {
  if (!(await fs.exists(root))) return { entries: [], bytes: new Uint8Array(0), signature: '', digests: new Map() };
  const walked = await walk(fs, root, options.skip ?? DEFAULT_SKIP);
  const recorded = await readManifest(fs, root);
  const present = new Set(walked.map((f) => f.path));
  const found: Found[] = [
    ...walked.filter((f) => f.path !== SYMLINK_MANIFEST),
    ...[...recorded].filter(([path]) => !present.has(path))
      .map(([path, target]): Found => ({ path, kind: 'symlink', size: 0, mtimeMs: 0, target })),
  ];
  const limit = options.maxBytes ?? DEFAULT_MAX_TREE_BYTES;
  const declared = found.reduce((sum, f) => sum + f.size, 0);
  if (declared > limit) throw new TreeTooLargeError(root, declared, limit);

  const chunks: Uint8Array[] = [];
  const entries: TreeEntry[] = [];
  const digests = new Map<string, string>();
  let offset = 0;
  for (const f of found) {
    if (f.kind === 'symlink') {
      entries.push({ kind: 'symlink', path: f.path, target: f.target! });
      digests.set(f.path, linkDigest(f.target!));
      continue;
    }
    const contents = await fs.readFileBytes(join(root, f.path));
    digests.set(f.path, digestOf(contents));
    chunks.push(contents);
    entries.push({ kind: 'file', path: f.path, offset, length: contents.byteLength });
    offset += contents.byteLength;
  }
  if (offset > limit) throw new TreeTooLargeError(root, offset, limit);
  const bytes = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return { entries, bytes, signature: signatureOf(walked), digests };
};

const parentOf = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf('/')));

export interface ApplyReport {
  written: number;
  removed: number;
  linked: number;
  /** Digests of the tree as it now stands, for the next `applyTree`. */
  digests: Map<string, string>;
}

/**
 * Make `root` in Dusk's filesystem match `tree`, touching only what differs.
 * `known` maps each relative path the last sync left in place to its digest.
 * A file whose digest is unchanged is not rewritten; a known path missing
 * from `tree` was deleted by uv and is removed here. Paths Dusk never sent
 * (skipped directories, say) are not in `known` and are left alone.
 */
export const applyTree = async (
  fs: FSBackend,
  root: string,
  tree: Tree,
  known: ReadonlyMap<string, string>,
): Promise<ApplyReport> => {
  const report: ApplyReport = { written: 0, removed: 0, linked: 0, digests: new Map() };
  const unrepresentable = new Map<string, string>();
  const madeDirs = new Set<string>();
  const ensureDir = async (dir: string): Promise<void> => {
    if (madeDirs.has(dir)) return;
    if (!(await fs.exists(dir))) await fs.mkdir(dir, { recursive: true });
    madeDirs.add(dir);
  };
  await ensureDir(root);

  for (const entry of tree.entries) {
    if (entry.path.startsWith('/') || entry.path.split('/').some((p) => p === '..' || p === '' || p === '.')) {
      throw new Error(`uv returned ${entry.path}, which does not name a place inside ${root}`);
    }
    const absolute = join(root, entry.path);
    if (entry.kind === 'symlink') {
      const digest = linkDigest(entry.target);
      report.digests.set(entry.path, digest);
      if (!fs.symlink) { unrepresentable.set(entry.path, entry.target); continue; }
      if (known.get(entry.path) === digest && (await isSymlink(fs, absolute))) continue;
      await ensureDir(parentOf(absolute));
      if ((await isSymlink(fs, absolute)) || (await fs.exists(absolute))) await fs.rm(absolute, { recursive: true });
      try {
        await fs.symlink(entry.target, absolute);
        report.linked += 1;
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOSYS') throw error;
        unrepresentable.set(entry.path, entry.target);
      }
      continue;
    }
    const contents = tree.bytes.subarray(entry.offset, entry.offset + entry.length);
    const digest = digestOf(contents);
    report.digests.set(entry.path, digest);
    if (known.get(entry.path) === digest) continue;
    await ensureDir(parentOf(absolute));
    if (await isSymlink(fs, absolute)) {
      await fs.rm(absolute);
    } else if (await fs.exists(absolute)) {
      try { if ((await fs.stat(absolute)).isDirectory) await fs.rm(absolute, { recursive: true }); } catch { /* rewrite below */ }
    }
    await fs.writeFileBytes(absolute, contents.slice());
    report.written += 1;
  }

  const manifest = join(root, SYMLINK_MANIFEST);
  if (unrepresentable.size > 0) {
    const sorted = Object.fromEntries([...unrepresentable].sort(([a], [b]) => a.localeCompare(b)));
    const text = JSON.stringify(sorted, null, 2) + '\n';
    const current = (await fs.exists(manifest)) ? await fs.readFile(manifest).catch(() => '') : '';
    if (current !== text) await fs.writeFile(manifest, text);
  } else if (await fs.exists(manifest)) {
    await fs.rm(manifest);
  }

  // Deepest first, so a directory uv emptied can go after its files.
  const gone = [...known.keys()].filter((path) => !report.digests.has(path)).sort((a, b) => b.length - a.length);
  for (const path of gone) {
    const absolute = join(root, path);
    try {
      if ((await isSymlink(fs, absolute)) || (await fs.exists(absolute))) {
        await fs.rm(absolute, { recursive: true });
        report.removed += 1;
      }
    } catch { /* already gone */ }
    // Drop directories the removal left empty, up to (not including) the root.
    let dir = parentOf(absolute);
    while (dir.length > root.length && dir.startsWith(root)) {
      try {
        if ((await fs.readdir(dir)).length > 0) break;
        await fs.rm(dir);
      } catch { break; }
      dir = parentOf(dir);
    }
  }
  return report;
};
