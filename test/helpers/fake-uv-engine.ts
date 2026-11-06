// A stand-in for tholus's wasm engine, driven through tholus's real
// createEngineWorker over an in-process endpoint. Everything between Dusk and
// the engine (protocol, importTree/exportTree, cancellation) is the real
// code; only uv itself is faked, with just enough commands to observe what
// Dusk sends and what it copies back.

import { createEngineWorker, type EngineEndpoint, type EngineExports, type EngineHandle } from '@tholus/core';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Node = { kind: 'file'; bytes: Uint8Array } | { kind: 'symlink'; target: string };

export interface Invocation {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string | undefined;
  tty: { cols: number; rows: number } | undefined;
}

export class FakeUv implements EngineHandle {
  readonly nodes = new Map<string, Node>();
  readonly folders = new Set<string>(['/']);
  readonly invocations: Invocation[] = [];
  private cwd = '/';
  private env: Record<string, string> = {};
  private stdin: Uint8Array | undefined;
  private tty: { cols: number; rows: number } | undefined;
  private release: ((code: number) => void) | undefined;

  private ancestors(path: string): void {
    const parts = path.split('/');
    for (let i = parts.length - 1; i > 1; i--) this.folders.add(parts.slice(0, i).join('/'));
    this.folders.add('/');
  }

  // --- uv ---------------------------------------------------------------

  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number> {
    const call: Invocation = {
      argv: argv.slice(1),
      cwd: this.cwd,
      env: { ...this.env },
      stdin: this.stdin ? decoder.decode(this.stdin) : undefined,
      tty: this.tty,
    };
    this.invocations.push(call);
    const out = (text: string): void => onOutput('stdout', encoder.encode(text));
    const err = (text: string): void => onOutput('stderr', encoder.encode(text));
    const [command, ...rest] = call.argv;
    const abs = (path: string): string => {
      const parts: string[] = [];
      for (const part of (path.startsWith('/') ? path : `${this.cwd}/${path}`).split('/')) {
        if (part === '..') parts.pop();
        else if (part && part !== '.') parts.push(part);
      }
      return `/${parts.join('/')}`;
    };
    const venvFrom = (args: string[]): string | undefined => {
      const python = args.indexOf('--python');
      if (python !== -1) return args[python + 1]!.replace(/\/bin\/python$/, '');
      if (call.env['VIRTUAL_ENV']) return call.env['VIRTUAL_ENV'];
      let dir = this.cwd;
      while (true) {
        const candidate = `${dir === '/' ? '' : dir}/.venv`;
        if (this.nodes.has(`${candidate}/pyvenv.cfg`)) return candidate;
        if (dir === '/') return undefined;
        dir = dir.slice(0, Math.max(1, dir.lastIndexOf('/')));
      }
    };
    switch (command) {
      case 'echo':
        out(JSON.stringify(call) + '\n');
        return Promise.resolve(0);
      case 'cat': {
        const node = this.nodes.get(abs(rest[0]!));
        if (node?.kind !== 'file') { err(`cat: ${rest[0]}: not found\n`); return Promise.resolve(2); }
        out(decoder.decode(node.bytes));
        return Promise.resolve(0);
      }
      case 'venv': {
        const target = abs(rest.filter((arg) => !arg.startsWith('-'))[0] ?? '.venv');
        this.fsWrite(`${target}/pyvenv.cfg`, encoder.encode('home = /bin\n'));
        this.fsMkdirp(`${target}/lib/python3.14/site-packages`);
        this.fsSymlink('/bin/python3', `${target}/bin/python`);
        return Promise.resolve(0);
      }
      case 'pip': {
        const [sub, ...args] = rest;
        if (sub === '--version') { out('uv-pip (fake)\n'); return Promise.resolve(0); }
        const venv = venvFrom(args);
        if (!venv) { err('error: No virtual environment found\n'); return Promise.resolve(2); }
        const site = `${venv}/lib/python3.14/site-packages`;
        const names = args.filter((arg, i) => !arg.startsWith('-') && args[i - 1] !== '--python');
        if (sub === 'install') {
          for (const name of names) this.fsWrite(`${site}/${name}/__init__.py`, encoder.encode(`__version__ = "1.0"\n`));
          err(`Installed ${names.length} package${names.length === 1 ? '' : 's'}\n`);
          return Promise.resolve(0);
        }
        if (sub === 'uninstall') {
          for (const name of names) this.fsRemoveDir(`${site}/${name}`);
          return Promise.resolve(0);
        }
        return Promise.resolve(2);
      }
      case 'fail-after-write':
        this.fsWrite(abs('partial.txt'), encoder.encode('half'));
        err('boom\n');
        return Promise.resolve(1);
      case 'wait':
        return new Promise((resolve) => { this.release = resolve; });
      default:
        err(`fake uv: unknown command ${command}\n`);
        return Promise.resolve(2);
    }
  }

  setTermSize(cols: number, rows: number): void { this.tty = { cols, rows }; }
  clearTerm(): void { this.tty = undefined; }
  isRunning(): boolean { return this.release !== undefined; }
  envReplace(entries: string[]): void {
    // The worker flattens the environment to [key, value, key, value, ...].
    this.env = {};
    for (let i = 0; i + 1 < entries.length; i += 2) this.env[entries[i]!] = entries[i + 1]!;
  }
  cancel(): boolean {
    const release = this.release;
    this.release = undefined;
    release?.(130);
    return release !== undefined;
  }
  setCwd(path: string): void {
    if (!this.folders.has(path)) throw new Error(`${path}: no such directory`);
    this.cwd = path;
  }
  setStdin(bytes: Uint8Array): void { this.stdin = bytes; }
  clearStdin(): void { this.stdin = undefined; }

  // --- filesystem -------------------------------------------------------

  fsRead(path: string): Uint8Array {
    const node = this.nodes.get(path);
    if (node?.kind !== 'file') throw new Error(`${path} was not found`);
    return node.bytes;
  }
  fsWrite(path: string, contents: Uint8Array): void {
    this.ancestors(path);
    this.nodes.set(path, { kind: 'file', bytes: contents.slice() });
  }
  fsReadDir(path: string): string[] {
    const prefix = path === '/' ? '/' : `${path}/`;
    const names = new Set<string>();
    for (const known of [...this.nodes.keys(), ...this.folders]) {
      if (known !== path && known.startsWith(prefix)) {
        const head = known.slice(prefix.length).split('/')[0];
        if (head) names.add(head);
      }
    }
    return [...names].sort();
  }
  fsKind(path: string): string | undefined {
    const node = this.nodes.get(path);
    if (node) return node.kind;
    return this.folders.has(path) ? 'directory' : undefined;
  }
  fsSize(path: string): number {
    const node = this.nodes.get(path);
    return node?.kind === 'file' ? node.bytes.byteLength : 0;
  }
  fsReadLink(path: string): string {
    const node = this.nodes.get(path);
    if (node?.kind !== 'symlink') throw new Error(`${path} is not a symbolic link`);
    return node.target;
  }
  fsSymlink(target: string, link: string): void {
    this.ancestors(link);
    this.nodes.set(link, { kind: 'symlink', target });
  }
  fsMkdirp(path: string): void {
    this.ancestors(`${path}/x`);
  }
  fsRemove(path: string): void {
    if (!this.nodes.delete(path)) throw new Error(`${path} was not found`);
  }
  fsRemoveDir(path: string): void {
    const prefix = `${path}/`;
    for (const known of [...this.nodes.keys()]) if (known.startsWith(prefix)) this.nodes.delete(known);
    for (const known of [...this.folders]) if (known === path || known.startsWith(prefix)) this.folders.delete(known);
  }

  attachRuntime(): void { /* source builds are not exercised by the fake */ }
  detachRuntime(): void { /* nothing attached */ }
  hasRuntime(): boolean { return false; }

  text(path: string): string | undefined {
    const node = this.nodes.get(path);
    return node?.kind === 'file' ? decoder.decode(node.bytes) : undefined;
  }
}

/** The protocol version tholus's SDK and worker agree on. */
const PROTOCOL_VERSION = '0';

export const fakeUvEndpoint = (): { endpoint: () => EngineEndpoint; engines: FakeUv[] } => {
  const engines: FakeUv[] = [];
  const exports = {
    default: async () => undefined,
    version: () => 'tholus 0.0.0 (uv 0.0.0)',
    buildInfo: () => JSON.stringify({ engine: '0.0.0', uv: '0.0.0', protocol: PROTOCOL_VERSION }),
    Engine: class extends FakeUv {
      constructor() {
        super();
        engines.push(this);
      }
    },
  } as unknown as EngineExports;

  const endpoint = (): EngineEndpoint => {
    const listeners = new Set<(event: { data: unknown }) => void>();
    const worker = createEngineWorker({
      load: async () => exports,
      // Asynchronous delivery, as a real worker's postMessage would be.
      emit: (message) => { queueMicrotask(() => { for (const listener of listeners) listener({ data: message }); }); },
      lock: (_name, run) => run(),
    });
    return {
      postMessage: (message) => { queueMicrotask(() => worker.receive(message)); },
      addEventListener: (_type, listener) => { listeners.add(listener); },
      removeEventListener: (_type, listener) => { listeners.delete(listener); },
      terminate: () => { listeners.clear(); },
    };
  };
  return { endpoint, engines };
};
