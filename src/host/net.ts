import type { FuncTable, SendFn } from './runner';
import { assertAllowed, assertUrlAllowed, type NetworkPolicy } from './network-policy';

export interface NetResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export interface NetHost {
  funcs: FuncTable;
  registerLibcurl(name: string, instance: LibCurl): void;
  registerTransport(name: string, transport: unknown): void;
  registerWispTransport(name: string, factory: unknown): void;
  cleanupForPid(pid: number): void;
  fetch(url: string): Promise<NetResponse>;
  fetchBytes(url: string): Promise<Uint8Array>;
}

export interface LibCurl {
  load_wasm(url?: string): Promise<void>;
  set_websocket(url: string): void;
  fetch(url: string, opts?: unknown): Promise<Response>;
  WebSocket: new (url: string, protocols?: string[]) => WebSocket;
  transport?: unknown;
  set_wisp_transport?(factory: unknown): void;
  version?: unknown;
  HTTPSession?: new (opts?: unknown) => { fetch(url: string, opts?: unknown): Promise<Response>; close(): void };
  TLSSocket?: new (host: string, port: number, opts?: unknown) => {
    onopen: (() => void) | null;
    onmessage: ((d: Uint8Array) => void) | null;
    onclose: (() => void) | null;
    onerror: ((e: unknown) => void) | null;
    send(data: Uint8Array): void;
    close(): void;
  };
}

export const createNet = (
  loadLibcurl: () => Promise<LibCurl>,
  dispatch: (js: string, pid?: number) => void,
  proxyUrl: string,
  policy?: NetworkPolicy,
): NetHost => {
  const instances = new Map<string, LibCurl>();
  const directWebsockets = new Map<LibCurl, string>();
  const transports = new Map<string, unknown>();
  const wispTransports = new Map<string, unknown>();
  let activeName = 'default';
  let defaultLoading: Promise<LibCurl> | undefined;

  const ensureActive = async (): Promise<LibCurl> => {
    if (activeName === 'default' && !instances.has('default')) {
      if (!defaultLoading) {
        defaultLoading = (async () => {
          const instance = await loadLibcurl();
          await instance.load_wasm();
          instance.set_websocket(proxyUrl);
          directWebsockets.set(instance, proxyUrl);
          instances.set('default', instance);
          return instance;
        })().catch((error) => {
          defaultLoading = undefined;
          throw error;
        });
      }
      return defaultLoading;
    }
    const inst = instances.get(activeName);
    if (!inst) throw new Error('libcurl instance not registered: ' + activeName);
    return inst;
  };

  let nextId = 1;
  const sockets = new Map<number, { socket: WebSocket; pid: number | undefined; messages: Promise<void>; closing: boolean }>();
  const tlsSockets = new Map<number, { socket: InstanceType<NonNullable<LibCurl['TLSSocket']>>; pid: number | undefined }>();
  const sessions = new Map<number, { session: InstanceType<NonNullable<LibCurl['HTTPSession']>>; pid: number | undefined }>();
  const fetches = new Map<number, number | undefined>();
  const exitedPids = new Set<number>();

  const enc = (v: unknown): string => JSON.stringify(v);
  const fire = (id: number, kind: string, payload: unknown, pid?: number): void =>
    dispatch(`globalThis.__net.dispatch(${id}, ${JSON.stringify(kind)}, ${enc(payload)})`, pid);
  const webSocketPayload = async (data: unknown): Promise<unknown> => {
    if (typeof data === 'string') return data;
    if (data instanceof Uint8Array) return [...data];
    if (data instanceof ArrayBuffer) return [...new Uint8Array(data)];
    if (ArrayBuffer.isView(data)) return [...new Uint8Array(data.buffer, data.byteOffset, data.byteLength)];
    if (typeof Blob !== 'undefined' && data instanceof Blob) return [...new Uint8Array(await data.arrayBuffer())];
    return data;
  };
  const hasReadonlyTransport = (instance: LibCurl): boolean => {
    let target: object | null = instance;
    while (target) {
      const descriptor = Object.getOwnPropertyDescriptor(target, 'transport');
      if (descriptor) return descriptor.set === undefined && descriptor.writable !== true;
      target = Object.getPrototypeOf(target);
    }
    return false;
  };
  const responsePayload = async (res: Response): Promise<{ status: number; statusText: string; headers: [string, string][]; body: number[] }> => {
    const arrayBuffer = (res as Response & { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer;
    const body = arrayBuffer
      ? new Uint8Array(await arrayBuffer.call(res))
      : new TextEncoder().encode(await res.text());
    return {
      status: res.status,
      statusText: res.statusText,
      headers: [...res.headers.entries()],
      body: [...body],
    };
  };
  const ownerPid = (m: Record<string, unknown>): number | undefined =>
    (m['__enginePid'] as number | undefined) ?? (m['pid'] as number | undefined);
  const owns = (record: { pid: number | undefined }, pid: number | undefined): boolean => record.pid === pid;
  const rejectForeign = (record: { pid: number | undefined } | undefined, pid: number | undefined, send: SendFn): boolean => {
    if (record && !owns(record, pid)) { send({ error: 'resource belongs to another process' }); return true; }
    return false;
  };

  const funcs: FuncTable = {
    'net.fetch': (m, send: SendFn) => {
      const id = nextId++;
      const pid = ownerPid(m);
      fetches.set(id, pid);
      send({ value: id });
      void (async () => {
        try {
          assertUrlAllowed(policy, m['url'] as string);
          const c = await ensureActive();
          const res = await c.fetch(m['url'] as string, m['opts']);
          if (fetches.get(id) === pid) fire(id, 'response', await responsePayload(res), pid);
        } catch (e) { if (fetches.get(id) === pid) fire(id, 'error', String(e), pid); }
        finally { fetches.delete(id); }
      })();
    },
    'net.fetch.sync': (m, send: SendFn) => {
      void (async () => {
        try {
          assertUrlAllowed(policy, m['url'] as string);
          const c = await ensureActive();
          const res = await c.fetch(m['url'] as string, m['opts']);
          send({ value: await responsePayload(res) });
        } catch (e) { send({ error: String(e) }); }
      })();
    },
    'net.ws.open': (m, send: SendFn) => {
      const id = nextId++;
      const pid = ownerPid(m);
      send({ value: id });
      void (async () => {
        try {
          const c = await ensureActive();
          assertUrlAllowed(policy, m['url'] as string);
          const ws = new c.WebSocket(m['url'] as string, (m['protocols'] as string[]) ?? []);
          if (pid !== undefined && exitedPids.has(pid)) {
            try { ws.close(); } catch { /* best-effort shutdown */ }
            return;
          }
          const record = { socket: ws, pid, messages: Promise.resolve(), closing: false };
          sockets.set(id, record);
          ws.addEventListener('open', () => { if (sockets.get(id) === record) fire(id, 'open', null, pid); });
          ws.addEventListener('message', (e: MessageEvent) => {
            record.messages = record.messages.then(async () => {
              try {
                const payload = await webSocketPayload(e.data);
                if (sockets.get(id) === record) fire(id, 'message', payload, pid);
              } catch (error) {
                if (sockets.get(id) === record) fire(id, 'error', String(error), pid);
              }
            });
          });
          ws.addEventListener('close', () => {
            if (sockets.get(id) !== record) return;
            record.closing = true;
            void record.messages.then(() => {
              if (sockets.get(id) !== record) return;
              sockets.delete(id);
              fire(id, 'close', null, pid);
            });
          });
          ws.addEventListener('error', () => {
            if (sockets.get(id) !== record) return;
            sockets.delete(id);
            fire(id, 'error', 'ws error', pid);
          });
        } catch (e) { fire(id, 'error', String(e), pid); }
      })();
    },
    'net.ws.send': (m, send: SendFn) => {
      const record = sockets.get(m['id'] as number);
      if (rejectForeign(record, ownerPid(m), send)) return;
      if (record && !record.closing) record.socket.send(m['data'] as string);
      send({});
    },
    'net.ws.close': (m, send: SendFn) => {
      const id = m['id'] as number;
      const record = sockets.get(id);
      if (rejectForeign(record, ownerPid(m), send)) return;
      sockets.delete(id);
      if (record) record.socket.close();
      send({});
    },
    'net.cfg.set_instance': (m, send: SendFn) => {
      const name = m['name'] as string;
      if (typeof name !== 'string') { send({ error: 'instance name must be a string' }); return; }
      if (name !== 'default' && !instances.has(name)) { send({ error: 'libcurl instance not registered: ' + name }); return; }
      activeName = name;
      send({ value: true });
    },
    'net.cfg.set_websocket': (m, send: SendFn) => {
      void (async () => {
        try {
          const c = await ensureActive();
          const url = m['url'] as string;
          c.set_websocket(url);
          directWebsockets.set(c, url);
          send({ value: true });
        }
        catch (e) { send({ error: String(e) }); }
      })();
    },
    'net.cfg.get_transport': (_m, send: SendFn) => {
      void (async () => {
        try { send({ value: (await ensureActive()).transport ?? null }); }
        catch (e) { send({ error: String(e) }); }
      })();
    },
    'net.cfg.set_transport': (m, send: SendFn) => {
      void (async () => {
        try {
          const name = m['transport'] as string;
          const c = await ensureActive();
          if (name === 'wisp' && hasReadonlyTransport(c)) {
            c.set_websocket(directWebsockets.get(c) ?? proxyUrl);
            send({ value: true });
            return;
          }
          if (wispTransports.has(name)) {
            if (typeof c.set_wisp_transport !== 'function') { send({ error: 'Wisp transport factories are not supported by active LibCurl' }); return; }
            c.set_wisp_transport(wispTransports.get(name));
            send({ value: true });
            return;
          }
          if (name === 'wsproxy' && typeof c.set_wisp_transport === 'function') {
            send({ error: 'Nova LibCurl does not support wsproxy; register a Wisp factory with registerWispTransport()' });
            return;
          }
          if (name === 'wisp' || name === 'wsproxy') { c.transport = name; send({ value: true }); return; }
          if (transports.has(name)) { c.transport = transports.get(name); send({ value: true }); return; }
          send({ error: 'transport not registered: ' + name });
        } catch (e) { send({ error: String(e) }); }
      })();
    },
    'net.cfg.version': (_m, send: SendFn) => {
      void (async () => {
        try { send({ value: (await ensureActive()).version ?? null }); }
        catch (e) { send({ error: String(e) }); }
      })();
    },
    'net.session.create': (m, send: SendFn) => {
      const pid = ownerPid(m);
      void (async () => {
        try {
          const c = await ensureActive();
          if (!c.HTTPSession) { send({ error: 'HTTPSession not supported by active instance' }); return; }
          const id = nextId++;
          const session = new c.HTTPSession(m['opts']);
          if (pid !== undefined && exitedPids.has(pid)) {
            try { session.close(); } catch { /* best-effort shutdown */ }
            send({ error: 'process exited' });
            return;
          }
          sessions.set(id, { session, pid });
          send({ value: id });
        } catch (e) { send({ error: String(e) }); }
      })();
    },
    'net.session.fetch': (m, send: SendFn) => {
      const id = nextId++;
      const pid = ownerPid(m);
      send({ value: id });
      void (async () => {
        let record: { session: InstanceType<NonNullable<LibCurl['HTTPSession']>>; pid: number | undefined } | undefined;
        try {
          record = sessions.get(m['sid'] as number);
          if (!record) { fire(id, 'error', 'unknown session: ' + m['sid'], pid); return; }
          if (!owns(record, pid)) { fire(id, 'error', 'resource belongs to another process', pid); return; }
          assertUrlAllowed(policy, m['url'] as string);
          const res = await record.session.fetch(m['url'] as string, m['opts']);
          const payload = await responsePayload(res);
          if (sessions.get(m['sid'] as number) === record) fire(id, 'response', payload, record.pid);
        } catch (e) {
          if (!record || sessions.get(m['sid'] as number) === record) fire(id, 'error', String(e), pid);
        }
      })();
    },
    'net.session.close': (m, send: SendFn) => {
      const id = m['sid'] as number;
      const record = sessions.get(id);
      if (rejectForeign(record, ownerPid(m), send)) return;
      sessions.delete(id);
      if (record) record.session.close();
      send({ value: true });
    },
    'net.tls.open': (m, send: SendFn) => {
      const id = nextId++;
      const pid = ownerPid(m);
      send({ value: id });
      void (async () => {
        try {
          const c = await ensureActive();
          if (!c.TLSSocket) { fire(id, 'error', 'TLSSocket not supported by active instance', pid); return; }
          assertAllowed(policy, { protocol: 'tls:', host: String(m['host']).toLowerCase(), port: m['port'] as number });
          const sock = new c.TLSSocket(m['host'] as string, m['port'] as number, m['opts']);
          if (pid !== undefined && exitedPids.has(pid)) {
            try { sock.close(); } catch { /* best-effort shutdown */ }
            return;
          }
          const record = { socket: sock, pid };
          tlsSockets.set(id, record);
          sock.onopen = () => { if (tlsSockets.get(id) === record) fire(id, 'open', null, pid); };
          sock.onmessage = (d: Uint8Array) => { if (tlsSockets.get(id) === record) fire(id, 'message', [...d], pid); };
          sock.onclose = () => {
            if (tlsSockets.get(id) !== record) return;
            tlsSockets.delete(id);
            fire(id, 'close', null, pid);
          };
          sock.onerror = (e: unknown) => {
            if (tlsSockets.get(id) !== record) return;
            tlsSockets.delete(id);
            fire(id, 'error', String(e), pid);
          };
        } catch (e) { fire(id, 'error', String(e), pid); }
      })();
    },
    'net.tls.send': (m, send: SendFn) => {
      const record = tlsSockets.get(m['id'] as number);
      if (rejectForeign(record, ownerPid(m), send)) return;
      if (record) record.socket.send(Uint8Array.from(m['data'] as number[]));
      send({});
    },
    'net.tls.close': (m, send: SendFn) => {
      const id = m['id'] as number;
      const record = tlsSockets.get(id);
      if (rejectForeign(record, ownerPid(m), send)) return;
      tlsSockets.delete(id);
      if (record) record.socket.close();
      send({});
    },
  };

  return {
    fetch: async (url) => {
      assertUrlAllowed(policy, url);
      const response = await (await ensureActive()).fetch(url);
      return { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()), body: await response.text() };
    },
    fetchBytes: async (url) => {
      assertUrlAllowed(policy, url);
      const response = await (await ensureActive()).fetch(url);
      return new Uint8Array(await response.arrayBuffer());
    },
    funcs,
    registerLibcurl: (name, instance) => { instances.set(name, instance); },
    registerTransport: (name, transport) => { transports.set(name, transport); },
    registerWispTransport: (name, factory) => { wispTransports.set(name, factory); },
    cleanupForPid: (pid) => {
      exitedPids.add(pid);
      for (const [id, ownerPid] of fetches) if (ownerPid === pid) fetches.delete(id);
      for (const [id, record] of sockets) {
        if (record.pid !== pid) continue;
        sockets.delete(id);
        try { record.socket.close(); } catch { /* best-effort shutdown */ }
      }
      for (const [id, record] of tlsSockets) {
        if (record.pid !== pid) continue;
        tlsSockets.delete(id);
        try { record.socket.close(); } catch { /* best-effort shutdown */ }
      }
      for (const [id, record] of sessions) {
        if (record.pid !== pid) continue;
        sessions.delete(id);
        try { record.session.close(); } catch { /* best-effort shutdown */ }
      }
    },
  };
};
