# DuskJS Handoff — Codebase Guide, Audit Findings, and Roadmap

> **For:** the next session picking up DuskJS/dpm improvements.
> **From:** the memory/CPU-optimization sweep + Node.js compat + dpm audits.
> **Date:** 2026-07-05.
> **Status of tree:** ~12 files modified, uncommitted. Session did not commit (user directive). See "Uncommitted work" section.

---

## 1. What DuskJS is (the 60-second orientation)

DuskJS is a browser-only, MIT-friendly attempt at "Node.js in a tab." It runs JavaScript inside **SpiderMonkey WASI compiled to WebAssembly** in a Web Worker, with a Node-shaped stdlib polyfill (`src/world/`) and a per-Worker synchronous IPC to a host running on the page's main thread. The host owns a **virtual filesystem** (in-memory or persistent via `@terbiumos/tfs` over OPFS), spawns child processes as **new SpiderMonkey Workers**, and provides real network via **libcurl.js** over a wisp/websocket proxy.

**Contrast with WebContainers (StackBlitz):** WebContainers runs user JS in a shared iframe Worker pool — logical process isolation only, single JS realm, ~130 KB gzipped runtime. DuskJS spawns a **fresh SpiderMonkey Worker per process** — true OS isolation, but each Worker costs **~100 MB peak RAM** (see repeated comments at `src/index.ts:34`, `src/demo/page.ts:147`, `src/host/process-manager.ts:390`). This is the single most important architectural fact about DuskJS's efficiency profile. **Full side-by-side comparison in §2.**

**Repo location:** `/home/amplify/Projects/TBNode/DuskJS/`.
**Related repo:** `/home/amplify/Projects/TBNode/dpm/` — the package manager, bundled into DuskJS at `src/host/dpm-bundles/*.js`.

---

## 2. WebContainers vs DuskJS — side-by-side, and why WC is more optimized today

Source for the WebContainers side: the audit at `/home/amplify/Projects/TBNode/docs/audit/webcontainers/*.md` (six deobfuscated-bundle reports) and the observed-architecture reference at `/home/amplify/Projects/TBNode/docs/reference/webcontainers-observed-architecture.md`. Everything below is grounded in that audit; nothing is speculation about what StackBlitz "might" do.

### 2.1 The headline number

|  | WebContainers | DuskJS |
|---|---|---|
| **Initial payload** | 131 KB gz runtime + 88 KB gz fetch-worker + ~2 KB gz shim + ~6 KB gz semver = **~227 KB gz / ~790 KB raw** | Main bundle **1,962 KB raw / 471 KB gz** + world 244 KB + wasi-loader 245 KB + libcurl 1,990 KB (lazy) = **~2.5 MB raw before libcurl** |
| **Per-process JS realm RAM** | Not measured in audit; shared realm so **~0 additional** for logical processes 2..N | **~100 MB per SpiderMonkey Worker × N processes** |
| **SAB footprint per engine** | **4 bytes** (single Int32 rendezvous) | **4 MB SAB** + 4 MB worker decode buffer (grows on demand from 64 KB) |
| **Default worker pool** | `poolSize: 1` — one Worker hosts many processes | No pool; one Worker per spawn |
| **JS engine** | Inferred WASM Node-like (QuickJS or a Node-compiled-to-WASM) — audit couldn't confirm because the executor bundle wasn't audited | SpiderMonkey WASI, fetched from `mozilla-spidermonkey.github.io` |

**Ratio for 5 concurrent processes:** WebContainers ~1 JS realm; DuskJS ~500 MB of SpiderMonkey Workers. **This is the single biggest efficiency gap and it is structural.**

### 2.2 What WebContainers does that DuskJS doesn't

#### 2.2.1 Shared JS realm, logical processes
- **WC:** All user code runs inside the iframe's Web Worker pool. `getProcessFromPool(workerName)` (WC audit `08-process-manager.md:677-685`) implies workers are reused/renamed across process lifetimes. Default pool size 1 (`08-process-manager.md:613-618`) — one Worker hosts every logical process.
- **DuskJS:** Every `pm.spawn` → `new Worker(new URL('../worker/wasi-loader.ts', ...))` → new SM instance → full world.ts eval → binary body eval. See `src/host/engine-instance.ts:22` and `src/host/process-manager.ts:626, 819`.
- **Efficiency delta:** WebContainers pays 1× JS engine + 1× stdlib parse per iframe. DuskJS pays N× everything for N processes. A `for f in *; do grep foo "$f"; done` inside dsh is fine (grep is a just-bash builtin, runs in one engine). The same loop as a shell script driven from `node build.js` shelling out via `child_process.spawnSync('/bin/grep', ...)` is N × 100 MB.

#### 2.2.2 Real transferable buffers, not JSON int-arrays
- **WC:** FS reads/writes use `Comlink.transfer(payload, [payload.buffer])` — **zero-copy ArrayBuffer ownership transfer** (`07-vfs-internals.md:495-519`, `06-rpc-protocol.md:204-209`). The `_0x194421 cloneIntoOwnBuffer` helper slices into a fresh standalone buffer before every transfer.
- **DuskJS:** Byte payloads encoded as **JSON int arrays** — `[137,80,78,71,...]` — see `src/protocol/messages.ts:40-58`. A 1 MB PNG through `fs.readFileBytes` becomes ~4 MB JSON, TextEncoder-encoded to ~4 MB UTF-8, byte-copied through the SAB, JSON.parse'd back to a 1M-element Number array, then `Uint8Array.from`'d. **Four full-size transient allocations per bytes round-trip.**
- **Efficiency delta:** For binary payloads, ~4× IPC bloat and ~3× transient allocations vs WC. WC has no equivalent bloat.

#### 2.2.3 FS batching
- **WC:** `fs.promises.batched.*` accumulates FS calls for **10 ms** and dispatches as one `comlink.multiplePromises([[method, ...args], ...])` (`03-runtime-engine.md:658-663`, `07-vfs-internals.md:299-329`). Explicitly documented as "sweet spot for an interactive directory walk."
- **DuskJS:** Every fs.* call is one SAB round-trip. `ls -l` on 50 entries = 51 round-trips.
- **Efficiency delta:** WC does 1 RPC for a 50-file walk; DuskJS does 51.

#### 2.2.4 Lazy VFS materialization by regex
- **WC:** `addLazyFileHandler(regex, handler)` registers path patterns whose contents are only fetched on first read (`08-process-manager.md:523-529`, `12-wasm-and-execution.md:44-62`). Node itself, npm, WASM binaries — all lazy. Fetch worker downloads on demand.
- **DuskJS:** Binary sources are lazy chunks (this session's work — good). But there is no filesystem-level lazy handler; user files are all eagerly present (or absent) in TFS/memory.
- **Efficiency delta:** Not a big active win today, but WC's pattern would help if we ever wanted to serve big vendor bundles or datasets from a CDN transparently through the FS.

#### 2.2.5 Worker pool with reuse
- **WC:** `getProcessFromPool(workerName)` returns a pooled worker — same Worker can serve multiple `run()` invocations serially. WeakRef tracking of child handles (`08-process-manager.md:99-128`) lets processes get GC'd when the embedder drops the handle.
- **DuskJS:** No pool. `src/host/engine-pool.ts:8-13` literally documents "Future v2 could add real worker pre-spawning."
- **Efficiency delta:** WC starts a process by picking a live idle Worker (~0 ms). DuskJS pays 30-80 ms Worker startup + 150 ms wasm compile (cached after first) + WASI init + full world eval per spawn.

#### 2.2.6 Cross-origin isolation via iframe (bundle caching)
- **WC:** Runtime lives at `stackblitz.com/headless`, loaded from `w-corp-staticblitz.com` (different origin, CDN-cacheable across all embedders). Fetch worker via `initWorker` uses `Blob + importScripts` — origin laundering that lets the JS itself be cached at the CDN origin (`12-wasm-and-execution.md:127-275`).
- **DuskJS:** Everything bundled into the embedder's own origin. Every embedder page has to download DuskJS fresh (no cross-tab CDN cache benefit).
- **Efficiency delta:** WC benefits from browser-level HTTP caching across the entire StackBlitz customer base. Each customer's first load hits their edge cache. DuskJS pays cold-load per deployment.

#### 2.2.7 Two-URL npm strategy: registry proxy + pre-bundled installs
- **WC:** Two fetch endpoints (`00-overview.md:143-151`, `10-package-manager.md:113-138`):
  - `registryProxy` (nr.staticblitz.com) — for single-manifest lookups; credential-hashed URL path.
  - `turboBaseUrl` (t.staticblitz.com/w/v17) — for bulk installs; serves **pre-extracted, per-credential, per-ABI-version package payloads** direct to the FS worker's `linkPackages`. Bypasses the whole tarball → gunzip → untar pipeline.
- **DuskJS/dpm:** Talks directly to `registry.npmjs.org`, downloads full tarballs, gunzip-syncs entire buffer, walks tar entries, writes each file. Concurrency 16, no streaming. Peak ~500 MB burst for a big install (see §8 in this doc).
- **Efficiency delta:** WC's install is orders of magnitude faster and lower-memory because someone else already did the tarball extraction on a build farm. dpm reimplements the whole chain in-browser.

#### 2.2.8 Comlink RELEASE opcode + explicit port lifecycle
- **WC:** MessageChannels are actively closed via `type:5 RELEASE` (`06-rpc-protocol.md:88-89`). WeakRef GC of child handles (§2.2.5). Symbol-keyed private state so `Object.keys` doesn't enumerate credentials.
- **DuskJS:** Uses SAB + Atomics — no MessageChannels for the eval path. But `postMessage` for worldJS transfer still allocates fresh structured clones per spawn (recently mitigated by moving the pid concat to worker side — `src/host/engine-instance.ts:40-48` and `src/worker/wasi-loader.ts:78-82`). No RELEASE-shape lifecycle protocol.
- **Efficiency delta:** Not a big active win for DuskJS today, but WC's discipline about port ownership is worth studying. WC has *documented leaks* — 2 MessageChannel port pairs per `run()` call on public builds (`08-process-manager.md:302-315`). DuskJS's SAB approach avoids that class of leak entirely.

#### 2.2.9 Preload hints in HTML
- **WC:** The headless iframe's HTML has explicit `<link rel="modulepreload">` for `fetch.worker.*.js` and other chunks (`02-headless-bootstrap.md:1-16`).
- **DuskJS:** Vite build emits sensible preload hints but they're not tuned. Nothing that says "you'll need libcurl in ~500 ms, start fetching now."
- **Efficiency delta:** Marginal; a follow-up polish item.

### 2.3 What DuskJS does that WebContainers doesn't (genuine advantages to preserve)

Not everything WC does is better. DuskJS has real wins:

1. **True process isolation.** Each SpiderMonkey Worker is its own memory realm. A guest that trashes globals, hits an infinite loop, or exhausts its heap **cannot corrupt sibling processes**. WC's shared-realm approach means one bad process can leak state, exhaust the shared heap, or hang the whole pool. This is a real correctness/security property, not just architecture aesthetics.

2. **Standardized wasm engine (SpiderMonkey).** Real SM = real Node-compatible edge cases: proper `Number` precision, real TypedArray behavior, `Intl`, real `Atomics`, correct GC semantics. WC's inferred QuickJS-like has smaller footprint but a longer tail of "our engine doesn't quite behave like Node here" bugs. Every DuskJS engine behaves like a real modern JS engine.

3. **Simpler, debuggable RPC.** DuskJS's JSON-over-SAB is trivially debuggable — sniff `/dev/stdout` and you see plain JSON envelopes. WC's Comlink protocol uses numeric opcodes (0=GET, 1=SET, 2=APPLY, 3=CONSTRUCT, 4=ENDPOINT, 5=RELEASE) with no named constants, split across 6 channels with per-callback proxy sub-channels — the audit team spent many hours mapping it.

4. **OPFS-backed persistent FS (via TFS).** Real cross-session persistence with an explicit contract. WC's FS worker isn't in an audited bundle; the audit team could not confirm persistence semantics. DuskJS ships a documented, testable storage model.

5. **No documented leaks of WC's class.** WC has known leaks: 2 MessageChannel port pairs per `run()` on public builds (megabytes/hours), 1 blob URL per boot never revoked, `_build`'s missing `await` that bricks `_boot` on any async rejection with only page-reload as recovery. DuskJS has different failure modes (TFS fd whole-file loads, packument cache never trimmed) but not this class.

6. **MIT-friendly stack.** DuskJS uses standard open engine + tools. WC is closed-source and requires StackBlitz's proprietary CDN infrastructure.

### 2.4 The diff — what DuskJS needs to close the gap

Ordered by impact. Cross-referenced to §6 (optimization roadmap) and §7 (Node compat).

| Gap | WC has | DuskJS needs | See |
|---|---|---|---|
| **Per-process RAM** | Shared realm, ~0 marginal | Optional in-realm spawn for trusted binaries (like `vm.createContext`); real worker pool for the rest | §6.1, new-item-hybrid |
| **Byte payload bloat** | Comlink.transfer zero-copy | Raw-bytes second SAB or transferable-ArrayBuffer path | §6.2 |
| **FS round-trips** | 10 ms batching window | `fs.readdirWithStat` + `fs.statMany` host handlers | §6.4 |
| **npm install throughput** | turboBaseUrl pre-extracted packages | Realistically we can't replicate this (needs a build farm); minimum: platform/os/cpu gating for optionalDependencies, streaming tar+gunzip | §8 dpm story |
| **Bundle size** | 227 KB gz initial | 471 KB gz initial (mostly world + dsh source strings) — moving rare deps out of dsh worldsrc (§6.3) is the biggest remaining lever | §6.3 |
| **Worker pool** | Reused via `getProcessFromPool` | Pre-spawned idle Worker ring + SAB free-list | §6.1 |
| **Lazy file materialization** | `addLazyFileHandler(regex)` | `fs-layout.ts`-style handlers for user paths (e.g. serve big vendor blobs from CDN through the FS) | §6 (not yet listed — new item) |
| **HTML preload hints** | Modulepreload + fetch-worker hint | Tune Vite build to preload libcurl if net is used | §6.9-adjacent |

### 2.5 What we can NEVER match without abandoning core DuskJS goals

- **Bundle size below WC's 227 KB gz.** SpiderMonkey WASI + Node polyfills + dsh + world is fundamentally larger than "a Comlink client + a small runtime that talks to a big proprietary WASM Node." If shipping-size below WC is required, DuskJS would have to abandon SpiderMonkey — probably for QuickJS (per the original TBNode brainstorm at `.superpowers/brainstorm/1205075-1780530093/content/engine-choice.html`), giving up 10-50× compute speed and Node edge-case compat.
- **turboBaseUrl-style installs.** These require server-side per-package build infra. We could offer a similar service, but it's an ops project, not a code change.
- **The shared-realm CPU efficiency for pipelines.** As long as DuskJS spawns real Workers for isolation, `for f in *; grep < f | sort` shell-ed from a node script will always cost more than WC's equivalent. The mitigation is JSH-wrapper elision (already done) plus in-realm spawn (a hybrid Option-C-style path, mentioned in the TBNode brainstorm; not yet implemented in DuskJS) for cases where isolation isn't needed.

### 2.6 Where DuskJS is *already* better than WC

- No `stdoutCb`/`stderrCb` proxy leak on `run()` (WC bug, cited `13-security-isolation.md:751-774`).
- No blob-URL leak per boot (WC bug, `12-wasm-and-execution.md:236-238`).
- No `_build` async-throw bricking bug (WC bug, `13-security-isolation.md:710-749`).
- Real process isolation (structural).
- Real Node edge-case compat via SpiderMonkey (structural).

### 2.7 Summary — why WC is more optimized today, in one sentence

**WebContainers optimized for the common case (many small logical processes, small install footprint, CDN caching across an entire customer base) by making architectural trade-offs — shared realm, custom CDN-backed install infrastructure, opaque WASM engine — that DuskJS explicitly rejected to preserve process isolation, engine standardization, and MIT-friendly independence.** DuskJS's remaining optimization headroom is in the seams (bulk-payload IPC, FS batching, worker pooling) rather than the architecture; matching WC's ceiling requires either giving up isolation (via an opt-in hybrid in-realm spawn path) or infrastructure that WC has and DuskJS doesn't (turboBaseUrl).

---

## 3. Codebase map

### Entry points
- `src/index.ts` — `bootRepl(write, options)`. The public API. Sets up filesystem, process manager, optionally creates a pid-0 SM engine.
- `src/demo/page.ts` — the demo. Uses `bootRepl({ skipPidZero: true })` + spawns `/bin/dsh` interactively.
- `index.html` — mounts the demo.

### Host side (runs in the browser's main JS realm)
- `src/host/process-manager.ts` (~1900 lines) — the beating heart. `spawn`, `spawnSync`, `createPidZero`, `buildEntry`, and *every host IPC handler* (fs, process, crypto, zlib, net, worker, stream, tty, etc.) live here.
- `src/host/engine-instance.ts` — thin wrapper: creates a SpiderMonkey WASM Worker, allocates SharedArrayBuffer, wires up `Atomics.wait/notify`, exposes `run(js)` / `dispatch(js)` / `terminate()`.
- `src/host/engine-pool.ts` — pre-warms the wasm module compile. **No real Worker pooling yet** (see §6.1).
- `src/host/fs-backend.ts` — two backends: `createMemoryBackend()` (in-memory VFS) and `createTfsBackend()` (OPFS-backed via `@terbiumos/tfs`).
- `src/host/fs-layout.ts` — synthetic overlays for `/bin`, `/proc`, `/dev`, `/etc/*`. Materializes binary sources from ProcessManager on demand.
- `src/host/net.ts` — libcurl.js wrapper, `net.fetch`/`net.fetch.sync`, WebSocket, TLS sockets.
- `src/host/sqlite.ts` — sql.js bridge (WASM), exposed as `sqlite.open/exec/close`.
- `src/host/python.ts` — Pyodide bridge (WASM), exposed as `python.exec`.
- `src/host/builtin-binaries.ts` — tiny in-engine JS stubs for `/bin/echo`, `/bin/cat`, etc., and JSH-wrapper generators for grep/sed/awk/etc.
- `src/host/dpm-bundles/*.js` — the compiled dpm CLI, imported via Vite `?raw`.

### Worker side (runs inside each spawned SM engine's Worker)
- `src/worker/wasi-loader.ts` — the Worker entry. Instantiates SM wasm module, sets up `@wasmer/wasi` bindings + `@wasmer/wasmfs`, receives worldJS via postMessage, writes it to WasmFs at `/input.js`, invokes `wasi.start(instance)` (which runs SM against `/input.js`), watches `/dev/stdout` for JSON messages emitted by the SM shell, forwards them to host, receives replies through the SAB and writes back to `/comm` + `/dev/stdin`.
- `src/worker/polys.ts` — Buffer/global/process polyfills for the worker environment itself (not the SM guest).

### World side (runs inside the SM wasm engine — this is what user code sees)
- `src/world/world.ts` — main entry. Installs polyfills (TextEncoder, TextDecoder, WebCrypto), then `installNodeGlobals()`, `installRequire()`, `installESM()`, `installNet()`, then enters the eval loop (`ipc.send({type:'wait'})` → eval `/comm` → send `{type:'done'}`).
- `src/world/node-*.ts` (37 files, 11,106 lines total) — Node stdlib polyfills. Every core module you'd `require('node:X')` lives here. See §5 for the full compatibility matrix.
- `src/world/require.ts` — CJS loader. Wraps `readSource` from host in the `(exports, require, module, __filename, __dirname)` envelope.
- `src/world/esm.ts` — ESM loader. **Regex-based transpile to CJS**. Handles `export` forms but NOT static `import ... from '...'` — significant limitation.
- `src/world/net.ts` — `fetch`, `WebSocket`, `XMLHttpRequest` globals inside the guest.

### Binaries (each bundled as a JS string via `vite-world-source.ts`'s `?worldsrc` plugin)
- `src/binaries/dsh/` — the shell. Wraps `src/vendor/just-bash/` (~95k lines vendored, Apache-2.0). Provides ~90 shell commands (grep, sed, awk, jq, find, tar, gzip, etc.). Has an in-engine Node REPL mode when user types `node` at prompt. Also has custom commands `sqlite3Command` and `python3Command` that shell out to host via IPC.
- `src/binaries/node/` — `/bin/node`. Handles `-e/-p/--version`, file execution (CJS+ESM), and REPL mode via `node:repl`.
- `src/binaries/sqlite3/` — `/bin/sqlite3` peer binary with `.mode/.headers/.tables/.schema` REPL.
- `src/binaries/python3/` — `/bin/python3` peer binary with indent-aware REPL.
- `src/shell/` — the *legacy* shell (kept as `/bin/sh.legacy`). Do not extend; slated for removal once dsh proves stable.

### The IPC protocol (`src/protocol/messages.ts`)
- One SharedArrayBuffer per engine, `SERIAL_RES_SIZE = 4 MB` (was 10 MB).
- Envelope: JSON, UTF-8, `TextEncoder.encode(JSON.stringify(msg))`.
- Sync semantics: guest calls `print(JSON.stringify(msg))` → wasi-loader's `/dev/stdout` watch fires → host runs handler → host writes reply bytes to SAB → `Atomics.notify` → guest resumes.
- Byte payloads: JSON int-array encoding (see `src/protocol/messages.ts:40-58`). **This is a 4× bloat and one of the biggest remaining optimization targets** (§6.2).
- Eval bodies: NEW `JS|<raw-bytes>` fast path skips JSON entirely (see `src/host/engine-instance.ts:60-93` and `src/worker/wasi-loader.ts:118-133`).

---

## 4. Session results — what was done

All work in the current uncommitted diff. **Nothing has been committed on top of `b7f91ad`.**

### Memory optimizations (measured)

| Change | Location | Impact |
|---|---|---|
| `skipPidZero: true` for demos | `src/index.ts:33-42, 118-142`; `src/demo/page.ts:149` | -1 SpiderMonkey Worker (~100 MB idle) — biggest single win |
| Lazy binaries for /bin/{node,sh.legacy,sqlite3,python3,dpm,dpx,npm,npx,pnpm} | `src/host/process-manager.ts:319-367` | -516 KB main bundle idle |
| `SERIAL_RES_SIZE` 10 MB → 4 MB | `src/protocol/messages.ts:38` | -6 MB SAB + -6 MB worker heap per engine |
| Lazy worker `decodeBuffer` (64 KB start, grows on demand to 4 MB) | `src/worker/wasi-loader.ts:8-22` | -4 MB per worker |
| JSH-wrapper elision (rewrites `/bin/grep foo` → `/bin/dsh -c 'grep foo'` before pid alloc) | `src/host/process-manager.ts:394-401`; `src/host/builtin-binaries.ts:43-56` | -1 whole SM Worker per grep/sed/awk/etc. from outside dsh |
| SAB→JS copy uses `Uint8Array.set` instead of per-byte `Atomics.load` loop | `src/worker/wasi-loader.ts:109-119` | ~10-100× faster IPC receive |
| pid concat moved to worker side (was allocating 344 KB per spawn on host) | `src/host/engine-instance.ts:40-48`; `src/worker/wasi-loader.ts:78-82` | -344 KB alloc per spawn |
| Raw JS fast path: eval bodies via `JS|` byte prefix, bypasses JSON wrapping | `src/host/engine-instance.ts:60-93`; `src/worker/wasi-loader.ts:118-133` | -~1 MB transient alloc per dsh spawn; test suite 20% faster |
| Minified `?worldsrc` bundles (esbuild `minifyWhitespace`+`minifySyntax`, ID mangling deliberately off) | `vite-world-source.ts:37-51` | **Main bundle 3.25 MB → 1.96 MB (-40%)**, world source 344 KB → 244 KB (-29%), dsh 194 KB → 107 KB (-45%) |

**Session-total test suite duration:** 155 s → 111 s (~28% faster).

### Bugs fixed
- **`npm`/`npx`/`dpm`/`dpx`/`pnpm` returned "command not found" at dsh prompt** — pre-existing bug, exposed once lazy binaries were introduced. `TfsFs.stat` (`src/binaries/dsh/tfs-fs.ts:132`) always returned `mode: 0o644` for files; just-bash's PATH resolver requires the executable bit. Fixed to return `0o755` for anything under `/bin/` or `/usr/bin/`.

### Infra additions
- `npm run preview` — serves the built `dist/` on port 5173 with **COOP/COEP headers** (required for SharedArrayBuffer). `vite.config.ts` gained `configurePreviewServer` hook + a `preview` block.
- `npm run serve` — build + preview convenience.

### Files modified (all uncommitted)
```
M package.json                        (preview/serve scripts)
M src/binaries/dsh/tfs-fs.ts          (mode 0o755 for /bin, /usr/bin)
M src/demo/page.ts                    (skipPidZero: true)
M src/host/builtin-binaries.ts        (JSH_COMMAND_SET export for elision)
D src/host/dpm-binaries.ts            (dead file removed)
M src/host/engine-instance.ts         (sendEvalRaw fast path, pid split)
M src/host/process-manager.ts         (lazy binaries, JSH elision)
M src/host/tfs-fs.ts                  (not modified this session actually — see tfs-fs.ts above)
M src/index.ts                        (skipPidZero option, sqlite+python wiring)
M src/protocol/messages.ts            (SERIAL_RES_SIZE 4MB)
M src/worker/wasi-loader.ts           (lazy decodeBuffer, Uint8Array.set, JS| fast path)
M vite-world-source.ts                (minifyWhitespace + minifySyntax)
M vite.config.ts                      (configurePreviewServer)
```

**IMPORTANT:** progress notes from earlier session mention commit hashes (`c1433df`, `de90992`, `5244323`, `aab3190`, `60de044`, `4de6ec0`, `c4c6c46`) that do **not** exist in the actual git log. Those appear to be hallucinated. Real HEAD is `b7f91ad python3 + sqlite (Fuck EV)`.

---

## 5. Node.js compatibility — the real numbers

DuskJS's `src/world/` has **37 node stdlib modules totaling 11,106 lines**. Coverage is uneven:

### Production-usable ✅
`buffer` (encoding coverage: utf8/hex/base64/base64url/ascii/binary/latin1/ucs2/utf16le — but missing float/64-bit reads and `indexOf`/`includes`/`swap`), `events` (full EventEmitter), `stream` (Readable/Writable/Duplex/Transform + pipeline), `path` (POSIX only, no `parse`/`format`), `os` (constants correct, `cpus/freemem/loadavg` return placeholders), `assert`, `util` (inspect/format/promisify/types — `styleText`/`getSystemErrorMap` weak), `querystring`, `string_decoder`, `url` (WHATWG + legacy), `console`, `readline`, `perf_hooks`, `dns` (only `lookup` real), `zlib` (buffered — not streaming), `EventEmitter`, most of `process` (argv, env Proxy, cwd, chdir, exit, nextTick, hrtime, signals, uncaughtException), most of sync `fs`.

### Partial ⚠️
`http`/`https` (server OK for HTTP/1.1; client falls back to `fetch` silently when no loopback), `net` (TCP only — no Unix sockets, `Server.address()` returns fake port), `child_process` (spawn/spawnSync/exec/execSync work but **no `fork`, no `stdin.write()` streaming, `ChildProcess` is not an EventEmitter subclass**), `worker_threads` (basic message passing, no transferList semantics), `crypto` (hashes/HMAC/random real; sign/verify via WebCrypto; **`scrypt` is faked via PBKDF2**; cipher doesn't stream), `vm` (`with(sandbox)` — not a security boundary), `fs.watch` (polling only), `fs.createReadStream/WriteStream` (whole-file, not streaming), CJS require works but no `Module.createRequire`.

### Weak / stubbed 🚫
`cluster` (`fork` throws), `zlib` (transforms buffer entire input — can't handle files > SERIAL_RES_SIZE), `child_process.fork` (missing), `process.binding()` (throws), `process.report/dlopen` (absent).

### **Fundamentally broken 💥**
1. **`node:tls`, `node:http2`, `node:dgram`, `node:module` do not exist as files.** Any `require('tls')` fails immediately.
2. **ESM static `import ... from '...'` is NOT transpiled.** `src/world/esm.ts` only rewrites `export` forms and dynamic `import()`. Real ESM `.mjs` source with top-level static imports **cannot be loaded**. This blocks `chalk` v5+, `node-fetch` v3+, any ESM-only package.
3. **Timers are synchronous in the SM shell.** `src/world/world.ts:8-14` — `setTimeout` fires during `drainJobQueue`, `clearTimeout` is a no-op. Any library expecting real delay (rate limiters, debounce, retry backoff) misbehaves.
4. **`process.stdout.isTTY` may be `undefined`** (rather than `false`) on non-TTY output.
5. **No `Response`/`Request`/`Headers`/`Blob`/`File`/`FormData`/`AbortController`** as web globals. The `fetch` returned from `src/world/net.ts:26` is a duck-typed object with `text/json` methods and a Headers-as-Map — not a real Response.

### Ecosystem package confidence
- **High:** `dotenv`, `commander`, `chalk` v4 (CJS), `debug`, most of `typescript` as a lib.
- **Medium:** `express` (HTTP/1.1 server OK, req/res streaming may surprise), `axios`/`node-fetch` v2 (silently degrade to fetch), `fs-extra` (chmod no-ops), `glob` v7 (older), `yargs`.
- **Low:** `undici` (needs real net), `chalk` v5+ (ESM), `glob` v10+ (uses `opendir`/`Dirent`), `chokidar` (needs real `fs.watch`), `esbuild`/`sharp`/anything native.

**See detailed matrix at end of section 4.**

---

## 6. Optimization roadmap — what's next

Ordered by impact-per-effort. Numbers reference the deep audit; extended reasoning in the "Full audit findings" appendix at end.

### Tier 1 — Structural (biggest wins)

#### 6.1 Real worker pooling
- **Location:** `src/host/engine-pool.ts:8-13` — the comment openly says "Future v2 could add real worker pre-spawning if Worker startup cost becomes the bottleneck." That day is here.
- **Approach:** Two sub-changes.
  - **(a) SAB recycling** (easy, safe): Keep a free-list of `(lengthBuffer, valueBuffer)` pairs in engine-pool. Hand out at `createEngine`, return on exit. Saves 4 MB alloc + GC pressure per spawn.
  - **(b) Worker recycling** (harder): Cannot truly reuse a SM engine — WasmFs holds state, world.ts installs global side effects, no reset API. But we can pre-spawn N idle Workers that have already fetched+instantiated wasm (paying the ~150 ms cost once), then hand them out at `spawn` time. The Worker still gets terminated after use; new one pre-warms behind it.
- **Estimated impact:** SAB recycling: -4 MB churn per spawn. Worker pre-spawn: -30-80 ms perceived spawn latency.
- **Risk:** Medium — SAB ownership transitions need careful lifecycle.

#### 6.2 Raw-bytes IPC protocol (kill the 4× JSON int-array bloat)
- **Location:** `src/protocol/messages.ts:40-58` documents the JSON int-array convention. **Every** byte-carrying IPC call pays it: `fs.readFileBytes`, `fs.writeFileBytes`, `proc.readStdin`, `stream.pushChunk` (child→parent stdout), `crypto.*` (hmac/sign/encrypt), `zlib.compress/decompress`, `net.fetch` response bodies. Search all `Array.from(uint8)` / `Uint8Array.from(numArr)` — 53 hits in host, 64 in world.
- **Approach:** Second, dedicated SAB for byte payloads. Envelope stays JSON in the first SAB; if envelope has a `data` slot, it's a length prefix into the byte SAB. Or: length-prefixed inline frames in the same SAB — trickier because the current `/dev/stdout` line-scanner splits on `\n`.
- **Estimated impact:** For binary workloads (`cat` of PNG, `sha256sum` on large file, `gzip` streaming), ~4× reduction in IPC bytes and ~3× reduction in transient allocations. Effective per-call byte payload ceiling lifts from ~1 MB to ~4 MB inside the current 4 MB SERIAL_RES_SIZE.
- **Risk:** Medium-high — protocol change. Migrate in tranches: crypto first (isolated), then fs bytes, then streams.

#### 6.3 Move rare-command deps out of dsh worldsrc
- **Location:** `vite-world-source.ts:22-52` runs esbuild with `bundle: true, format: 'iife'` — no code splitting. So `re2js` (grep/sed/awk), `papaparse`+`yaml`+`ini`+`smol-toml`+`fast-xml-parser` (yq only), `file-type` (file only), `diff` (diff only), `minimatch` (ls only), `sprintf-js` (printf only) **all** get bundled into every dsh spawn's 107 KB source string.
- **Approach:** Move `yq`/`file`/`diff` parsing to host-side IPC (like sqlite3/python3 already do). Or split dsh worldsrc into "core + overlays" fetched on first command use.
- **Estimated impact:** dsh worldsrc could drop from 107 KB to 60-80 KB. Multiplied per live worker.
- **Risk:** Medium — requires plumbing host-side parsers for YAML/CSV/TOML/XML.

### Tier 2 — Tactical

#### 6.4 FS operation batching
- **Location:** `src/binaries/dsh/tfs-fs.ts:172-187` (readdir+stat loops), `src/vendor/just-bash/commands/{ls,grep,find,du,tree}/*.ts` (all do "parallel stat" but serial through the SAB).
- **Approach:** New host func `fs.readdirWithStat(path)` that batches on host side. Also `fs.statMany(paths[])` for glob.
- **Impact:** 20-100× fewer IPC round-trips for directory-heavy commands. `ls -l` on 50 entries: 51 round-trips → 1.
- **Risk:** Low. Additive.

#### 6.5 TFS fd handle path-refcount
- **Location:** `src/host/fs-backend.ts:178-247` — every fd `open` loads whole file into `TfsHandle.contents: Uint8Array`. 100 MB file × N open handles = N×100 MB RAM.
- **Approach:** Cache-with-refcount by path. First open fetches once; subsequent opens share. Writers get copy-on-write.
- **Impact:** Huge for large-file workflows. From O(file × N) to O(file).
- **Risk:** Medium — writeback semantics tricky with shared buffers.

#### 6.6 Transferable worldJS via postMessage
- **Location:** `src/host/engine-instance.ts:78` — `postMessage({ ..., js: worldJS, ... })` currently structured-clones the 244 KB string into the Worker.
- **Approach:** Encode worldJS to `ArrayBuffer` on host, pass in the `transfer` list. Host loses the buffer (allocates fresh next spawn), Worker gets it zero-copy.
- **Impact:** -244 KB × live-workers on host heap.
- **Risk:** Low.

#### 6.7 Zlib streaming
- **Location:** `src/world/node-zlib.ts:72-94` — accumulates chunks, sends whole thing at end. A 100 MB gzip currently throws (exceeds SERIAL_RES_SIZE).
- **Approach:** Host holds a `CompressionStream` open; new IPC funcs `zlib.streamOpen/Write/Close`. Reuse existing StreamRegistry credit mechanism (`src/host/process-manager.ts:1004-1007`).
- **Impact:** Unlocks arbitrary-size zlib. Prereq §6.2 (raw bytes) makes this dramatically better.
- **Risk:** Medium.

### Tier 3 — Small wins

#### 6.8 Lazy `/bin/dsh`
- **Location:** `src/host/process-manager.ts:7` static-imports `dshBinarySource` — 107 KB on the host heap even for consumers that never spawn dsh.
- **Approach:** Convert to `registerLazyBinary` like the others. Demo spawns dsh immediately anyway; users of `bootRepl` as a library who never touch dsh save 107 KB.
- **Impact:** 107 KB deferred. Low but easy.
- **Risk:** Trivial.

#### 6.9 Defer engine prewarm when skipPidZero
- **Location:** `src/index.ts:63-64` unconditionally calls `initEnginePool()`. If `skipPidZero: true` and no spawn yet, this compiles ~20 MB of wasm module for nothing.
- **Approach:** Move prewarm into `createEngine` lazy path. Callers who want it early can call `initEnginePool()` explicitly.
- **Impact:** For idle/late-spawn users, 15-25 MB idle RAM avoided. Demo (spawns immediately) unchanged.
- **Risk:** Low.

#### 6.10 Demo write() O(n²) fix
- **Location:** `src/demo/page.ts:129-132` — `out.textContent += text`. Re-serializes entire DOM node per keystroke.
- **Approach:** `appendChild(createTextNode(text))` + periodic prune of old nodes.
- **Impact:** UX only; noticeable on long sessions.
- **Risk:** Trivial.

#### 6.11 Debounce refreshFsView
- **Location:** `src/demo/page.ts:184` — calls after every command. Walks entire OPFS.
- **Approach:** setTimeout guard, 500 ms debounce.
- **Impact:** UX; big TFS + many commands.
- **Risk:** Trivial.

### Tier 4 — Not viable today

#### 6.12 SM snapshot & restore
Blocked by browser primitives that don't exist. WASI internal state lives outside wasm memory; `WebAssembly.Memory` isn't shareable across instances unless declared shared (SM isn't). Not pursuable without a rearchitecture of world.ts as a lazy installer.

---

## 7. Node.js compat — targeted improvements

### 7.1 ESM real static-import support (highest impact)
- **Location:** `src/world/esm.ts:40-62` — the regex-based transpile handles `export` but not `import ... from '...'`.
- **Approach:** Either (a) actually parse ESM (embed a small ESM→CJS transpiler; sucrase or a hand-rolled parser), or (b) do a proper regex pass for import forms (import default, named, namespace, side-effect, dynamic). Option (b) is riskier for edge cases (multi-line imports, comments containing "import").
- **Impact:** Unlocks ESM-only packages: `chalk` v5+, `node-fetch` v3+, `execa`, modern `nanoid`, most 2023+ npm packages.
- **Risk:** Medium. Parser correctness is fiddly.

### 7.2 Real timer semantics
- **Location:** `src/world/world.ts:8-38` — timer polyfills fire synchronously in `drainJobQueue`.
- **Approach:** Route `setTimeout` through host IPC. Host uses real `setTimeout`, sends `{f:'timer.fired', id}` back. World side keeps callback map.
- **Impact:** Unlocks *anything* that expects real time (retry logic, debouncers, `setImmediate`-based scheduling for cooperative work, health checks). Currently these libraries appear to work but silently produce wrong behavior.
- **Risk:** Medium — timer semantics are surprisingly load-bearing across the ecosystem. Adjust carefully.

### 7.3 `child_process.ChildProcess.stdin.write()` streaming
- **Location:** `src/world/node-child-process.ts:24-35` — `options.stdin` is passed once as bytes at spawn; child has no `stdin` field.
- **Approach:** Expose `child.stdin` as a `Writable` that writes through host IPC to the child's SAB-backed stdin. Host already has stdin buffering (`src/host/process-manager.ts:673-681`).
- **Impact:** Enables pipeline patterns like `child.stdin.write(chunk); child.stdin.end()`. Used by tar streamers, HTTP proxying, interactive prompts.
- **Risk:** Medium.

### 7.4 Missing modules to fill
Priority order:
1. **`node:module`** — needed for `Module.createRequire`, `builtinModules`. Small file, huge unblock (many libs use `createRequire` in ESM to get CJS `require`).
2. **`node:tls`** — even a stub that throws sensibly rather than "module not found" would unblock initial `require` chains.
3. **`node:http2`** — same.
4. **`node:dgram`** — probably OK to stub.

### 7.5 `Response`/`Request`/`Headers` web globals
- **Location:** `src/world/net.ts:26` returns a duck-typed object.
- **Approach:** Implement proper Response/Request/Headers classes (~200 lines). This is what `undici`, `node-fetch` v3+, and many API clients expect.
- **Impact:** High. Any fetch-heavy library becomes usable.
- **Risk:** Medium (Response.body ReadableStream is nontrivial).

### 7.6 `AbortController`/`AbortSignal`
- **Location:** Absent. `timers/promises.setTimeout` at `src/world/node-timers.ts:44` accepts `signal` in signature but ignores it.
- **Approach:** Standard event-emitter shape with `abort()` and `aborted` getter. Wire into fetch, timers, streams.
- **Impact:** Ubiquitous in modern async code.
- **Risk:** Low.

---

## 8. dpm — the whole story

dpm is `/home/amplify/Projects/TBNode/dpm/` — a homegrown npm-shaped package manager. It's bundled into DuskJS at `src/host/dpm-bundles/*.js`. The `npm`/`npx`/`pnpm` bundles are aliases/shims to dpm.

### What works today
- All CLI subcommands defined: `install`/`i`/`add`, `uninstall`/`rm`/`remove`, `run`, `exec`, `list`/`ls`, `init`, `cache`, `config`, `--version`, `--help`.
- Semver: comprehensive, tested (15 tests).
- Resolver + BFS + hoisting + single-path lift (3 tests).
- Content-addressable cache (2 tests).
- Tarball extract (ustar + gzip, sync).
- `package-lock.json` v3 output.
- `pnpm` argv translation shim (subcommand rewrite, then delegate to dpm/dpx).

### What's broken or missing
1. **DuskJS integration: `/bin/dpm --version` times out >120 s.** The one integration test is `test.skip`'d at `DuskJS/test/repl-scenarios.test.ts:157`. Root cause not diagnosed — likely a combination of cold SM Worker spin-up + the ~60 KB dpm bundle pulling in `node:fs`+`node:child_process`+`node:path`+`node:crypto`+`node:zlib` on module init (every one of those is an IPC bridge).
2. **No platform/os/cpu gating of optionalDependencies.** dpm downloads every OS variant of native packages (esbuild, rollup, sharp, etc.). This bloats installs 5-20× and floods TFS.
3. **`chmodSync` is a no-op in DuskJS** (`src/world/node-fs.ts:274`). So `node_modules/.bin/*` shim executability is fragile. The one mitigation is `tfs-fs.ts` synthesizing `0o755` for anything under `/bin/` (this session's fix), but that doesn't help `**/node_modules/.bin/*`.
4. **Symlinks don't work in TFS.** `install.ts:145-149` reads a symlink from a `file:` dep and writes it via `symlinkSync` — `TfsFs` will surface an error which is swallowed by the surrounding `catch { /* */ }`.
5. **Integrity fallback is weak.** `install.ts:206` — if the packument has no `integrity` field, dpm self-computes sha512 from downloaded bytes. Attacker-in-the-middle wins.
6. **Lifecycle scripts run in arbitrary order.** `install.ts:248` — "for a first pass we just iterate."
7. **`dpx` temp installs are never cleaned up.** `/tmp/dpx-<timestamp>` accumulates.
8. **`dpx` runs postinstall on the tempInstall** without `noScripts: true` — supply-chain vector.
9. **`.npmrc`/`.dpmrc` parsing is implemented but not wired.** `dpm/src/commands/config.ts` exists; nothing reads the file into `install`/`registry`.
10. **Peer dependency policy undefined.** Effectively auto-installs like npm 7 but without warnings.
11. **No tests for `install`/`exec`/`run`/`uninstall`/`registry`/`bin-shims`.** Only unit tests for semver, hoist, cache, tarball, lockfile.

### Memory profile during install
- **Every packument stays alive forever** in `packumentCache` (`resolver.ts:165-176`) — never trimmed.
- **Tarballs fully in RAM.** `zlib.gunzipSync` on whole buffer. Concurrency 16 (`install.ts:19`). Worst case: 16 × 20 MB native package tarballs = ~500 MB burst. Combined with the ~100 MB per SM Worker, one big install could 2× the DuskJS heap.
- **No streaming anywhere.** No stream tar parser, no incremental gunzip.

### Path to "full support"
Ordered by impact:
1. **Fix the 120 s startup timeout.** Everything below is blocked on this.
2. **Platform/os/cpu gating.** Reads `os`/`cpu` fields, skips mismatches.
3. **Real symlinks in TFS or CoW-linked node_modules layout.**
4. **Executable bit for `**/node_modules/.bin/*`** — extend `tfs-fs.ts` mode-synthesis.
5. **Enforce integrity.** Refuse installs without proper integrity attestation.
6. **End-to-end DuskJS tests.** Actually install a package inside an engine, verify files exist.
7. **`dpx` temp cleanup + `noScripts` for tempInstalls.**
8. **Lifecycle script topological order.**
9. **Wire `.dpmrc` into install/registry.**
10. **Document peer-dep policy** (pick warn / auto-install / strict).
11. **git/GitHub deps** if any transitive tree needs them.
12. **`workspace:` protocol** if pnpm-shaped monorepos matter.

---

## 9. Landmines and gotchas

Things that will bite you if you don't know:

1. **Progress notes vs git log discrepancy.** Prior-session notes reference commits `c4c6c46`, `60de044` etc. that don't exist. HEAD is `b7f91ad`. Trust `git log`, not narrative.
2. **User directive: no autonomous commits.** Every optimization this session is uncommitted. Ask before committing.
3. **DuskJS requires cross-origin isolation.** COOP `same-origin` + COEP `require-corp` on every response. `vite dev` and `vite preview` both have this via `crossOriginIsolation` plugin. `python -m http.server` will not work.
4. **Tests are flaky at the ~3-test level in full-suite runs.** Same tests pass individually. The known ones are:
   - `test/dsh-interactive.test.ts > prompt appears on boot`
   - `test/repl-via-node.test.ts > 1+1`
   - `test/repl-via-node.test.ts > require(node:os).platform()`
   Baseline is **839-841 pass**. Any drop below that is a real regression.
5. **`SERIAL_RES_SIZE = 4 MB` is a hard ceiling on per-IPC-call payload.** `zlib.gunzipSync(20MB_gzip)` will throw. `readFileBytes` on a > 1 MB file with the JSON int-array bloat will throw. Users hit this without warning.
6. **`TfsFs.stat` returning `0o755` for `/bin/` was the fix for lazy-binary command-not-found.** Don't revert it without adding an alternative signal for "this file is executable" to `command-resolution.ts:139`.
7. **`skipPidZero: true` means `.feed()` throws.** The stub engine at `src/index.ts:126-137` only implements `.terminate()`. Documented, but easy to miss.
8. **`/bin/sh` is aliased to `/bin/dsh`**, not the legacy shell. Legacy shell is at `/bin/sh.legacy`. Some old code expecting `sh` to be the v2 shell will surprise.
9. **`vite-world-source.ts` now minifies.** If you see confusing error messages pointing into minified code, this is why. Identifier mangling is deliberately OFF (`minifyIdentifiers: false`) so stack traces name real functions. Don't turn it on without a source-map plan.
10. **Every spawn is a whole new SpiderMonkey Worker.** `for (const f of files) spawnSync('/bin/grep', ...)` will 100 MB × files RAM peak. Users need to know to run pipelines *inside* dsh (where grep is a builtin) rather than shelling out repeatedly.
11. **`process.env` writes go through IPC.** `env.NEW_VAR = 'x'` is a round-trip call. Loops that set many env vars are surprisingly slow.
12. **`fetch` is not a real Response.** It's `{status, statusText, headers: Map, text(), json()}`. Libraries expecting `Response.body.getReader()` or `Response.clone()` will fail.
13. **The `?worldsrc` Vite plugin runs esbuild fresh per module.** Slow builds start here. Currently ~4 seconds — mostly esbuild on the dsh + world sources.

---

## 10. Recommended next-session ordering

If picking one thing: **fix dpm's 120 s cold-start timeout.** It unblocks dpm, which unblocks real package installs, which unblocks the ecosystem story.

If picking a session-length effort:
1. **§6.2 Raw-bytes IPC protocol** — biggest single perf/RAM improvement remaining.
2. **§6.4 FS batching** — high perceived-speed impact, low risk.
3. **§7.1 ESM static imports** — unblocks the modern npm ecosystem.
4. **§7.2 Real timer semantics** — unblocks correctness for time-dependent libraries.

If picking a "get dpm working end-to-end":
1. Fix the cold-start timeout (whatever it is).
2. Add platform/os/cpu gating.
3. Wire `.dpmrc` config.
4. Add end-to-end test: `dpm install left-pad` from inside a DuskJS engine, assert `node_modules/left-pad/index.js` exists.
5. Extend `tfs-fs.ts` executable-bit synthesis to `**/node_modules/.bin/*`.

---

## 11. Full audit findings — appendix

Three parallel deep audits were run this session. Reports below are edited for brevity but preserve file:line references.

### 10.1 Optimization audit — 13 items

**Ranked by (impact × ease):**

| Rank | Item | Impact | Effort | Risk |
|---|---|---|---|---|
| 1 | Raw-bytes protocol (§6.2) | very high | high | med-high |
| 2 | Rare deps out of dsh worldsrc (§6.3) | high | med | med |
| 3 | FS batching readdirWithStat (§6.4) | high | low | low |
| 4 | TFS handle path-refcount (§6.5) | high for big files | med | med |
| 5 | Zlib streaming (§6.7) | unlocks feature | med | med |
| 6 | Transferable worldJS (§6.6) | 244 KB × workers | low | low |
| 7 | Lazy /bin/dsh (§6.8) | 107 KB deferred | trivial | very low |
| 8 | PostMessage large eval fallback | removes 4 MB cap | med | med |
| 9 | SAB recycling (§6.1a) | modest RAM churn | low | med |
| 10 | Defer prewarm (§6.9) | 15-25 MB idle | trivial | low |
| 11 | Demo textContent+refresh throttle (§6.10-11) | UX only | trivial | trivial |
| 12 | Lazy sqlite/python imports | few KB | trivial | very low |
| 13 | SM snapshot | not viable | very high | very high |

### 10.2 Node.js API compat audit

**37 world modules, 11,106 lines.** Per-module details:

- **`node:fs`**: Sync + async cb + promises + streams (whole-file). Watch is polling. No `opendir`/`Dirent`/`cp` recursive/`glob`. `chmod`/`chown`/`utimes` silent no-ops.
- **`node:child_process`**: `spawn`/`spawnSync`/`exec`/`execFile`/`execSync` present. **No `fork`**. **No `child.stdin.write()`**. `ChildProcess` not an EventEmitter subclass.
- **`node:http`/`https`**: HTTP/1.1 server OK, client silently falls back to `fetch` when no loopback. No HTTP/2. No TLS.
- **`node:net`**: TCP client + server. No Unix sockets. `Server.address()` returns fake port.
- **`node:crypto`**: hashes (MD5/SHA-1 pure JS, SHA-256+ via WebCrypto), HMAC, cipher (AES-CBC/GCM/CTR, buffered not streaming), sign/verify (RSA/ECDSA via WebCrypto), keypair gen. **scrypt is faked via PBKDF2.**
- **`node:stream`**: Full Readable/Writable/Duplex/Transform/pipeline. No web-stream interop.
- **`node:worker_threads`**: Basic Worker + MessagePort + MessageChannel. No transferList.
- **`node:zlib`**: gzip/deflate/inflate/raw variants. **Not streaming** — buffers whole input.
- **`node:events`**: Full EventEmitter.
- **`node:process`**: argv/env/cwd/chdir/exit/nextTick/hrtime/signals/exceptions all work. Env is a Proxy (writes forwarded). `binding()` throws. Memory info partial (only heap fields).
- **`node:buffer`**: Full class + encodings. Missing float/64-bit reads, `indexOf`/`includes`/`swap`.
- **`node:util`**: inspect/format/promisify/callbackify/types. `styleText` returns unstyled. `getSystemErrorMap` empty.
- **`node:path`**: POSIX only. No `parse`/`format`.
- **`node:vm`**: Uses `with(sandbox)`. Not a security boundary.
- **`node:tls`, `node:http2`, `node:dgram`, `node:module`**: **Do not exist as files.**

**Broken:**
- ESM static imports not transpiled (only `export` and dynamic `import()`).
- Timers synchronous (`setTimeout` fires in drain-job-queue).

### 10.3 dpm bundle audit

**All 5 bundles are the same project** (`/home/amplify/Projects/TBNode/dpm/`) with different CLI dispatch.

**Zero end-to-end tests. The one DuskJS integration test is skipped due to 120s timeout.**

Correctness holes:
- No os/cpu gating → downloads every native OS variant.
- Lifecycle scripts run in arbitrary order.
- `dpx` temp installs never cleaned up.
- Integrity fallback accepts self-computed hash — attacker-in-the-middle wins.
- Symlinks don't work in TFS; silently swallowed.
- chmod is no-op in world → `node_modules/.bin/*` executability fragile.
- `.dpmrc` config file exists but isn't wired into installs.

Memory during install:
- 16-way concurrent tarball download + gunzipSync + Uint8Array copy.
- packumentCache never trimmed.
- No streaming anywhere.
- Worst case: hundreds of MB burst per install.

---

## 12. Quick-start commands

```bash
# In DuskJS/:
npm run dev         # dev server on :5173 (with COOP/COEP)
npm run build       # tsc + vite build
npm run preview     # serve dist/ on :5173 (with COOP/COEP)
npm run serve       # build + preview
npm run test        # vitest (browser mode via playwright)
npm run typecheck   # tsc --noEmit

# In dpm/:
npm run test        # vitest — only unit tests, no integration
```

Baseline vitest result: **839-841 pass, 12 skipped, 1 todo, 0-3 flaky failures in `dsh-interactive` and `repl-via-node`**. Anything else is a real regression.

---

## 13. File index (where things live)

```
src/
├─ engine/
│   └─ spidermonkey.ts             # SM wasm module fetch+compile cache
├─ worker/
│   ├─ wasi-loader.ts              # Worker entry; instantiates SM+WASI; watches /dev/stdout
│   └─ polys.ts                    # Buffer/global polyfills for the Worker itself
├─ world/
│   ├─ world.ts                    # Guest entry — polyfills, node globals, eval loop
│   ├─ require.ts                  # CJS loader
│   ├─ esm.ts                      # ESM loader (regex transpile — BROKEN for static imports)
│   ├─ net.ts                      # fetch/WebSocket/XHR globals in guest
│   ├─ node-globals.ts             # console, __fs bridge
│   └─ node-*.ts (37 files)        # each Node stdlib module
├─ host/
│   ├─ process-manager.ts          # THE core. spawn/spawnSync/every IPC handler
│   ├─ engine-instance.ts          # createEngine — Worker + SAB + Atomics
│   ├─ engine-pool.ts              # wasm module cache (no worker pool YET)
│   ├─ fs-backend.ts               # createMemoryBackend + createTfsBackend
│   ├─ fs-layout.ts                # /bin, /proc, /dev, /etc synthetic overlays
│   ├─ net.ts                      # libcurl wrapper
│   ├─ sqlite.ts                   # sql.js bridge
│   ├─ python.ts                   # Pyodide bridge
│   ├─ builtin-binaries.ts         # tiny in-engine stubs; JSH-wrapper generator
│   └─ dpm-bundles/*.js            # dpm CLI, ?raw imports
├─ binaries/
│   ├─ dsh/                        # /bin/dsh (wraps vendor/just-bash)
│   │   ├─ main.ts                 # interactive loop; node REPL hijack
│   │   ├─ tfs-fs.ts               # IFileSystem impl on __fs IPC
│   │   ├─ binary-entry.ts         # ?worldsrc entry
│   │   └─ commands/
│   │       ├─ sqlite3-command.ts  # dsh sqlite3 builtin (host IPC)
│   │       └─ python3-command.ts  # dsh python3 builtin (host IPC)
│   ├─ node/                       # /bin/node
│   ├─ sqlite3/                    # /bin/sqlite3 peer binary
│   └─ python3/                    # /bin/python3 peer binary
├─ shell/                          # LEGACY shell (/bin/sh.legacy) — don't extend
├─ vendor/just-bash/               # vendored just-bash (Apache-2.0, ~95k lines)
├─ protocol/
│   └─ messages.ts                 # SAB size constants + protocol docs
├─ repl/repl.ts                    # startRepl for pid-0 direct-eval
├─ demo/
│   ├─ page.ts                     # main demo entry
│   ├─ scripted.ts                 # ?demo=scripted mode
│   ├─ transcript.ts               # scripted TRANSCRIPT_LINES
│   └─ opfs-view.ts                # walkOpfs/clearOpfs helpers
├─ types/vite-env.d.ts             # ?worldsrc + ?raw + ?url ambient types
└─ index.ts                        # public API — bootRepl

vite.config.ts                     # + crossOriginIsolation, + preview COOP/COEP
vite-world-source.ts               # ?worldsrc plugin — runs esbuild per entry
package.json                       # + preview + serve scripts
test/*.test.ts                     # 63 test files, ~854 tests
```

---

## 14. Contact points for confusion

- **"Where do IPC calls actually happen?"** Guest calls `ipc.send({f:'fs.readFile', ...})` in `src/world/world.ts:239-244`. Bytes flow through print→wasmFs→wasi-loader→postMessage→ProcessManager's `funcs` table.
- **"How does a spawn actually work?"** `src/host/process-manager.ts:626` (`spawn`) → `createEngine` (new Worker) → `buildEntry` (constructs entryJs string = prelude+body+trailer) → `engine.run(entryJs)` → SAB `JS|` fast path → wasi-loader writes to `/comm` → SM eval loop picks it up.
- **"How does dsh call sqlite3?"** dsh registers `sqlite3Command` as a **just-bash custom command** (`src/binaries/dsh/commands/sqlite3-command.ts`). When user types `sqlite3` in dsh, just-bash invokes the command inline — it calls `ipc.send({f:'sqlite.exec', ...})` which routes to `src/host/sqlite.ts` on the host. No new engine spawned.
- **"How does /bin/sqlite3 differ?"** `/bin/sqlite3` is a **peer binary** — a full new SM Worker spawned via ProcessManager, running `src/binaries/sqlite3/main.ts`, which offers a full REPL with `.mode`/`.headers`/`.tables`/`.schema`.
- **"Why is dsh's `node` command different from `/bin/node`?"** dsh intercepts `node` at the shell REPL loop (`src/binaries/dsh/main.ts:310`) and enters an in-engine Node-like REPL using SM's own eval. This is fast (no new Worker) but limited (bare assignments only — `let`/`const`/`function` don't persist). `/bin/node` spawned via `dsh -c 'node script.js'` or `dsh$ /bin/node script.js` is a real new SpiderMonkey Worker.

Good luck. Read the code; the comments are usually honest.
