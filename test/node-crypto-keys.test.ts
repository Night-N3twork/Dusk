import { test, expect, beforeAll } from 'vitest';
import { bootRepl } from '../src/index';

let fixtures = '';

beforeAll(async () => {
  fixtures = await (await fetch(new URL('./fixtures/crypto-interop.json', import.meta.url))).text();
});

const run = async (code: string): Promise<string> => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory', seed: { '/fx.json': fixtures } });
  await repl.feed("const crypto = require('node:crypto')");
  await repl.feed("const fx = JSON.parse(require('node:fs').readFileSync('/fx.json', 'utf8'))");
  await repl.feed(code);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await repl.engine.terminate();
  return out.join('');
};

test('verifies Node-made ECDSA, RSA, RSA-PSS and Ed25519 signatures', async () => {
  const s = await run(
    "const data = Buffer.from('hello'); const b = (x) => Buffer.from(x, 'base64'); " +
    "const r = [crypto.verify('sha256', data, fx.ecPub, b(fx.ecSig)), crypto.verify('sha256', data, fx.k1Pub, b(fx.k1Sig)), " +
    "crypto.verify('sha256', data, fx.rsaPub, b(fx.rsaSig)), " +
    "crypto.verify('sha256', data, { key: fx.rsaPub, padding: crypto.constants.RSA_PKCS1_PSS_PADDING }, b(fx.pssSig)), " +
    "crypto.verify(null, data, fx.edPub, b(fx.edSig)), crypto.verify('sha256', Buffer.from('nope'), fx.ecPub, b(fx.ecSig))]; " +
    "process.stdout.write('V:' + r.join(',') + ':END');"
  );
  expect(s).toContain('V:true,true,true,true,true,false:END');
}, 60_000);

test('signs with PEM keys in every encoding and verifies the result', async () => {
  const s = await run(
    "const data = Buffer.from('payload'); " +
    "const pairs = [[fx.ecPriv, fx.ecPub, 'sha256'], [fx.k1Priv, fx.k1Pub, 'sha384'], [fx.rsaPriv, fx.rsaPub, 'sha512'], [fx.edPriv, fx.edPub, null]]; " +
    "const r = pairs.map(([priv, pub, alg]) => crypto.verify(alg, data, pub, crypto.sign(alg, data, priv))); " +
    "const p1363 = crypto.sign('sha256', data, { key: fx.ecPriv, dsaEncoding: 'ieee-p1363' }); " +
    "const viaClass = crypto.createVerify('SHA256').update(data).verify(fx.rsaPub, crypto.createSign('RSA-SHA256').update(data).sign(fx.rsaPriv)); " +
    "process.stdout.write('S:' + r.join(',') + '|' + p1363.length + '|' + crypto.verify('sha256', data, { key: fx.ecPub, dsaEncoding: 'ieee-p1363' }, p1363) + '|' + viaClass + ':END');"
  );
  expect(s).toContain('S:true,true,true,true|64|true|true:END');
}, 60_000);

test('KeyObject reports details and round-trips PEM, DER and JWK', async () => {
  const s = await run(
    "const ec = crypto.createPrivateKey(fx.ecPriv); const rsa = crypto.createPublicKey(fx.rsaPub); const ed = crypto.createPrivateKey(fx.edPriv); " +
    "const ecPub = crypto.createPublicKey(ec); " +
    "const jwk = ec.export({ format: 'jwk' }); const fromJwk = crypto.createPrivateKey({ key: jwk, format: 'jwk' }); " +
    "const edJwk = ed.export({ format: 'jwk' }); " +
    "const der = rsa.export({ type: 'spki', format: 'der' }); const fromDer = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }); " +
    "process.stdout.write('K:' + [ec.type, ec.asymmetricKeyType, ec.asymmetricKeyDetails.namedCurve, rsa.asymmetricKeyDetails.modulusLength, " +
    "ecPub.export({ type: 'spki', format: 'pem' }) === fx.ecPub, JSON.stringify(jwk) === JSON.stringify(fx.ecJwk), fromJwk.equals(ec), " +
    "JSON.stringify(edJwk) === JSON.stringify(fx.edJwk), fromDer.equals(rsa), JSON.stringify(rsa.export({ format: 'jwk' })) === JSON.stringify(fx.rsaJwk), " +
    "crypto.createSecretKey(Buffer.from('abc')).symmetricKeySize].join(',') + ':END');"
  );
  expect(s).toContain('K:private,ec,prime256v1,1024,true,true,true,true,true,true,3:END');
}, 60_000);

test('generateKeyPairSync returns KeyObjects or encoded keys', async () => {
  const s = await run(
    "const a = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }); " +
    "const b = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }); " +
    "const k = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' }); " +
    "const pss = crypto.generateKeyPairSync('rsa-pss', { modulusLength: 1024 }); " +
    "const msg = Buffer.from('x'); " +
    "process.stdout.write('G:' + [a.publicKey instanceof crypto.KeyObject, typeof b.publicKey, b.privateKey.startsWith('-----BEGIN PRIVATE KEY-----'), " +
    "crypto.verify(null, msg, b.publicKey, crypto.sign(null, msg, b.privateKey)), " +
    "crypto.verify('sha256', msg, k.publicKey, crypto.sign('sha256', msg, k.privateKey)), pss.privateKey.asymmetricKeyType, " +
    "crypto.verify('sha256', msg, pss.publicKey, crypto.sign('sha256', msg, pss.privateKey))].join(',') + ':END');"
  );
  expect(s).toContain('G:true,string,true,true,true,rsa-pss,true:END');
}, 60_000);

test('ECDH, X25519, MODP Diffie-Hellman, HKDF and crypto.hash', async () => {
  const s = await run(
    "const a = crypto.createECDH('prime256v1'); const b = crypto.createECDH('prime256v1'); a.generateKeys(); b.generateKeys(); " +
    "const ecdh = a.computeSecret(b.getPublicKey()).equals(b.computeSecret(a.getPublicKey())); " +
    "const x = crypto.diffieHellman({ privateKey: crypto.createPrivateKey(fx.xPriv), publicKey: crypto.createPublicKey(fx.yPub) }).toString('hex') === fx.xShared; " +
    "const g1 = crypto.getDiffieHellman('modp14'); const g2 = crypto.getDiffieHellman('modp14'); g1.generateKeys(); g2.generateKeys(); " +
    "const dh = g1.computeSecret(g2.getPublicKey()).equals(g2.computeSecret(g1.getPublicKey())); " +
    "const okm = Buffer.from(crypto.hkdfSync('sha256', Buffer.alloc(22, 0x0b), Buffer.from('000102030405060708090a0b0c', 'hex'), Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'), 42)).toString('hex'); " +
    "const h = crypto.hash('sha1', 'abc'); " +
    "process.stdout.write('D:' + [ecdh, x, dh, okm, h, crypto.getCurves().includes('secp256k1'), typeof crypto.subtle.digest].join(',') + ':END');"
  );
  expect(s).toContain('D:true,true,true,3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865,a9993e364706816aba3e25717850c26c9cd0d89d,true,function:END');
}, 120_000);
