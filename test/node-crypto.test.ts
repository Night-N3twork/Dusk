import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

test('node:crypto webcrypto retains the ambient Web Crypto identity', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const nodeCrypto = require('node:crypto'); const w = nodeCrypto.webcrypto; " +
    "const values = new Uint8Array(8); w.getRandomValues(values); " +
    "const rootValues = new Uint8Array(8); const rootWorks = nodeCrypto.getRandomValues(rootValues) === rootValues; " +
    "let floatRejected = false; let quotaRejected = false; " +
    "try { nodeCrypto.getRandomValues(new Float32Array(1)); } catch (error) { floatRejected = error instanceof TypeError; } " +
    "try { nodeCrypto.getRandomValues(new Uint8Array(65537)); } catch (error) { quotaRejected = error.name === 'QuotaExceededError'; } " +
    "process.stdout.write('identity=' + (w === globalThis.crypto) + '|rootWorks=' + rootWorks + '|uuid=' + /^[0-9a-f-]{36}$/.test(w.randomUUID()) + '|floatRejected=' + floatRejected + '|quotaRejected=' + quotaRejected + '\\n')"
  );
  repl.engine.terminate();

  expect(out.join('')).toContain('identity=true|rootWorks=true|uuid=true|floatRejected=true|quotaRejected=true');
}, 60_000);

test('persisted node:crypto declaration remains the Dusk builtin on a later REPL feed', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed("const crypto = require('node:crypto')");
  await repl.feed("process.stdout.write('HASH=' + crypto.createHash('sha256').update('hello').digest('hex') + '\\n')");
  repl.engine.terminate();

  expect(out.join('')).toContain('HASH=2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
}, 60_000);

test('node:crypto randomBytes, sha256(hello), hmac sha1, timingSafeEqual, randomUUID', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const crypto = require('node:crypto'); " +
    "const rb = crypto.randomBytes(16); " +
    "const sha = crypto.createHash('sha256').update('hello').digest('hex'); " +
    "const hmac = crypto.createHmac('sha1', 'key').update('msg').digest('hex'); " +
    "const a = new Uint8Array([1,2,3,4]); const b = new Uint8Array([1,2,3,4]); " +
    "const eq = crypto.timingSafeEqual(a, b); " +
    "const c = new Uint8Array([1,2,3,5]); const neq = crypto.timingSafeEqual(a, c); " +
    "const uuid = crypto.randomUUID(); " +
    "process.stdout.write('C:rbLen=' + rb.length + '|sha=' + sha + '|hmacLen=' + hmac.length + '|eq=' + eq + '|neq=' + neq + '|uuidLen=' + uuid.length + '|uuidShape=' + /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid) + ':END');\n"
  );
  repl.engine.terminate();
  const s = out.join('');
  expect(s).toContain('C:rbLen=16|');
  expect(s).toContain('sha=2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  expect(s).toContain('hmacLen=40');
  expect(s).toContain('eq=true');
  expect(s).toContain('neq=false');
  expect(s).toContain('uuidLen=36');
  expect(s).toContain('uuidShape=true');
}, 60_000);

test('node:crypto scrypt matches RFC 7914 vectors and rejects bad parameters', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const crypto = require('node:crypto'); " +
    "const a = crypto.scryptSync('password', 'NaCl', 64, { N: 1024, r: 8, p: 16 }).toString('hex'); " +
    "const b = crypto.scryptSync('', '', 64, { N: 16, r: 1, p: 1 }).toString('hex'); " +
    "let badN = ''; try { crypto.scryptSync('x', 'y', 16, { N: 3 }); } catch (e) { badN = e.code; } " +
    "let mem = ''; try { crypto.scryptSync('x', 'y', 16, { N: 1 << 20, r: 8 }); } catch (e) { mem = e.code; } " +
    "crypto.scrypt('x', 'y', 16, { N: 16, r: 1, p: 1 }, (err, key) => { " +
    "process.stdout.write('S:' + a.slice(0, 32) + '|' + b.slice(0, 32) + '|' + badN + '|' + mem + '|async=' + (err === null && key.length === 16) + ':END'); });"
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  repl.engine.terminate();
  const s = out.join('');
  expect(s).toContain('S:fdbabe1c9d3472007856e7190d01e9fe|77d6576238657b203b19ca42c18a0497|ERR_CRYPTO_INVALID_SCRYPT_PARAMS|ERR_CRYPTO_INVALID_SCRYPT_PARAMS|async=true:END');
}, 120_000);
