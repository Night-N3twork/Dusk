import { bootRepl } from '../index';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TRANSCRIPT_SEED } from './transcript';
import { walkOpfs, clearOpfs } from './opfs-view';
import type { LibCurl } from '../host/net';

const loadRealLibcurl = async (): Promise<LibCurl> => {
  const nova = await import('@nightnetwork/nova');
  await nova.default(); // wasm-bindgen init — loads the WASM binary
  return new nova.LibCurl() as unknown as LibCurl;
};

// Example commands the user can click to try. All run inside dsh (backed by
// the vendored just-bash), which gives us grep/sed/awk/jq/find/sort/etc. plus
// a POSIX-ish shell parser with pipelines, redirects, and variables.
const SHELL_EXAMPLES: string[] = [
  // The absolute basics — should always work.
  'echo hello world',
  'ls /bin',
  'pwd',
  'whoami',
  'cat /etc/hostname',
  // Text-processing pipeline
  'printf "apple\\nbanana\\ncherry\\n" | sort',
  'printf "a\\nb\\na\\nc\\nb\\n" | sort | uniq -c',
  'echo hello world | sed s/world/dusk/',
  'echo one two three | awk "{print \\$2}"',
  // grep
  'grep root /etc/passwd',
  // JSON via jq
  'printf \'{"name":"dusk","tags":["shell","node"]}\' | jq .tags',
  // find + xargs style
  'ls /bin | head -5',
  // Filesystem round-trip
  'echo hello > /tmp/greet && cat /tmp/greet',
  // JS execution via -c
  'js-exec -c "console.log(2 + 2)"',
  // Enter node REPL (interactive) — from here the Node REPL example buttons work.
  'node',
];

// Examples for the interactive node REPL (invoked after typing `node`).
// Each line is sent as one REPL input. Variables assigned in one snippet
// persist into the next (the REPL keeps a shared context).
const NODE_EXAMPLES: string[] = [
  // Basic value evaluation
  '2 + 2',
  'Math.sqrt(144)',
  "'hello ' + 'dusk'",
  // Variable that survives across lines (bare assignment — const/let/var
  // scope to the eval frame and don't persist; see main.ts for details).
  'greeting = "hi from repl"',
  'greeting.toUpperCase()',
  // Node globals — engine-provided
  'process.version',
  "require('node:os').platform()",
  "require('node:path').join('/tmp', 'demo.txt')",
  // Async / await at top level
  'await Promise.resolve(42)',
  // Objects and arrays get pretty-printed
  '({ name: "dusk", tags: ["shell", "node"], count: 3 })',
  '[1, 2, 3].map(x => x * x)',
  // Filesystem via node stdlib — sees TFS through DuskJS's __fs bridge
  "require('node:fs').readFileSync('/etc/hostname', 'utf8')",
  // Multi-line via trailing backslash. Use assignment (persists), not
  // `function fib(...)` (would scope to the eval frame).
  'fib = (n) => n < 2 ? n : fib(n - 1) + fib(n - 2)',
  'fib(10)',
  // Meta: reset context, then exit back to dsh
  '.clear',
  '.exit',
];

// node:crypto examples for the Node REPL. Run `node` first to enter the
// REPL, then click these. Each entry is a single line — the DuskJS node
// REPL persists BARE assignments across lines (e.g. `x = 1`) but NOT
// `const`/`let`/`function`, so every declaration below is a bare assign
// on top of `globalThis`. Semicolons chain steps within a single click.
//
// Coverage matches the node:crypto compatibility surface documented in
// src/world/node-crypto.ts:
//   - Hashes MD5/SHA-1/SHA-256/SHA-512 (SHA-2 via host WebCrypto IPC)
//   - HMAC (all sha variants)
//   - PBKDF2 sync + async (host IPC)
//   - AES-256-CBC, AES-128-CTR, AES-256-GCM round-trips
//   - RSA-2048 keypair gen + sign/verify (real WebCrypto; ~2-5s to gen)
//   - EC P-256 keypair + ECDSA sign/verify
//   - randomBytes / randomUUID / randomInt / timingSafeEqual
//   - webcrypto passthrough
// Deliberately excluded: scrypt (faked via PBKDF2 in DuskJS —
// output != Node), createSecretKey/KeyObject (absent), ECDH,
// publicEncrypt/privateDecrypt (see node-crypto.ts).
const CRYPTO_EXAMPLES: string[] = [
  // ─── Randomness ────────────────────────────────────────────────
  "require('crypto').randomBytes(16).toString('hex')",
  "require('crypto').randomUUID()",
  "require('crypto').randomInt(1, 100)",
  "c = require('crypto'); Array.from({length: 5}, () => c.randomInt(0, 10))",
  // ─── Hashing ───────────────────────────────────────────────────
  "require('crypto').createHash('md5').update('hello').digest('hex')",
  "require('crypto').createHash('sha1').update('hello world').digest('hex')",
  "require('crypto').createHash('sha256').update('the quick brown fox').digest('hex')",
  "require('crypto').createHash('sha512').update('duskjs').digest('base64')",
  "h = require('crypto').createHash('sha256'); h.update('one'); h.update('two'); h.update('three'); h.digest('hex')",
  "c = require('crypto'); s = 'password123'; ({md5: c.createHash('md5').update(s).digest('hex'), sha1: c.createHash('sha1').update(s).digest('hex'), sha256: c.createHash('sha256').update(s).digest('hex')})",
  // ─── HMAC ──────────────────────────────────────────────────────
  "require('crypto').createHmac('sha256', 'secret-key').update('message').digest('hex')",
  "require('crypto').createHmac('sha512', 'k').update('m').digest('base64')",
  "c = require('crypto'); key = 'shhh'; msg = 'attack at dawn'; sig1 = c.createHmac('sha256', key).update(msg).digest('hex'); check = c.createHmac('sha256', key).update(msg).digest('hex'); ({sig1, check, ok: sig1 === check})",
  // ─── Timing-safe compare ───────────────────────────────────────
  "c = require('crypto'); c.timingSafeEqual(Buffer.from('secret'), Buffer.from('secret'))",
  "c = require('crypto'); c.timingSafeEqual(Buffer.from('abc'), Buffer.from('abd'))",
  // ─── PBKDF2 (host IPC) ─────────────────────────────────────────
  "require('crypto').pbkdf2Sync('mypassword', 'salt', 1000, 32, 'sha256').toString('hex')",
  "require('crypto').pbkdf2('pw', 'salt-value', 10000, 64, 'sha512', (e, k) => console.log(k.toString('hex')))",
  "require('crypto').pbkdf2Sync('correct horse battery staple', 'unique-salt', 100000, 32, 'sha256').toString('hex')",
  // ─── AES-256-CBC round-trip ────────────────────────────────────
  "c = require('crypto'); cbcKey = c.randomBytes(32); cbcIv = c.randomBytes(16); cbcCipher = c.createCipheriv('aes-256-cbc', cbcKey, cbcIv); cbcEnc = Buffer.concat([cbcCipher.update('hello world', 'utf8'), cbcCipher.final()]); cbcDec = c.createDecipheriv('aes-256-cbc', cbcKey, cbcIv); cbcOut = Buffer.concat([cbcDec.update(cbcEnc), cbcDec.final()]).toString('utf8'); ({encHex: cbcEnc.toString('hex'), plain: cbcOut})",
  // ─── AES-128-CTR round-trip ────────────────────────────────────
  "c = require('crypto'); ctrKey = c.randomBytes(16); ctrIv = c.randomBytes(16); ctrE = c.createCipheriv('aes-128-ctr', ctrKey, ctrIv); ctrCt = Buffer.concat([ctrE.update('streaming data'), ctrE.final()]); ctrD = c.createDecipheriv('aes-128-ctr', ctrKey, ctrIv); Buffer.concat([ctrD.update(ctrCt), ctrD.final()]).toString()",
  // ─── AES-256-GCM (authenticated) ───────────────────────────────
  "c = require('crypto'); gcmKey = c.randomBytes(32); gcmIv = c.randomBytes(12); gcmCipher = c.createCipheriv('aes-256-gcm', gcmKey, gcmIv); gcmCt = Buffer.concat([gcmCipher.update('sensitive'), gcmCipher.final()]); gcmTag = gcmCipher.getAuthTag(); gcmDec = c.createDecipheriv('aes-256-gcm', gcmKey, gcmIv); gcmDec.setAuthTag(gcmTag); Buffer.concat([gcmDec.update(gcmCt), gcmDec.final()]).toString()",
  // ─── RSA-2048 keypair + sign/verify (real WebCrypto — ~2-5s) ───
  "kp = require('crypto').generateKeyPairSync('rsa', {modulusLength: 2048, publicKeyEncoding: {type:'spki',format:'pem'}, privateKeyEncoding: {type:'pkcs8',format:'pem'}}); kp.publicKey.slice(0, 80)",
  "rsaSig = require('crypto').createSign('sha256').update('important message').sign(kp.privateKey); rsaSig.toString('base64').slice(0, 60) + '...'",
  "require('crypto').createVerify('sha256').update('important message').verify(kp.publicKey, rsaSig)",
  "require('crypto').createVerify('sha256').update('important message TAMPERED').verify(kp.publicKey, rsaSig)",
  // ─── EC P-256 keypair + ECDSA sign/verify ──────────────────────
  "ec = require('crypto').generateKeyPairSync('ec', {namedCurve: 'P-256', publicKeyEncoding: {type:'spki',format:'pem'}, privateKeyEncoding: {type:'pkcs8',format:'pem'}}); ec.publicKey.slice(0, 80)",
  "ecSig = require('crypto').createSign('sha256').update('signed with EC').sign(ec.privateKey); require('crypto').createVerify('sha256').update('signed with EC').verify(ec.publicKey, ecSig)",
  // ─── Discovery ─────────────────────────────────────────────────
  "require('crypto').getHashes()",
  "require('crypto').getCiphers()",
  // ─── WebCrypto passthrough ─────────────────────────────────────
  "w = require('crypto').webcrypto; w.getRandomValues(new Uint8Array(8))",
  "w = require('crypto').webcrypto; wcBuf = await w.subtle.digest('SHA-256', new TextEncoder().encode('hi')); Buffer.from(wcBuf).toString('hex')",
  // ─── Encrypted vault (2-step; click in order) ──────────────────
  // Step 1: encrypt into `stored`
  "c = require('crypto'); vPw = 'user-master-password'; vSalt = c.randomBytes(16); vIv = c.randomBytes(12); vKey = c.pbkdf2Sync(vPw, vSalt, 100000, 32, 'sha256'); vCipher = c.createCipheriv('aes-256-gcm', vKey, vIv); vCt = Buffer.concat([vCipher.update('my-github-token-abc123', 'utf8'), vCipher.final()]); vTag = vCipher.getAuthTag(); stored = { salt: vSalt.toString('base64'), iv: vIv.toString('base64'), ct: vCt.toString('base64'), tag: vTag.toString('base64') }; stored",
  // Step 2: decrypt using the `stored` bundle from step 1
  "c = require('crypto'); dSalt = Buffer.from(stored.salt, 'base64'); dIv = Buffer.from(stored.iv, 'base64'); dTag = Buffer.from(stored.tag, 'base64'); dKey = c.pbkdf2Sync('user-master-password', dSalt, 100000, 32, 'sha256'); dDec = c.createDecipheriv('aes-256-gcm', dKey, dIv); dDec.setAuthTag(dTag); Buffer.concat([dDec.update(Buffer.from(stored.ct, 'base64')), dDec.final()]).toString('utf8')",
];

// python3 (dsh built-in via Pyodide on the host). First call downloads
// Pyodide from CDN (~10MB) and stalls for a few seconds — subsequent calls
// are fast because the interpreter is cached.
const PYTHON_EXAMPLES: string[] = [
  // Simplest
  'python3 -c "print(2 + 2)"',
  // Version
  'python3 --version',
  // sys module
  'python3 -c "import sys; print(sys.version_info)"',
  // stdlib usage
  'python3 -c "import math; print(math.pi, math.sqrt(2))"',
  // JSON + list comprehension
  'python3 -c "import json; print(json.dumps([x*x for x in range(6)]))"',
  // Read TFS-seeded file via Pyodide's node:fs bridge — wait, no: Python
  // sees Pyodide's own FS, not DuskJS TFS. Show the equivalent via -c:
  'python3 -c "print(\'\\n\'.join(str(n) for n in range(5)))"',
  // Multi-statement via inline exec
  'python3 -c "d = {\'a\':1,\'b\':2}; print(sum(d.values()))"',
  // Read a script FROM TFS: seed one with dsh, then run it
  'echo "print(\'from tfs\')" > /tmp/hi.py && python3 /tmp/hi.py',
  // Piped script
  'echo "print(\'stdin script\')" | python3',
  // python alias
  'python -c "print(\'via python alias\')"',
];

export const startPage = async (): Promise<void> => {
  const terminalHost = document.getElementById('terminal') as HTMLDivElement;
  const examples = document.getElementById('examples') as HTMLDivElement;
  const nodeExamples = document.getElementById('node-examples') as HTMLDivElement;
  const cryptoExamples = document.getElementById('crypto-examples') as HTMLDivElement;
  const pythonExamples = document.getElementById('python-examples') as HTMLDivElement;
  const fsview = document.getElementById('fsview') as HTMLPreElement;
  const clearfs = document.getElementById('clearfs') as HTMLButtonElement;

  const terminal = new Terminal({ cols: 80, rows: 24, cursorBlink: true, convertEol: true, scrollback: 5_000 });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalHost);
  const write = (text: string): void => terminal.write(text);

  const refreshFsView = async (): Promise<void> => {
    try { fsview.textContent = await walkOpfs(); }
    catch (e) { fsview.textContent = 'error reading OPFS: ' + String(e); }
  };

  if (!crossOriginIsolated) { write('error: not cross-origin isolated (SharedArrayBuffer unavailable)\n'); return; }

  write('booting DuskJS...\n');
  const repl = await bootRepl(write, {
    net: { loadLibcurl: loadRealLibcurl, proxyUrl: 'wss://gointospace.app/wisp/', tcp: true },
    seed: TRANSCRIPT_SEED,
    user: 'dusk',
    // The demo drives dsh directly via stdin (no `feed()` calls), so the
    // pid-0 engine that bootRepl would otherwise create is dead weight: the
    // demo drives dsh directly and never calls feed(). Skipping it avoids an
    // idle runtime Worker and reduces steady-state memory use.
    skipPidZero: true,
  });
  write('spawning /bin/dsh (interactive)...\n');
  const sh = await repl.processManager.spawn('/bin/dsh', [], {
    // The layout persists only /home/<user>; /root and /tmp are session-only.
    cwd: '/home/dusk',
    env: { HOME: '/home/dusk', PATH: '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color', USER: 'dusk', DPM_REGISTRY: 'https://registry.dusk.night-x.com/' },
    pty: { cols: 80, rows: 24 },
  });

  const resize = (): void => {
    fitAddon.fit();
    sh.master?.resize(terminal.cols, terminal.rows);
  };
  window.addEventListener('resize', resize);
  resize();

  // With a PTY attached, master's onMasterData already carries BOTH the
  // process's stdout/stderr (via slaveWrite) AND the line-discipline echo of
  // typed input. Don't also pump sh.stdout/sh.stderr — that would double
  // every character. See host/pty.ts:129 and host/process-manager.ts:632.
  const masterDecoder = new TextDecoder();
  sh.master?.onMasterData((bytes) => {
    if (bytes.length) write(masterDecoder.decode(bytes, { stream: true }));
  });
  // Drain the byte streams so they don't backpressure, but discard their
  // output — the terminal render happens exclusively through onMasterData.
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader();
    try { while (true) { const { done } = await reader.read(); if (done) break; } }
    catch { /* stream closed */ }
  };
  void drain(sh.stdout);
  void drain(sh.stderr);

  let disposed = false;
  const teardown = (): void => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('resize', resize);
    terminal.dispose();
  };
  window.addEventListener('beforeunload', teardown, { once: true });
  void sh.exit.then((code) => {
    write('\n[shell exited with code ' + String(code) + ']\n');
    teardown();
  });

  write('ready. (fs is persistent via TFS/OPFS)\n');
  await refreshFsView();

  const encoder = new TextEncoder();
  const submit = async (text: string): Promise<void> => {
    await sh.stdin.write(encoder.encode(text.replace(/\r/g, '\n')));
    if (text.includes('\r') || text.includes('\n')) await refreshFsView();
  };

  terminal.onData((data) => { void submit(data); });

  clearfs.addEventListener('click', () => {
    void (async () => {
      try { await clearOpfs(); } catch (e) { write('clear fs error: ' + String(e) + '\n'); }
      await refreshFsView();
    })();
  });

  for (const ex of SHELL_EXAMPLES) {
    const btn = document.createElement('button');
    btn.textContent = ex;
    btn.addEventListener('click', () => { void submit(ex + '\r'); });
    examples.appendChild(btn);
  }
  for (const ex of NODE_EXAMPLES) {
    const btn = document.createElement('button');
    btn.textContent = ex;
    // Node REPL examples go to the same stdin — the shell forwards them to
    // whichever mode is active. If the user hasn't run `node` first, these
    // will be interpreted as shell commands and mostly fail; that's fine
    // and the label above the section explains the ordering.
    btn.addEventListener('click', () => { void submit(ex + '\r'); });
    nodeExamples.appendChild(btn);
  }
  // Crypto examples run inside the Node REPL (same as NODE_EXAMPLES).
  // Buttons show truncated labels so long snippets are readable; the full
  // command is still what gets submitted. Hover to see the whole thing.
  for (const ex of CRYPTO_EXAMPLES) {
    const btn = document.createElement('button');
    // Truncate very long lines in the label but preserve the full command
    // in title (hover tooltip) and click handler.
    btn.textContent = ex.length > 72 ? ex.slice(0, 69) + '...' : ex;
    btn.title = ex;
    btn.addEventListener('click', () => { void submit(ex + '\r'); });
    cryptoExamples.appendChild(btn);
  }
  for (const ex of PYTHON_EXAMPLES) {
    const btn = document.createElement('button');
    btn.textContent = ex;
    btn.addEventListener('click', () => { void submit(ex + '\r'); });
    pythonExamples.appendChild(btn);
  }
};
