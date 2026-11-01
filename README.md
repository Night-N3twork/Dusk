# @nightnetwork/dusk — DuskJS

**Node.js in a browser tab.** A browser-hosted JavaScript runtime with Node.js-compatible APIs.

DuskJS runs native JavaScript inside Web Workers by default, with SpiderMonkey WASI available only through `runtime: 'spidermonkey-legacy'`. It provides familiar `node:*` modules, a POSIX shell, Python via Pyodide, persistent storage, and networking through browser-supported transports and optional relays.

## Features

- JavaScript runs in native Web Workers, one per process. SpiderMonkey WASI is still there behind `runtime: 'spidermonkey-legacy'`.
- Most Node core modules work: `node:fs`, `node:http`, `node:net`, `node:crypto`, `node:child_process`, `node:dns`, `node:test`, `node:worker_threads` and others. The [compatibility table](#nodejs-compatibility) has the details.
- `require()` loads ES modules the way Node 22 does, and `import.meta.dirname`, `import.meta.filename` and `process.getBuiltinModule()` are available.
- The shell, dsh, has pipes, redirects and functions. It also has job control (`&`, `jobs`, `fg`, `bg`, `kill`, `wait`, `^Z`, `^C`), line editing, history that survives a reload, and tab completion.
- Alongside `grep`, `sed`, `awk`, `jq`, `find` and about 90 other commands, the shell ships `git`, `tsx`, `tar`, `gzip`, `zip`/`unzip`, `diff`/`patch`, `less`, `nano` and `vi`.
- `/bin/node` is an interactive REPL, and `python3` runs on Pyodide.
- Files live in the Origin Private File System, so they're still there after a reload. You can also mount a folder from the user's disk.
- A directory tree can be exported as `.tar.gz`, imported elsewhere, or shared as a URL.
- A Service Worker can route browser requests to an `http.createServer()` running inside Dusk, which means a dev server can load in an iframe.
- Hosts can restrict network access with an allowlist and cap process count, run time and output size.
- PTYs have a line discipline with echo, raw mode, `^C`/`^D`/`^Z` and `SIGWINCH`.
- Engine pool warm-up (`initEnginePool`) only matters for `spidermonkey-legacy`. Native workers start on demand.
- `dpm` (also reachable as `dpx`, `npm`, `npx` and `pnpm`) installs verified registry, HTTPS tarball, local tarball and workspace packages.
- Outbound networking goes through Nova, a Rust/WASM HTTP client over Wisp, or the MoonBeam relay.
- `@nightnetwork/dusk-sqlite` adds `/bin/sqlite3` and `node:sqlite`.

## Installation

```bash
npm install @nightnetwork/dusk
```

The published package is tested as a Vite browser consumer. Serve the app in a cross-origin-isolated context (COOP/COEP) so Dusk can use `SharedArrayBuffer` for worker IPC:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The library build is not bundler-agnostic: bare esbuild requires a custom worker/asset pipeline to emit and serve Dusk's worker scripts and WASM assets, plus handling for Pyodide's `node:*` imports. Bare esbuild is not supported out of the box.

## Quick Start

```ts
import { bootRepl } from '@nightnetwork/dusk';

const repl = await bootRepl((text) => console.log(text));

// Evaluate JavaScript
await repl.feed('console.log("Hello from DuskJS!")');

// Access the process manager to spawn shell commands
const sh = await repl.processManager.spawn('/bin/dsh', ['-c', 'echo hello | sed s/hello/world/']);

// Clean up every process, socket and worker
await repl.dispose();
```

### Spawn an interactive shell (browser)

```ts
import { bootRepl } from '@nightnetwork/dusk';

const repl = await bootRepl(write, {
  skipPidZero: true, // saves ~100MB RAM
});

const sh = await repl.processManager.spawn('/bin/dsh', [], {
  cwd: '/home/user',
  env: { HOME: '/home/user', PATH: '/bin', TERM: 'xterm-256color', USER: 'user' },
  pty: { cols: 80, rows: 24 },
});

// Wire PTY master to your terminal UI
sh.master.onMasterData((bytes) => terminal.write(bytes));

// Send user input
await sh.stdin.write(new TextEncoder().encode('ls /bin\n'));
```

### SQLite extension

SQLite is intentionally not part of the base Dusk bundle. In the Dusk project, install it with `dpm install @nightnetwork/dusk-sqlite`; after the install completes, restart Dusk and activate the host package explicitly:

```ts
import { bootRepl } from '@nightnetwork/dusk';
import { createSqliteExtension } from '@nightnetwork/dusk-sqlite';

await bootRepl(write, {
  extensionCwd: '/project',
  extensions: [createSqliteExtension()],
});
```

The activation checks the installed package's versioned `dusk.extension` capability manifest and its DPM lockfile integrity before registering `/bin/sqlite3` and `sqlite.*` IPC functions. Restarting is required; installed package files are never executed by Dusk directly.

## API Reference

### `bootRepl(write, options?): Promise<BootReplResult>`

The main entry point. Boots the runtime, initializes the filesystem, and optionally creates a pid-0 REPL engine.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `write` | `(text: string) => void` | Callback for stdout/stderr output |
| `options` | `BootReplOptions` | Optional configuration |

**`BootReplOptions`:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `net` | `BootReplNetOptions` | `undefined` | Networking: a Nova/libcurl loader and Wisp proxy, a relay, or a TCP provider. Also takes `dns` and `allow` (see [Sandbox controls](#sandbox-controls)). |
| `runtime` | `'native' \| 'spidermonkey-legacy'` | `'native'` | Engine used for every process |
| `seed` | `Record<string, string>` | `{}` | Files to write before anything starts |
| `fs` | `'tfs' \| 'memory'` | `'tfs'` | `tfs` persists in OPFS; `memory` is thrown away with the page |
| `user` | `string` | `'user'` | Username for the environment |
| `hostname` | `string` | `'duskjs'` | Hostname for the environment |
| `layout` | `boolean` | `true` | Use the layered layout (`/bin`, `/proc`, `/dev`, persistent home, ephemeral `/tmp`) |
| `via` | `'startRepl' \| 'node'` | `'startRepl'` | Where `feed()` sends input: the pid-0 engine or a spawned `/bin/node` |
| `skipPidZero` | `boolean` | `false` | Don't create the pid-0 engine. Saves about 100 MB when you only spawn processes. |
| `limits` | `ProcessLimits` | `undefined` | `maxProcesses`, `timeoutMs` and `maxOutputBytes` for every process |
| `ssh` | `SshOptions` | `undefined` | Host-supplied SSH adapter, host-key policy and LunaSSH WASM URLs |
| `extensions` | `DuskExtensionHost[]` | `[]` | Host extensions to activate from packages installed by DPM |
| `extensionCwd` | `string` | `/home/<user>` | Project whose DPM lockfile authorizes those extensions |
| `nativePackageReplacements` | `NativePackageReplacementEntries` | `undefined` | Browser builds to use in place of native-only packages |

### SSH Adapter

Dusk does not bundle LunaSSH or its WASM assets. The host supplies an adapter and both asset URLs explicitly:

```ts
import { bootRepl } from '@nightnetwork/dusk';
import { createDuskSshAdapter } from '@nightnetwork/lunassh/dusk';

await bootRepl(write, {
  net: { relay },
  ssh: {
    adapter: createDuskSshAdapter(),
    hostKeyVerification: { knownHosts: ['host ssh-ed25519 AAAA...'] },
    wasm: {
      wasmPath: '/assets/lunassh.wasm',
      wasmExecPath: '/assets/wasm_exec.js',
    },
  },
});
```

Use `{ insecureSkipHostKeyVerification: true }` only when an explicit insecure opt-out is intended.

**`BootReplResult`:**

| Property | Type | Description |
|----------|------|-------------|
| `feed` | `(line: string) => Promise<void>` | Send a line of input to the REPL |
| `processManager` | `ProcessManager` | Spawn and manage processes |
| `engine` | `EngineInstance` | The pid-0 engine (a stub with `skipPidZero`) |
| `node` | `DuskProcessHandle?` | The `/bin/node` child when `via: 'node'` |
| `tcpProvider` | `TcpProvider?` | The configured raw/TLS TCP provider |
| `mount(path, target)` | `void` | Mount an `FSBackend` or a `FileSystemDirectoryHandle` at `path` |
| `unmount(path)` | `boolean` | Remove a mount |
| `exportSnapshot(options?)` | `Promise<Uint8Array>` | Archive a directory tree as tar (gzip by default) |
| `importSnapshot(data, options?)` | `Promise<string[]>` | Extract a tar or tar.gz archive and return the written paths |
| `registerWispTransport(name, factory)` | `void` | Register an extra Wisp transport with Nova |
| `dispose()` | `Promise<void>` | Stop every process and release workers, sockets and watchers |

### `ProcessManager`

Manages the process tree, binary registry, and inter-process communication.

**Key methods:**

| Method | Description |
|--------|-------------|
| `spawn(cmd, args?, options?)` | Start a process and return a `DuskProcessHandle` |
| `spawnSync(cmd, args?, options?)` | Run a process to completion and return its output |
| `getProcess(pid)` | Get a process handle by PID |
| `activePids()` | List the running PIDs |
| `listBinaries()` | List every registered binary |
| `resizePty(pid, cols, rows)` | Resize a process's PTY |
| `on(event, listener)` / `off(event, listener)` | Listen for `spawn`, `exit`, `stdout` and `stderr`. `on` returns an unsubscribe function. |
| `connectLoopback(port, host?)` | Open a raw connection to a server listening inside Dusk |
| `dispose()` | Kill every process and release host resources |

**`SpawnOptions`:**

| Option | Type | Description |
|--------|------|-------------|
| `args` | `string[]` | Command arguments |
| `env` | `Record<string, string>` | Environment variables |
| `cwd` | `string` | Working directory |
| `stdin` | `Uint8Array \| string` | Initial stdin data |
| `pty` | `boolean \| { cols?, rows? }` | Attach a pseudo-terminal |

**`DuskProcessHandle`:**

| Property | Type | Description |
|----------|------|-------------|
| `pid` | `number` | Process ID |
| `exit` | `Promise<number>` | Resolves with the exit code |
| `stdin` | `ProcessStdinWriter` | Write to the process stdin (`.write()`, `.close()`) |
| `stdout` | `ReadableStream<Uint8Array>` | Process stdout |
| `stderr` | `ReadableStream<Uint8Array>` | Process stderr |
| `kill()` | `void` | Terminate the process |
| `master` | `Pty?` | PTY master (present if spawned with `pty`) |

### Other Exports

| Export | Description |
|--------|-------------|
| `createEngine` | Create a standalone native worker engine |
| `createRunner` | Low-level engine runner |
| `startRepl` | Create a REPL on an existing engine |
| `createMemoryBackend` | In-memory filesystem backend |
| `createTfsBackend` | Persistent TFS/OPFS backend |
| `createLayoutBackend` | The layered filesystem used by `bootRepl` |
| `createMountBackend` | Wrap a backend so other backends can be mounted on top of it |
| `createFileSystemAccessBackend` | Back a mount with a `FileSystemDirectoryHandle` |
| `exportSnapshot` / `importSnapshot` | Archive or restore any `FSBackend` |
| `snapshotToUrl` / `snapshotFromUrl` | Put an archive in a URL fragment and read it back |
| `startPreview` / `previewServiceWorkerSource` | Serve guest HTTP servers to the page through a Service Worker |
| `fetchLoopback` | Make one HTTP request to a guest server without a Service Worker |
| `createAllowList` | Build a network policy from host patterns |
| `createDohResolver` | DNS-over-HTTPS resolver for `node:dns` |
| `initEnginePool` / `isPoolWarm` | Pre-compile SpiderMonkey WASI for the legacy runtime |
| `prewarmEngine` | Pre-compile the legacy SpiderMonkey binary |

## Sandbox controls

Workers keep guest code off the main thread. What that code can reach over the network, and how long it can run, is up to you.

```ts
import { bootRepl, createDohResolver } from '@nightnetwork/dusk';

const repl = await bootRepl(write, {
  net: {
    loadLibcurl,
    proxyUrl: 'wss://your-wisp-proxy/wisp/',
    dns: createDohResolver('https://cloudflare-dns.com/dns-query'),
    allow: ['https://registry.npmjs.org', '*.example.com:443'],
  },
  limits: { maxProcesses: 16, timeoutMs: 60_000, maxOutputBytes: 8 << 20 },
});

repl.processManager.on('exit', ({ pid, code, signal }) => console.log(pid, signal ?? code));
```

- `allow` takes host patterns (`*.example.com`), optional ports (`:443`) and optional schemes (`https://`), or a function that receives `{ protocol, host, port }`. Blocked requests fail with `ERR_DUSK_NETWORK_BLOCKED`. The policy covers `fetch`, `node:http`/`https`, `node:net`, `node:tls`, WebSockets and DPM downloads.
- `limits.maxProcesses` makes `spawn` fail with `EAGAIN` once the limit is reached. `timeoutMs` sends `SIGKILL` when it runs out. `maxOutputBytes` stops a process with `SIGXFSZ` when it writes too much.
- There's no memory limit, because browsers don't let a page cap a single worker's memory. `limits` and `dispose()` are the tools you have for runaway code.

## Previewing servers

`startPreview` lets the page load an HTTP server that runs inside Dusk. First serve `previewServiceWorkerSource` as a same-origin file, for example `/dusk-preview-sw.js`:

```ts
import { startPreview } from '@nightnetwork/dusk';

const preview = await startPreview(repl.processManager, { serviceWorkerUrl: '/dusk-preview-sw.js' });
iframe.src = preview.url(3000, '/'); // http.createServer().listen(3000) inside Dusk
```

The Service Worker adds COEP/CORP headers, so previews load inside a cross-origin-isolated page. For a one-off request you can skip the Service Worker and call `fetchLoopback(pm, port, request)`.

## Snapshots and mounts

```ts
const archive = await repl.exportSnapshot({ root: '/home/user/project' });
const link = snapshotToUrl(archive); // #dusk-snapshot=... fragment, never sent to a server

const restored = snapshotFromUrl(location.href);
if (restored) await repl.importSnapshot(restored, { root: '/home/user/project' });

const folder = await window.showDirectoryPicker();
repl.mount('/mnt/project', folder); // processes now read and write the user's folder
```

Archives are gzipped POSIX tar with PAX headers for long names, so plain `tar -xzf` can open them. An import never writes outside its `root`.

## Shell Commands (dsh)

`dsh` is the default shell. It parses and runs bash syntax using a vendored copy of just-bash.

| Category | Commands |
|----------|----------|
| **Builtins** | `cd`, `export`, `unset`, `set`, `alias`, `source`, `eval`, `exit`, `read`, `test`, `type`, `history`, `jobs`, `fg`, `bg`, `wait`, `kill`, `disown` |
| **Files** | `ls`, `cat`, `head`, `tail`, `cp`, `mv`, `rm`, `mkdir`, `rmdir`, `touch`, `chmod`, `stat`, `find`, `ln`, `readlink`, `tree`, `du` |
| **Text** | `grep`, `rg`, `sed`, `awk`, `sort`, `uniq`, `wc`, `cut`, `tr`, `tee`, `xargs`, `diff`, `patch`, `column`, `comm`, `join`, `paste` |
| **Archives** | `tar`, `gzip`, `gunzip`, `zcat`, `zip`, `unzip` |
| **Data** | `jq`, `yq`, `base64`, `md5sum`, `od`, `strings` |
| **Interactive** | `less`, `more`, `nano`, `vi`/`vim` |
| **Development** | `git`, `node`, `tsx`, `python3`, `curl`, `wget` |
| **Packages** | `dpm`, `dpx`, `npm`, `npx`, `pnpm` |

It handles pipes, redirects, here-docs, functions, arrays, `$(...)`, `&&`/`||` and background jobs.

At an interactive prompt you get:

- Arrow keys, `^A`/`^E`, `^W`/`^U`/`^K`, `^L` and reverse search with `^R`.
- History stored in `~/.dsh_history`, plus `!!`, `!$`, `!n` and `!prefix` expansion.
- Tab completion for commands, paths and `$VARIABLES`.
- `^C` to interrupt the running command and `^Z` to stop a job.
- `jobs`, `fg`, `bg`, `kill %n` and `wait`. Background jobs run as separate processes.

`git` is built on isomorphic-git. It covers `init`, `clone`, `status`, `add`, `rm`, `commit`, `log`, `show`, `diff`, `branch`, `checkout`, `switch`, `restore`, `reset`, `merge`, `stash`, `tag`, `remote`, `fetch`, `pull`, `push`, `config` and `rev-parse`. Set `GIT_TOKEN` (or `GIT_USERNAME`/`GIT_PASSWORD`) to push. `tsx` bundles TypeScript with the worker's esbuild-wasm and runs it, including top-level `await`.

## Node.js Compatibility

This table comes from `test/fixtures/compat.json`. `test/compat.test.ts` checks every listed export against the running runtime, and `node scripts/compat-table.mjs` regenerates the table.

| Module | Status | Notes |
|--------|--------|-------|
| `node:assert` | Supported | Includes `assert/strict` |
| `node:async_hooks` | Partial | `AsyncLocalStorage` follows synchronous scope and awaited `run()` callbacks; `createHook` is inert |
| `node:buffer` | Supported |  |
| `node:child_process` | Supported | Children are Dusk processes |
| `node:cluster` | Stub | Always reports the primary; workers cannot be forked |
| `node:console` | Supported |  |
| `node:crypto` | Supported | RSA, RSA-PSS, ECDSA (P-256/384/521, secp256k1), Ed25519/448, X25519/448, ECDH, DH, KeyObject, JWK |
| `node:dgram` | Stub | UDP is unavailable in browsers; sockets emit `EAFNOSUPPORT` |
| `node:diagnostics_channel` | Supported |  |
| `node:dns` | Supported | Resolves loopback hosts locally and everything else through a configurable DNS-over-HTTPS resolver |
| `node:events` | Supported |  |
| `node:fs` | Supported | Byte-exact reads and writes, `cp`, `opendir`, `statfs`, `glob`, `watch` and `fs.promises.watch` |
| `node:http` | Supported | Servers are reachable through loopback and the Service Worker preview |
| `node:http2` | Stub | Constants are real; sessions throw `ERR_HTTP2_UNSUPPORTED` |
| `node:https` | Supported |  |
| `node:module` | Supported |  |
| `node:net` | Supported | Outbound TCP needs a Wisp transport or relay |
| `node:os` | Supported |  |
| `node:path` | Supported |  |
| `node:perf_hooks` | Supported |  |
| `node:process` | Supported |  |
| `node:querystring` | Supported |  |
| `node:readline` | Supported |  |
| `node:repl` | Supported |  |
| `node:sqlite` | Partial | Needs the `@nightnetwork/dusk-sqlite` extension |
| `node:stream` | Supported |  |
| `node:string_decoder` | Supported |  |
| `node:test` | Supported | Reports in TAP |
| `node:timers` | Supported |  |
| `node:tls` | Partial | Client connections through the TLS transport; no TLS servers outside the relay |
| `node:tty` | Supported |  |
| `node:url` | Supported |  |
| `node:util` | Supported |  |
| `node:v8` | Partial | `serialize` uses a Dusk format; heap snapshots are unavailable |
| `node:vm` | Partial | Contexts share the worker's realm |
| `node:worker_threads` | Supported | Workers are Dusk processes |
| `node:zlib` | Supported | gzip, deflate and deflate-raw through `CompressionStream`; no brotli |

## Networking

DuskJS supports outbound HTTP/HTTPS and TCP via two mechanisms:

### Nova (libcurl replacement)

Nova is a Rust-based WASM module that provides `fetch`-style HTTP via a Wisp WebSocket proxy:

```ts
import * as nova from '@nightnetwork/nova';

const repl = await bootRepl(write, {
  net: {
    loadLibcurl: async () => {
      await nova.default();
      return new nova.LibCurl();
    },
    proxyUrl: 'wss://your-wisp-proxy/wisp/',
  },
});
```

### MoonBeam Relay

For TCP-level networking (e.g., `node:net` servers that accept inbound connections), provide a `RelayListener`:

```ts
const repl = await bootRepl(write, {
  net: {
    relay: myRelayListener, // implements RelayListener interface
  },
});
```

**`RelayListener` interface:**

```ts
interface RelayListener {
  registerListener(host: string, port: number, handler: (socket: RelaySocket) => void): () => void;
}

interface RelaySocket {
  onData(cb: (data: Uint8Array) => void): () => void;
  onClose(cb: (reason: number) => void): () => void;
  send(data: Uint8Array): void;
  close(reason?: number): void;
}
```

### Loopback

`node:http` servers listening on `dusk.local` (or any host registered via the socket registry) are accessible to other processes within the same runtime via loopback — no relay or proxy needed.

## File System

DuskJS provides a layered virtual filesystem:

- **TFS (Terbium File System)** — persistent storage backed by the browser's Origin Private File System (OPFS). Files written here survive page reloads.
- **Memory backend** — ephemeral in-memory FS for scratch data.
- **Layout backend** — combines both: persistent storage for `/home`, `/etc`, and user data; ephemeral storage for `/tmp`, `/proc`, and transient state.

```ts
// Persistent (default)
const repl = await bootRepl(write, { fs: 'tfs' });

// Ephemeral
const repl = await bootRepl(write, { fs: 'memory' });
```

Seed files at boot:

```ts
const repl = await bootRepl(write, {
  seed: {
    '/home/user/hello.js': 'console.log("hello");',
    '/etc/motd': 'Welcome to DuskJS',
  },
});
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                Browser Main Thread               │
│  ┌───────────────────────────────────────────┐   │
│  │            ProcessManager                 │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐     │   │
│  │  │ pid 0   │ │ pid 1   │ │ pid 2   │ ... │   │
│  │  │(engine) │ │ /bin/dsh│ │/bin/node│     │   │
│  │  └────┬────┘ └────┬────┘ └────┬────┘     │   │
│  │       │           │           │           │   │
│  │       ▼           ▼           ▼           │   │
│  │  ┌─────────────────────────────────────┐  │   │
│  │  │     Native JavaScript Workers       │  │   │
│  │  │  (one Web Worker per engine)        │  │   │
│  │  └─────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────┘   │
│  ┌──────────┐ ┌──────────┐ ┌─────────────────┐   │
│  │ FS Layer │ │ Net/IPC  │ │ PTY / Signals   │   │
│  │ TFS/OPFS │ │ Nova/WS  │ │ Line discipline │   │
│  └──────────┘ └──────────┘ └─────────────────┘   │
└─────────────────────────────────────────────────┘
```

- JavaScript engines run in native Web Workers by default; `spidermonkey-legacy` selects SpiderMonkey WASI workers instead
- The `ProcessManager` on the main thread orchestrates IPC, I/O routing, signal delivery, and lifecycle
- World-side shims (`node-fs.ts`, `node-net.ts`, `node-http.ts`, etc.) run inside each engine and communicate with the host via synchronous IPC (`ipc.send`)
- The engine pool pre-compiles SpiderMonkey WASI only for the legacy runtime; native workers start on demand

## Browser Requirements

- **Cross-origin-isolated context** — required for `SharedArrayBuffer` and synchronous IPC between workers and the main thread (both runtimes)
- Set these response headers on your server:
  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  ```
- Modern browser with Web Workers, OPFS and the Web Locks API (both required for the persistent TFS backend), and `CompressionStream`/`DecompressionStream` (for zlib). Use `{ fs: 'memory' }` when origin-wide persistent locking is unavailable.

## Building from Source

```bash
git clone https://github.com/Night-N3twork/Dusk.git
cd Dusk
npm install

npm run dev          # demo shell with HMR at http://localhost:5173
npm run build        # typecheck and build the demo into dist/
npm run build:lib    # build the npm package into lib/
npm run typecheck    # type checking only
```

Set `DUSK_ALLOWED_HOSTS` (comma-separated) to let other hostnames reach the dev server, and `DUSK_BASE` to build the demo for a sub-path. The demo deploys to GitHub Pages from `.github/workflows/pages.yml`. Pages can't send COOP/COEP headers, so the demo registers `public/coi-sw.js` to add them.

## Examples

[`examples/`](examples) holds a few short programs. They're part of `npm run typecheck`, so they stay in sync with the API.

- [`terminal.ts`](examples/terminal.ts) attaches an interactive shell to an xterm-style terminal.
- [`preview-server.ts`](examples/preview-server.ts) runs `http.createServer` in Dusk and shows it in an iframe.
- [`snapshots.ts`](examples/snapshots.ts) shares a project as a URL and mounts a local folder.
- [`sandbox.ts`](examples/sandbox.ts) runs untrusted code with a network allowlist, DNS and limits.

## Testing

```bash
npm test             # source-boundary check, then vitest in Chromium via Playwright
```

Tests run in Chromium through `@vitest/browser-playwright`, which gives them `SharedArrayBuffer`, OPFS and Service Workers. The Python and engine-pool tests download assets, so they fail without network access.

## Contributing

Contributions are welcome. Please ensure `npm run typecheck` and `npm test` pass before submitting changes.

## License

Apache-2.0
