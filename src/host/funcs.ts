import type { FuncTable, SendFn } from './runner';
import { formatHostError } from './host-errors';
import type { FSBackend } from './fs-backend';
import { prepareModuleSource } from './esm-static-transform';
import { resolveModule } from './module-resolver';
import { createNativePackageRegistry, type NativePackageRegistry } from './native-package-registry';

export const createFuncs = (fs: FSBackend, out: (text: string) => void, nativePackageRegistry: NativePackageRegistry = createNativePackageRegistry()): FuncTable => {
  const writeDecoder = new TextDecoder();
  const ok = (send: SendFn, value: unknown): void => send({ value });
  const err = (send: SendFn, e: unknown): void => send({ error: formatHostError(e) });

  return {
    'console.log': (msg, send) => { out(((msg['args'] as unknown[]) ?? []).map(String).join(' ') + '\n'); send({}); },
    'console.error': (msg, send) => { out(((msg['args'] as unknown[]) ?? []).map(String).join(' ') + '\n'); send({}); },
    'process.cwd': (_m, send) => ok(send, '/'),
    'process.exit': (_m, send) => { send({}); },
    'proc.write': (m, send) => {
      const data = m['data'] as Uint8Array | number[] | undefined;
      if (data) out(writeDecoder.decode(data instanceof Uint8Array ? data : new Uint8Array(data), { stream: true }));
      send({});
    },
    'fs.readFile': (m, send) => { void (async () => { try { ok(send, await fs.readFile(m['path'] as string)); } catch (e) { err(send, e); } })(); },
    'fs.readFileBytes': (m, send) => { void (async () => { try { const bytes = await fs.readFileBytes(m['path'] as string); const maxBytes = m['maxBytes'] as number | undefined; ok(send, maxBytes !== undefined && bytes.length > maxBytes ? { tooLarge: true, size: bytes.length } : bytes); } catch (e) { err(send, e); } })(); },
    'fs.writeFileBytes': (m, send) => { void (async () => { try { const data = m['data'] as Uint8Array | number[]; await fs.writeFileBytes(m['path'] as string, data instanceof Uint8Array ? data : Uint8Array.from(data)); ok(send, true); } catch (e) { err(send, e); } })(); },
    'fs.writeFile': (m, send) => { void (async () => { try { await fs.writeFile(m['path'] as string, m['data'] as string); ok(send, true); } catch (e) { err(send, e); } })(); },
    'fs.readdir': (m, send) => { void (async () => { try { ok(send, await fs.readdir(m['path'] as string)); } catch (e) { err(send, e); } })(); },
    'fs.mkdir': (m, send) => { void (async () => { try { await fs.mkdir(m['path'] as string, { recursive: Boolean(m['recursive']) }); ok(send, true); } catch (e) { err(send, e); } })(); },
    'fs.rm': (m, send) => { void (async () => { try { await fs.rm(m['path'] as string, { recursive: Boolean(m['recursive']) }); ok(send, true); } catch (e) { err(send, e); } })(); },
    'fs.exists': (m, send) => { void (async () => { try { ok(send, await fs.exists(m['path'] as string)); } catch (e) { err(send, e); } })(); },
    'fs.stat': (m, send) => { void (async () => { try { ok(send, await fs.stat(m['path'] as string)); } catch (e) { err(send, e); } })(); },
    'fs.rename': (m, send) => { void (async () => { try { await fs.rename(m['from'] as string, m['to'] as string); ok(send, true); } catch (e) { err(send, e); } })(); },
    'module.resolve': (m, send) => { void (async () => { try { ok(send, await resolveModule(fs, m['request'] as string, m['fromDir'] as string, (m['mode'] as 'import' | 'require' | undefined) ?? 'import', new Set(), nativePackageRegistry)); } catch (e) { err(send, e); } })(); },
    'module.readSource': (m, send) => { void (async () => { try { const path = m['path'] as string; const source = nativePackageRegistry.readSource(path) ?? await fs.readFile(path); ok(send, await prepareModuleSource(source, path, m['mode'])); } catch (e) { err(send, e); } })(); },
  };
};
