// TfsFs — adapter that implements just-bash's IFileSystem on top of DuskJS's
// TFS (accessed via the __fs IPC bridge). Writes go straight to TFS, so
// changes made inside dsh persist across process invocations and are visible
// to other binaries that read TFS directly.
//
// Coverage
// - Direct passthrough: readFile, writeFile, readdir, mkdir, rm, exists,
//   stat, mv (rename), appendFile.
// - Synthesized: readdirWithFileTypes (readdir+stat), cp recursive (walk+write),
//   lstat (= stat; TFS has no symlinks), realpath (= resolvePath; ditto),
//   getAllPaths (walk from /, capped).
// - No-op: chmod, utimes (TFS has no permissions and manages mtimes internally).
// - ENOTSUP: symlink, link, readlink.
//
// The strategy prefers "silently degrade" over "hard fail" because typical
// shell workflows call chmod/utimes for side effects we don't model, but
// still expect the surrounding pipeline to keep working.

// @ts-nocheck
import { resolvePath as jbResolvePath } from '../../vendor/just-bash/fs/path-utils';
import { unsafeBytesFromLatin1 } from '../../vendor/just-bash/encoding';
import { fromBuffer, getEncoding, toBuffer } from '../../vendor/just-bash/fs/encoding';

type FsGlobal = {
  readFile: (path: string) => string;
  writeFile: (path: string, data: string) => void;
  readdir: (path: string) => string[];
  mkdir: (path: string, recursive: boolean) => void;
  rm: (path: string, recursive?: boolean) => void;
  exists: (path: string) => boolean;
  stat: (path: string) => { isFile: boolean; isDirectory: boolean; size: number; mtimeMs: number };
  rename: (from: string, to: string) => void;
  appendFile: (path: string, data: string) => void;
  readFileBytes: (path: string) => Uint8Array;
  writeFileBytes: (path: string, data: Uint8Array) => void;
};

const getFs = (): FsGlobal => {
  const fs = (globalThis as Record<string, unknown>)['__fs'] as FsGlobal | undefined;
  if (!fs) throw new Error('__fs not available (dsh must run inside a DuskJS world)');
  return fs;
};

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

export class TfsFs {
  // Ambient TFS root ("/"). Everything is TFS.
  private _statCache = new Map<string, { isFile: boolean; isDirectory: boolean; size?: number }>();

  private fs(): FsGlobal { return getFs(); }

  // --- reads ------------------------------------------------------------
  async readFile(path: string, options?: unknown): Promise<string> {
    return fromBuffer(this.fs().readFileBytes(path), getEncoding(options));
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return this.fs().readFileBytes(path);
  }

  async readFileBytes(path: string): Promise<any> {
    return unsafeBytesFromLatin1(fromBuffer(this.fs().readFileBytes(path), 'latin1'));
  }

  // --- writes -----------------------------------------------------------
  async writeFile(path: string, content: string | Uint8Array, options?: unknown): Promise<void> {
    this.ensureParent(path);
    this.fs().writeFileBytes(path, toBuffer(content, getEncoding(options)));
  }

  // Synchronous variant — just-bash's Bash.registerCommand uses this to
  // create /bin/<name> and /usr/bin/<name> stubs (see Bash.ts:524).
  // Our TFS IPC is fire-and-forget from the engine's perspective, so a
  // synchronous send that ignores the response is close enough for these
  // idempotent-write stubs.
  writeFileSync(path: string, content: string | Uint8Array): void {
    try {
      this.ensureParent(path);
      // Command registration creates generated /bin and /usr/bin stubs. Keep
      // an existing package-manager shim at either path intact.
      if (typeof content === 'string' && content.startsWith('#!/bin/bash\n# Built-in command:') && this.fs().exists(path)) return;
      this.fs().writeFileBytes(path, toBuffer(content));
    } catch { /* ignore, best-effort */ }
  }

  // Auto-mkdir the parent of `path`. Idempotent (mkdir with recursive:true).
  // Needed because register-time stubs land at /bin/<name> and /usr/bin/<name>
  // when neither dir may exist yet.
  private ensureParent(path: string): void {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash <= 0) return; // root or bare filename
    const parent = path.slice(0, lastSlash);
    try {
      if (!this.fs().exists(parent)) this.fs().mkdir(parent, true);
    } catch { /* best-effort */ }
  }

  async appendFile(path: string, content: string | Uint8Array, options?: unknown): Promise<void> {
    const fs = this.fs();
    const addition = toBuffer(content, getEncoding(options));
    const existing = fs.exists(path) ? fs.readFileBytes(path) : new Uint8Array(0);
    this.ensureParent(path);
    fs.writeFileBytes(path, concatBytes(existing, addition));
  }

  // --- metadata / existence --------------------------------------------
  async exists(path: string): Promise<boolean> {
    try { return this.fs().exists(path); } catch { return false; }
  }

  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean; mode: number; size: number; mtime: Date }> {
    const s = this.fs().stat(path);
    // Mode selection: TFS itself has no permission model, so we synthesize
    // POSIX-ish modes from path convention. Files under /bin/ and /usr/bin/
    // are executable (0o755) — they're binary stubs backed by the synthetic
    // /bin layout backend, and just-bash's PATH resolver requires an
    // executable bit to accept a lazy binary that lacks a registered
    // just-bash command handler (see command-resolution.ts:139). Without
    // this, `npm`, `npx`, `dpm`, etc. resolve to file-exists but not
    // executable → "command not found".
    const isBinDir = path === '/bin' || path.startsWith('/bin/') ||
                      path === '/usr/bin' || path.startsWith('/usr/bin/') ||
                      /\/node_modules\/\.bin\/[^/]+$/.test(path);
    const mode = s.isDirectory ? 0o755 : (isBinDir ? 0o755 : 0o644);
    return {
      isFile: !!s.isFile,
      isDirectory: !!s.isDirectory,
      isSymbolicLink: false,
      mode,
      size: s.size,
      mtime: new Date(s.mtimeMs),
    };
  }

  // No symlinks in TFS — lstat mirrors stat.
  async lstat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean; mode: number; size: number; mtime: Date }> {
    return this.stat(path);
  }

  // --- directory ops ---------------------------------------------------
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    // Always pass recursive=true if requested; the underlying IPC honors it.
    // If recursive is false but the parent is missing, let TFS surface the
    // error (matches POSIX mkdir behavior).
    this.fs().mkdir(path, !!options?.recursive);
  }

  async readdir(path: string): Promise<string[]> {
    return this.fs().readdir(path);
  }

  async readdirWithFileTypes(path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }>> {
    const names = this.fs().readdir(path);
    const out: Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }> = [];
    for (const name of names) {
      const child = path === '/' ? '/' + name : path + '/' + name;
      let s: { isFile: boolean; isDirectory: boolean } | undefined;
      try { s = this.fs().stat(child); } catch { /* skip */ }
      out.push({
        name,
        isFile: !!s?.isFile,
        isDirectory: !!s?.isDirectory,
        isSymbolicLink: false,
      });
    }
    return out;
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    try {
      this.fs().rm(path, !!options?.recursive);
    } catch (e) {
      if (options?.force) return;
      throw e;
    }
  }

  // --- copy / move -----------------------------------------------------
  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    const fs = this.fs();
    if (!fs.exists(src)) throw new Error(`cp: no such file or directory: ${src}`);
    const st = fs.stat(src);
    if (st.isDirectory) {
      if (!options?.recursive) throw new Error(`cp: -r not specified; omitting directory '${src}'`);
      fs.mkdir(dest, true);
      const entries = fs.readdir(src);
      for (const name of entries) {
        const s = src === '/' ? '/' + name : src + '/' + name;
        const d = dest === '/' ? '/' + name : dest + '/' + name;
        await this.cp(s, d, options);
      }
    } else {
      fs.writeFileBytes(dest, fs.readFileBytes(src));
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    this.fs().rename(src, dest);
  }

  // --- path arithmetic (pure, no IPC) ---------------------------------
  resolvePath(base: string, path: string): string {
    return jbResolvePath(base, path);
  }

  async realpath(path: string): Promise<string> {
    // No symlinks: canonical path == resolved path. Enforce existence.
    const resolved = jbResolvePath('/', path);
    if (!this.fs().exists(resolved)) throw new Error(`realpath: ${path}: No such file or directory`);
    return resolved;
  }

  // --- attributes (no-op for TFS; commands often set these for effect) --
  async chmod(_path: string, _mode: number): Promise<void> { /* TFS has no permissions */ }
  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> { /* TFS has no mtimes */ }

  // --- symlinks / hardlinks (unsupported) ------------------------------
  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new Error('ENOTSUP: TFS does not support symlinks');
  }
  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new Error('ENOTSUP: TFS does not support hard links');
  }
  async readlink(_path: string): Promise<string> {
    throw new Error('EINVAL: not a symlink');
  }

  // --- glob support: enumerate reachable paths, capped ------------------
  // just-bash calls this to power glob expansion when it can't stat
  // candidates one by one. We do a bounded walk of the whole TFS tree.
  private _pathsCache: string[] | null = null;
  private _pathsCacheAt = 0;
  getAllPaths(): string[] {
    // Cache for 100ms to keep glob-heavy scripts fast; TFS reads still hit IPC.
    const now = Date.now();
    if (this._pathsCache && (now - this._pathsCacheAt) < 100) return this._pathsCache;
    const fs = this.fs();
    const out: string[] = [];
    const seen = new Set<string>();
    const walk = (p: string, depth: number): void => {
      if (depth > 12 || out.length >= 8192 || seen.has(p)) return;
      seen.add(p);
      out.push(p);
      let entries: string[] = [];
      try { entries = fs.readdir(p); } catch { return; }
      for (const name of entries) {
        const child = p === '/' ? '/' + name : p + '/' + name;
        let s: { isFile: boolean; isDirectory: boolean } | undefined;
        try { s = fs.stat(child); } catch { continue; }
        if (!s) continue;
        if (s.isDirectory) walk(child, depth + 1);
        else out.push(child);
        if (out.length >= 8192) return;
      }
    };
    try { walk('/', 0); } catch { /* */ }
    this._pathsCache = out;
    this._pathsCacheAt = now;
    return out;
  }
}
