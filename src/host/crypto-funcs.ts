import type { FuncTable, SendFn } from './engine-instance';
import { formatHostError } from './host-errors';

export const createCryptoFuncs = (): FuncTable => {
  const ok = (send: SendFn, value: unknown): void => send({ value });
  const err = (send: SendFn, e: unknown): void => send({ error: formatHostError(e) });
  const subtleAvailable = typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined' && typeof crypto.subtle.digest === 'function';

  return {
    'crypto.random': (m, send) => {
      const size = (m['size'] as number) | 0;
      const buf = new Uint8Array(size);
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
      else for (let i = 0; i < size; i++) buf[i] = Math.floor(Math.random() * 256);
      ok(send, buf);
    },
    'crypto.digest': (m, send) => {
      if (!subtleAvailable) { err(send, new Error('SubtleCrypto unavailable')); return; }
      void (async () => {
        try {
          const algorithm = (m['algorithm'] as string).toUpperCase();
          const data = m['data'] as number[];
          const buf = await crypto.subtle.digest(algorithm, Uint8Array.from(data));
          ok(send, new Uint8Array(buf));
        } catch (e) { err(send, e); }
      })();
    },
    'crypto.hmac': (m, send) => {
      if (!subtleAvailable) { err(send, new Error('SubtleCrypto unavailable')); return; }
      void (async () => {
        try {
          const algorithm = (m['algorithm'] as string).toUpperCase();
          const keyArr = Uint8Array.from(m['key'] as number[]);
          const data = Uint8Array.from(m['data'] as number[]);
          const key = await crypto.subtle.importKey('raw', keyArr, { name: 'HMAC', hash: algorithm }, false, ['sign']);
          const buf = await crypto.subtle.sign('HMAC', key, data);
          ok(send, new Uint8Array(buf));
        } catch (e) { err(send, e); }
      })();
    },
    'zlib.compress': (m, send) => {
      void (async () => {
        try {
          const format = m['format'] as 'gzip' | 'deflate' | 'deflate-raw';
          const data = Uint8Array.from(m['data'] as number[]);
          const CS = (globalThis as { CompressionStream?: new (f: string) => { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> } }).CompressionStream;
          if (!CS) { err(send, new Error('CompressionStream unavailable')); return; }
          const cs = new CS(format);
          const w = cs.writable.getWriter();
          void w.write(data); void w.close();
          const reader = cs.readable.getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (true) {
            const r = await reader.read();
            if (r.done) break;
            if (r.value) { chunks.push(r.value); total += r.value.length; }
          }
          const out = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) { out.set(c, off); off += c.length; }
          ok(send, out);
        } catch (e) { err(send, e); }
      })();
    },
    'zlib.decompress': (m, send) => {
      void (async () => {
        try {
          const format = m['format'] as 'gzip' | 'deflate' | 'deflate-raw';
          const data = Uint8Array.from(m['data'] as number[]);
          const DS = (globalThis as { DecompressionStream?: new (f: string) => { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> } }).DecompressionStream;
          if (!DS) { err(send, new Error('DecompressionStream unavailable')); return; }
          const ds = new DS(format);
          const w = ds.writable.getWriter();
          void w.write(data); void w.close();
          const reader = ds.readable.getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (true) {
            const r = await reader.read();
            if (r.done) break;
            if (r.value) { chunks.push(r.value); total += r.value.length; }
          }
          const out = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) { out.set(c, off); off += c.length; }
          ok(send, out);
        } catch (e) { err(send, e); }
      })();
    },
    'crypto.encrypt': (m, send) => {
      if (!subtleAvailable) { err(send, new Error('SubtleCrypto unavailable')); return; }
      void (async () => {
        try {
          const algName = (m['algorithm'] as string).toLowerCase();
          const keyBytes = Uint8Array.from(m['key'] as number[]);
          const ivBytes = Uint8Array.from(m['iv'] as number[]);
          const plaintext = Uint8Array.from(m['plaintext'] as number[]);
          let subtleAlg: AesCbcParams | AesGcmParams | AesCtrParams;
          if (algName.endsWith('-gcm')) {
            subtleAlg = { name: 'AES-GCM', iv: ivBytes };
            if (m['aad']) (subtleAlg as AesGcmParams).additionalData = Uint8Array.from(m['aad'] as number[]);
          } else if (algName.endsWith('-cbc')) {
            subtleAlg = { name: 'AES-CBC', iv: ivBytes };
          } else if (algName.endsWith('-ctr')) {
            subtleAlg = { name: 'AES-CTR', counter: ivBytes, length: 64 };
          } else {
            err(send, new Error('Unsupported cipher: ' + algName));
            return;
          }
          const key = await crypto.subtle.importKey('raw', keyBytes, subtleAlg.name, false, ['encrypt']);
          const buf = await crypto.subtle.encrypt(subtleAlg, key, plaintext);
          const out = new Uint8Array(buf);
          if (algName.endsWith('-gcm')) {
            const tagLen = 16;
            const ct = out.slice(0, out.length - tagLen);
            const tag = out.slice(out.length - tagLen);
            ok(send, { ciphertext: ct, authTag: tag });
          } else {
            ok(send, { ciphertext: out });
          }
        } catch (e) { err(send, e); }
      })();
    },
    'crypto.decrypt': (m, send) => {
      if (!subtleAvailable) { err(send, new Error('SubtleCrypto unavailable')); return; }
      void (async () => {
        try {
          const algName = (m['algorithm'] as string).toLowerCase();
          const keyBytes = Uint8Array.from(m['key'] as number[]);
          const ivBytes = Uint8Array.from(m['iv'] as number[]);
          let ciphertext = Uint8Array.from(m['ciphertext'] as number[]);
          let subtleAlg: AesCbcParams | AesGcmParams | AesCtrParams;
          if (algName.endsWith('-gcm')) {
            subtleAlg = { name: 'AES-GCM', iv: ivBytes };
            if (m['aad']) (subtleAlg as AesGcmParams).additionalData = Uint8Array.from(m['aad'] as number[]);
            if (m['authTag']) {
              const tag = Uint8Array.from(m['authTag'] as number[]);
              const combined = new Uint8Array(ciphertext.length + tag.length);
              combined.set(ciphertext);
              combined.set(tag, ciphertext.length);
              ciphertext = combined;
            }
          } else if (algName.endsWith('-cbc')) {
            subtleAlg = { name: 'AES-CBC', iv: ivBytes };
          } else if (algName.endsWith('-ctr')) {
            subtleAlg = { name: 'AES-CTR', counter: ivBytes, length: 64 };
          } else {
            err(send, new Error('Unsupported cipher: ' + algName));
            return;
          }
          const key = await crypto.subtle.importKey('raw', keyBytes, subtleAlg.name, false, ['decrypt']);
          const buf = await crypto.subtle.decrypt(subtleAlg, key, ciphertext);
          ok(send, { plaintext: new Uint8Array(buf) });
        } catch (e) { err(send, e); }
      })();
    },
    'crypto.pbkdf2': (m, send) => {
      if (!subtleAvailable) { err(send, new Error('SubtleCrypto unavailable')); return; }
      void (async () => {
        try {
          const digest = (m['digest'] as string).toUpperCase();
          const pwd = Uint8Array.from(m['password'] as number[]);
          const salt = Uint8Array.from(m['salt'] as number[]);
          const iterations = m['iterations'] as number;
          const keylen = m['keylen'] as number;
          const baseKey = await crypto.subtle.importKey('raw', pwd, 'PBKDF2', false, ['deriveBits']);
          const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: digest }, baseKey, keylen * 8);
          ok(send, new Uint8Array(bits));
        } catch (e) { err(send, e); }
      })();
    },
    'crypto.generateKeyPair': (m, send) => {
      if (!subtleAvailable) { err(send, new Error('SubtleCrypto unavailable')); return; }
      void (async () => {
        try {
          const type = (m['type'] as string).toLowerCase();
          let algorithm: RsaHashedKeyGenParams | EcKeyGenParams | Algorithm;
          let usages: KeyUsage[] = ['sign', 'verify'];
          if (type === 'rsa' || type === 'rsa-pss') {
            const modulusLength = (m['modulusLength'] as number) || 2048;
            const hash = (m['hash'] as string | undefined) ?? 'SHA-256';
            const exponent = BigInt((m['publicExponent'] as number | undefined) ?? 65537);
            let exponentHex = exponent.toString(16);
            if (exponentHex.length % 2) exponentHex = '0' + exponentHex;
            const publicExponent = new Uint8Array(exponentHex.match(/../g)!.map((byte) => parseInt(byte, 16)));
            algorithm = { name: type === 'rsa-pss' ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5', modulusLength, publicExponent, hash };
          } else if (type === 'ec' || type === 'ecdsa') {
            algorithm = { name: 'ECDSA', namedCurve: (m['namedCurve'] as string | undefined) ?? 'P-256' };
          } else if (OKP_SIGN[type]) {
            algorithm = { name: OKP_SIGN[type]! };
          } else if (OKP_DH[type]) {
            algorithm = { name: OKP_DH[type]! };
            usages = ['deriveBits'];
          } else {
            err(send, new Error('Unsupported key type: ' + type));
            return;
          }
          const kp = await crypto.subtle.generateKey(algorithm, true, usages) as CryptoKeyPair;
          const pubBuf = await crypto.subtle.exportKey('spki', kp.publicKey);
          const privBuf = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
          ok(send, { publicKey: new Uint8Array(pubBuf), privateKey: new Uint8Array(privBuf) });
        } catch (e) { err(send, e); }
      })();
    },
    'crypto.sign': (m, send) => {
      if (!subtleAvailable) { err(send, new Error('SubtleCrypto unavailable')); return; }
      void (async () => {
        try {
          const keyBytes = Uint8Array.from(m['key'] as number[]);
          const data = Uint8Array.from(m['data'] as number[]);
          const params = signatureParams(m);
          if (!params) { err(send, new Error('Unsupported key type for signing: ' + String(m['keyType']))); return; }
          const key = await crypto.subtle.importKey('pkcs8', keyBytes, params.importAlg, false, ['sign']);
          ok(send, new Uint8Array(await crypto.subtle.sign(params.signAlg, key, data)));
        } catch (e) { err(send, e); }
      })();
    },
    'crypto.verify': (m, send) => {
      if (!subtleAvailable) { err(send, new Error('SubtleCrypto unavailable')); return; }
      void (async () => {
        try {
          const keyBytes = Uint8Array.from(m['key'] as number[]);
          const data = Uint8Array.from(m['data'] as number[]);
          const signature = Uint8Array.from(m['signature'] as number[]);
          const params = signatureParams(m);
          if (!params) { err(send, new Error('Unsupported key type for verify: ' + String(m['keyType']))); return; }
          const key = await crypto.subtle.importKey('spki', keyBytes, params.importAlg, false, ['verify']);
          ok(send, await crypto.subtle.verify(params.signAlg, key, signature, data));
        } catch (e) { err(send, e); }
      })();
    },
    'crypto.okp.deriveBits': (m, send) => {
      if (!subtleAvailable) { err(send, new Error('SubtleCrypto unavailable')); return; }
      void (async () => {
        try {
          const name = OKP_DH[(m['keyType'] as string).toLowerCase()];
          if (!name) { err(send, new Error('Unsupported key type for diffieHellman: ' + String(m['keyType']))); return; }
          const privateKey = await crypto.subtle.importKey('pkcs8', Uint8Array.from(m['privateKey'] as number[]), { name }, false, ['deriveBits']);
          const publicKey = await crypto.subtle.importKey('spki', Uint8Array.from(m['publicKey'] as number[]), { name }, false, []);
          const bits = name === 'X448' ? 448 : 256;
          ok(send, new Uint8Array(await crypto.subtle.deriveBits({ name, public: publicKey } as Algorithm, privateKey, bits)));
        } catch (e) { err(send, e); }
      })();
    },
    'crypto.okp.publicKey': (m, send) => {
      if (!subtleAvailable) { err(send, new Error('SubtleCrypto unavailable')); return; }
      void (async () => {
        try {
          const type = (m['keyType'] as string).toLowerCase();
          const name = OKP_SIGN[type] ?? OKP_DH[type];
          if (!name) { err(send, new Error('Unsupported key type: ' + type)); return; }
          const usages: KeyUsage[] = OKP_SIGN[type] ? ['sign'] : ['deriveBits'];
          const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(m['der'] as number[]), { name }, true, usages);
          const jwk = await crypto.subtle.exportKey('jwk', key);
          const binary = atob((jwk.x ?? '').replace(/-/g, '+').replace(/_/g, '/'));
          const raw = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);
          ok(send, raw);
        } catch (e) { err(send, e); }
      })();
    },
  };
};

const OKP_SIGN: Record<string, string> = { ed25519: 'Ed25519', ed448: 'Ed448' };
const OKP_DH: Record<string, string> = { x25519: 'X25519', x448: 'X448' };
const SUBTLE_CURVES: Record<string, string> = { prime256v1: 'P-256', secp384r1: 'P-384', secp521r1: 'P-521' };

const signatureParams = (m: Record<string, unknown>): { importAlg: Algorithm; signAlg: Algorithm } | undefined => {
  const keyType = String(m['keyType'] ?? '').toLowerCase();
  const hash = (m['hash'] as string | undefined) ?? 'SHA-256';
  if (keyType === 'rsa') return { importAlg: { name: 'RSASSA-PKCS1-v1_5', hash } as Algorithm, signAlg: { name: 'RSASSA-PKCS1-v1_5' } };
  if (keyType === 'rsa-pss') {
    return {
      importAlg: { name: 'RSA-PSS', hash } as Algorithm,
      signAlg: { name: 'RSA-PSS', saltLength: (m['saltLength'] as number | undefined) ?? 32 } as Algorithm,
    };
  }
  if (keyType === 'ec' || keyType === 'ecdsa') {
    const curve = (m['namedCurve'] as string | undefined) ?? 'P-256';
    return { importAlg: { name: 'ECDSA', namedCurve: SUBTLE_CURVES[curve] ?? curve } as Algorithm, signAlg: { name: 'ECDSA', hash } as Algorithm };
  }
  const okp = OKP_SIGN[keyType];
  if (okp) return { importAlg: { name: okp }, signAlg: { name: okp } };
  return undefined;
};
