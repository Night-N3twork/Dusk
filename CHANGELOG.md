# Changelog

## 1.0.1 - Unreleased

### Added

- `bootRepl()` returns `dispose()`, `mount()`, `unmount()`, `exportSnapshot()` and `importSnapshot()`.
- Snapshot helpers: tar/tar.gz export and import for any backend, plus `snapshotToUrl()` and `snapshotFromUrl()` for sharing through a URL fragment.
- Mounts: `createMountBackend()` and `createFileSystemAccessBackend()`, so processes can work in a folder the user picks.
- `startPreview()`, `previewServiceWorkerSource` and `fetchLoopback()` to load guest HTTP servers from the page.
- Sandbox controls: `net.allow` network policies (`createAllowList()`), `net.dns` resolvers (`createDohResolver()`), and `limits` for process count, wall-clock time and output size.
- `ProcessManager.on()`/`off()` for `spawn`, `exit`, `stdout` and `stderr` events, and `ProcessManager.dispose()`.
- dsh: job control (`&`, `jobs`, `fg`, `bg`, `wait`, `kill`, `disown`, `^Z`), `^C` that interrupts the running command, a line editor with history in `~/.dsh_history`, history expansion, and tab completion.
- New commands: `git`, `tsx`, `tar`, `gzip`/`gunzip`/`zcat`, `zip`/`unzip`, `patch`, `less`/`more`, `nano` and `vi`/`vim`.
- Node APIs: `require()` of ES modules, `process.getBuiltinModule()`, `import.meta.dirname`/`filename`, `node:test`, `node:diagnostics_channel`, `node:v8`, `node:sqlite`, and stubs for `node:http2` and `node:dgram`.
- `node:crypto`: a real `scrypt`, `hkdf`, `hash`, `KeyObject`, `createPrivateKey`/`createPublicKey`/`createSecretKey`, JWK import and export, RSA-PSS, ECDSA on P-256/384/521 and secp256k1, Ed25519/Ed448, X25519/X448, ECDH, Diffie-Hellman and `crypto.subtle`.
- `node:fs`: `cp`, `opendir`, `statfs`, `glob`, recursive `readdir`, `fs.promises.watch`, and byte-exact reads and writes.
- `node:dns`: `lookup` and the `resolve*` family over DNS-over-HTTPS, with loopback names answered locally.
- A compatibility manifest that tests check (`test/fixtures/compat.json`) and `scripts/compat-table.mjs`, which renders it into the README.
- CI on every push, a GitHub Pages workflow for the demo, and example programs in `examples/` that are typechecked with the rest of the code.

### Changed

- Worker IPC sends binary frames, so byte payloads no longer go through JSON arrays.
- dsh prints output as each command finishes and waits for stdin that arrives late. Binary data now survives pipes, redirections and `cp`.
- Runtime `dependencies` are now just `@nightnetwork/dpm`, `@nightnetwork/moonbeam` and `@nightnetwork/nova`. Build-time packages moved to `devDependencies`.
- Signals from a PTY reach the whole foreground process group, and `SIGCONT` is delivered to guests.
- `process.exitCode` is honoured when a script ends without calling `process.exit()`.

### Fixed

- `bash -c`, `sh -c`, `env` and `timeout` inside dsh no longer hang.
- `scrypt` returned a PBKDF2 hash; it now implements RFC 7914.
- `dns.lookup` returned the hostname itself instead of an IP address.
- Signal default actions (`SIGTERM`, `SIGINT`) work while a shell command is running.
- The PTY line discipline no longer double-encodes UTF-8 input.
- `rm`, `ls`, `cat`, `mkdir` and `touch` launched from the host now take the same flags as in dsh.
- Duplex streams emit `error` once.
- `wget` writes downloads byte for byte.
- The published package includes `ESBUILD-LICENSE.md`, which `package.json` already listed.

### Removed

- The legacy `/bin/sh.legacy` shell and its source under `src/shell`.
- `setup.sh` and the `libcurl.js` dependency.

## 1.0.0 - 2026-09-20

- Publish the supported DuskJS library API and built `lib/` output.
- Depend on `@nightnetwork/nova` 1.1 for the Nova WASM HTTP client.
- Move SQLite to the separately installed `@nightnetwork/dusk-sqlite` extension.
- Include the Rust/WASM DPM command family and its generated bundles.
- Require host-supplied SSH adapters and assets rather than bundling LunaSSH.
