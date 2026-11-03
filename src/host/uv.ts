// /bin/uv, /bin/pip and /bin/pip3, backed by tholus (uv compiled to wasm).
//
// One uv engine is booted lazily, on the first command, in a worker of its
// own (uv-worker.ts). It fetches ~18 MiB of WebAssembly, so nothing is loaded
// at Dusk boot. uv's download cache lives in OPFS and survives reloads.
//
// uv has its own filesystem inside that worker. Dusk's stays the source of
// truth: before each command the project directory (and $VIRTUAL_ENV, when it
// lies outside the project) is copied into uv's, unless it is unchanged since
// the last trip; afterwards whatever uv changed is copied back. A venv uv
// creates therefore shows up in `ls`, survives in snapshots, and is what
// /bin/python3 mounts (python-env.ts).
//
// Source distributions build through Pyodide: uv's PEP 517 hook requests are
// answered by the same Pyodide /bin/python3 uses.
//
// What uv cannot do here: `uv run` and `uvx` spawn an interpreter, which the
// wasm engine cannot do, so they fail with uv's own message.

import { createEngine, type Engine, type EngineConfigInput, type EngineEndpoint, type ExecOptions } from '@tholus/core';
import { attachPyodide, type PyodideLike, type PyodideRuntime } from '@tholus/pyodide';
// Resolved here, on the main thread, so an app bundling Dusk's library build
// emits them too (see uv-worker.ts). Plain assets: bundling the engine module
// would inline its fallback wasm URL as a second, base64 copy of the wasm.
import engineModuleUrl from '@tholus/core/engine?url&no-inline';
import engineWasmUrl from '@tholus/core/engine.wasm?url&no-inline';
import type { FSBackend } from './fs-backend';
import { targetFromUrl, type NetworkPolicy } from './network-policy';
import type { StreamingHostBinary, StreamingHostBinaryContext } from './process-manager';
import { findVirtualEnv } from './python-env';
import { applyTree, collectTree, DEFAULT_MAX_TREE_BYTES, signTree } from './uv-tree';

export interface UvOptions {
  /** Package indexes; defaults to PyPI. */
  index?: EngineConfigInput['index'];
  /** How uv reaches the network; defaults to the browser's fetch. */
  transport?: EngineConfigInput['transport'];
  /** uv's download cache; defaults to OPFS, scoped to Dusk. */
  cache?: EngineConfigInput['cache'];
  /** Environment every uv command starts from, under the caller's own. */
  env?: Record<string, string>;
  /** Largest project tree handed to uv in one command. Default 512 MiB. */
  maxTreeBytes?: number;
}

export interface UvHostDeps {
  fs: FSBackend;
  /** The Pyodide /bin/python3 uses, loaded on demand for source builds. */
  loadPyodide: () => Promise<PyodideLike>;
  networkPolicy?: NetworkPolicy;
  options?: UvOptions;
  /** Replaces the worker; tests use it to drive a fake engine. */
  createEndpoint?: () => EngineEndpoint | Promise<EngineEndpoint>;
}

export interface UvHost {
  /** /bin/uv */
  uv: StreamingHostBinary;
  /** /bin/pip and /bin/pip3: `pip X` runs `uv pip X`. */
  pip: StreamingHostBinary;
  /** The booted engine, booting it if needed. */
  engine(): Promise<Engine>;
  dispose(): Promise<void>;
}

/**
 * Set by dsh when it runs uv attached to a terminal, as `<cols>x<rows>`.
 * Host binaries see no PTY of their own, so this is how uv learns it may draw
 * colors and progress bars. Never passed on to uv itself.
 */
export const DUSK_TTY_ENV = 'DUSK_TTY';

type TtyConfig = NonNullable<ExecOptions['tty']>;

const encoder = new TextEncoder();

/** Directories whose contents describe a Python project, nearest first. */
const PROJECT_MARKERS = ['pyproject.toml', 'uv.lock', '.venv', 'requirements.txt', 'setup.py', 'setup.cfg'];

const parentOf = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf('/')));
const isWithin = (path: string, root: string): boolean => root === '/' ? true : path === root || path.startsWith(root + '/');

/**
 * The directory to hand uv: the nearest ancestor of `cwd` that looks like a
 * Python project, else `cwd` itself. uv walks up for pyproject.toml and .venv
 * the same way, so a command run from a subdirectory still finds them.
 */
export const projectRootFor = async (fs: FSBackend, cwd: string): Promise<string> => {
  let dir = cwd || '/';
  while (dir !== '/') {
    for (const marker of PROJECT_MARKERS) {
      if (await fs.exists(`${dir}/${marker}`)) return dir;
    }
    dir = parentOf(dir);
  }
  return cwd || '/';
};

export const parseTty = (value: string | undefined): TtyConfig | undefined => {
  const match = /^(\d+)x(\d+)$/.exec(value ?? '');
  if (!match) return undefined;
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  return cols > 0 && rows > 0 ? { cols, rows } : undefined;
};

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) { chunks.push(value); total += value.byteLength; }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
};

// pip's flags that say where to install. Without one of them and without a
// venv, `pip install` creates one rather than failing.
const PIP_TARGET_FLAGS = new Set(['--system', '--target', '-t', '--prefix', '--python', '-p']);

interface Mirror {
  /** Dusk-side signature right after the last sync, so an unchanged tree is not resent. */
  signature: string;
  /** Digest per path as both sides last agreed. */
  digests: Map<string, string>;
}

const workerEndpoint = (policy: NetworkPolicy | undefined): EngineEndpoint => {
  const worker = new Worker(new URL('./uv-worker.ts', import.meta.url), { type: 'module' });
  const setup = {
    type: 'dusk:uv-setup',
    moduleUrl: new URL(engineModuleUrl, location.href).href,
    wasmUrl: new URL(engineWasmUrl, location.href).href,
  };
  if (policy) {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event: MessageEvent<{ id: number; url: string }>) => {
      let allowed = false;
      try { allowed = policy(targetFromUrl(event.data.url)); } catch { allowed = false; }
      channel.port1.postMessage({ id: event.data.id, allowed });
    };
    worker.postMessage({ ...setup, policy: channel.port2 }, [channel.port2]);
  } else {
    worker.postMessage(setup);
  }
  return worker as unknown as EngineEndpoint;
};

export const createUvHost = (deps: UvHostDeps): UvHost => {
  const { fs } = deps;
  const options = deps.options ?? {};
  const maxBytes = options.maxTreeBytes ?? DEFAULT_MAX_TREE_BYTES;
  const mirrors = new Map<string, Mirror>();
  let booting: Promise<Engine> | undefined;
  let detachRuntime: (() => void) | undefined;
  let pyRuntime: Promise<PyodideRuntime> | undefined;
  // Sync, exec and sync-back must not interleave between two commands.
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  };

  const engine = (): Promise<Engine> => {
    booting ??= (async () => {
      // libcurl goes through a relay, not fetch, where the policy check lives.
      if (deps.networkPolicy && options.transport?.kind === 'libcurl') {
        throw new Error('the libcurl transport cannot be held to net.allow; use the platform or fetch transport');
      }
      const config: EngineConfigInput = {
        fs: { kind: 'memory' },
        cache: options.cache ?? { kind: 'opfs', scope: 'dusk' },
        transport: options.transport ?? { kind: 'platform' },
        cwd: '/',
        ...(options.index ? { index: options.index } : {}),
        ...(options.env ? { env: options.env } : {}),
      };
      const created = await createEngine({
        endpoint: deps.createEndpoint ?? (() => workerEndpoint(deps.networkPolicy)),
        config,
      });
      detachRuntime = created.attachRuntime(async (invocation) => {
        pyRuntime ??= deps.loadPyodide().then((py) => attachPyodide(created, py));
        return (await pyRuntime).hook(invocation);
      });
      return created;
    })();
    booting.catch(() => { booting = undefined; });
    return booting;
  };

  const push = async (uv: Engine, root: string): Promise<void> => {
    const known = mirrors.get(root);
    if (known && known.signature === (await signTree(fs, root))) return;
    const tree = await collectTree(fs, root, { maxBytes });
    await uv.importTree(root, { entries: tree.entries, bytes: tree.bytes }, { replace: true });
    mirrors.set(root, { signature: tree.signature, digests: tree.digests });
  };

  const pull = async (uv: Engine, root: string): Promise<void> => {
    const known = mirrors.get(root);
    let exported;
    try { exported = await uv.exportTree(root); } catch { return; }
    const report = await applyTree(fs, root, exported, known?.digests ?? new Map());
    mirrors.set(root, { signature: await signTree(fs, root), digests: report.digests });
  };

  const rootsFor = async (cwd: string, env: Record<string, string>): Promise<string[]> => {
    const project = await projectRootFor(fs, cwd);
    const roots = project === '/' ? [] : [project];
    const venv = env['VIRTUAL_ENV'];
    if (venv && venv !== '/' && !roots.some((root) => isWithin(venv, root))) roots.push(venv);
    return roots;
  };

  const run = async (ctx: StreamingHostBinaryContext, argv: string[], signal: AbortSignal): Promise<number> => {
    const fail = async (message: string): Promise<number> => {
      await ctx.stderr(encoder.encode(`${argv[0] === 'pip' ? 'pip' : 'uv'}: ${message}\n`));
      return 1;
    };
    let uv: Engine;
    try { uv = await engine(); } catch (error) {
      return fail(`could not start the uv engine: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (signal.aborted) return 130;

    const env: Record<string, string> = { ...ctx.env };
    const tty = parseTty(env[DUSK_TTY_ENV]);
    delete env[DUSK_TTY_ENV];
    // Read standard input only when uv was told to (`-r -`, `-c -`): a caller
    // that never closes stdin would otherwise hang every command.
    const stdin = !tty && ctx.args.includes('-') ? await readAll(ctx.stdin) : undefined;

    return serialize(async () => {
      if (!(await fs.exists(ctx.cwd))) return fail(`${ctx.cwd}: no such directory`);
      let roots: string[];
      try {
        roots = await rootsFor(ctx.cwd, env);
        for (const root of roots) await push(uv, root);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
      try {
        const handle = uv.exec(argv, {
          cwd: ctx.cwd,
          env,
          signal,
          stdout: (chunk) => { void ctx.stdout(chunk); },
          stderr: (chunk) => { void ctx.stderr(chunk); },
          ...(tty ? { tty } : {}),
          ...(stdin ? { stdin } : {}),
        });
        const result = await handle.exit;
        return result.code;
      } finally {
        // Bring back what uv changed even when the command failed part-way.
        for (const root of roots) {
          try { await pull(uv, root); } catch (error) {
            await ctx.stderr(encoder.encode(`uv: could not copy ${root} back: ${error instanceof Error ? error.message : String(error)}\n`));
          }
        }
      }
    });
  };

  const binary = (argvFor: (ctx: StreamingHostBinaryContext) => Promise<string[] | number>): StreamingHostBinary => (ctx) => {
    const abort = new AbortController();
    const exit = (async () => {
      const argv = await argvFor(ctx);
      if (typeof argv === 'number') return argv;
      return run(ctx, argv, abort.signal);
    })().catch(async (error: unknown) => {
      await ctx.stderr(encoder.encode(`uv: ${error instanceof Error ? error.message : String(error)}\n`));
      return 1;
    });
    return { exit, kill: () => abort.abort() };
  };

  const uv = binary(async (ctx) => ctx.args);

  const pip = binary(async (ctx) => {
    const args = ctx.args;
    if (args[0] === '--version' || args[0] === '-V') return ['pip', '--version'];
    if (args[0] === 'install' && !args.some((arg) => PIP_TARGET_FLAGS.has(arg.split('=')[0]!))
      && !(await findVirtualEnv(fs, ctx.cwd, ctx.env))) {
      const project = await projectRootFor(fs, ctx.cwd);
      const venv = `${project === '/' ? '' : project}/.venv`;
      await ctx.stderr(encoder.encode(`pip: no virtual environment found; creating ${venv}\n`));
      const created = await run({ ...ctx, args: ['venv', venv] }, ['venv', '--quiet', venv], new AbortController().signal);
      if (created !== 0) return created;
      return ['pip', ...args, '--python', `${venv}/bin/python`];
    }
    return ['pip', ...args];
  });

  return {
    uv,
    pip,
    engine,
    async dispose() {
      detachRuntime?.();
      const running = booting;
      booting = undefined;
      if (running) await (await running.catch(() => undefined))?.dispose();
    },
  };
};
