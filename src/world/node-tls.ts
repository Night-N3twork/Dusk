import { Duplex } from './node-stream';
import { EventEmitter } from './node-events';
import { Socket, registerIncomingServer, unregisterIncomingServer } from './node-net';

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

interface RawTLSSocket {
  onopen: (() => void) | null;
  onmessage: ((data: Uint8Array) => void) | null;
  onclose: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}

interface TLSConnectOptions {
  host?: string;
  port: number;
  allowHalfOpen?: boolean;
  proxy?: unknown;
  [key: string]: unknown;
}

interface PendingWrite {
  data: Uint8Array;
  callback: (error?: Error | null) => void;
}

// Nova's outbound Rustls bridge uses the platform trust store and does not
// expose TLS configuration or server-side TLS. Reject these rather than
// silently claiming Node-compatible support.
const UNSUPPORTED_OPTIONS = [
  'ca', 'cert', 'key', 'pfx', 'passphrase', 'crl', 'rejectUnauthorized', 'servername', 'secureContext',
  'minVersion', 'maxVersion', 'secureProtocol', 'secureOptions', 'sigalgs', 'ecdhCurve',
  'ALPNProtocols', 'session', 'enableTrace', 'minDHSize', 'clientCertEngine', 'privateKeyEngine', 'privateKeyIdentifier',
  'requestOCSP', 'allowPartialTrustChain', 'checkServerIdentity', 'pskCallback', 'ALPNCallback', 'SNICallback',
  'keylog', 'ciphers',
] as const;

const SUPPORTED_OPTIONS = new Set(['host', 'port', 'allowHalfOpen', 'proxy']);

const bytes = (chunk: unknown): Uint8Array => {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  if (Array.isArray(chunk)) return Uint8Array.from(chunk);
  throw new TypeError('TLS socket writes must be strings or Uint8Array instances');
};

export class SecureContext {
  readonly context: Record<string, unknown> = {};
}

export const createSecureContext = (options: Record<string, unknown> = {}): SecureContext => {
  for (const name of UNSUPPORTED_OPTIONS) {
    if (options[name] !== undefined) throw new Error(`browser TLS does not support ${name}`);
  }
  return new SecureContext();
};

const unsupportedOptions = (options: TLSConnectOptions): void => {
  for (const name of Object.keys(options)) {
    if (name === 'secureContext' && options[name] instanceof SecureContext) continue;
    if (!SUPPORTED_OPTIONS.has(name)) throw new Error(`browser TLS does not support ${name}`);
  }
  for (const name of UNSUPPORTED_OPTIONS) {
    if (name === 'secureContext' && options[name] instanceof SecureContext) continue;
    if (options[name] !== undefined) throw new Error(`browser TLS does not support ${name}`);
  }
};

const rawConstructor = (): (new (host: string, port: number, options?: { proxy: unknown }) => RawTLSSocket) => {
  const dusk = (globalThis as Record<string, unknown>)['dusk'] as { libcurl?: { TLSSocket?: new (host: string, port: number, options?: { proxy: unknown }) => RawTLSSocket } } | undefined;
  const TLSSocket = dusk?.libcurl?.TLSSocket;
  if (!TLSSocket) throw new Error('browser TLS is not supported by the active LibCurl instance');
  return TLSSocket;
};

export class TLSSocket extends Duplex {
  encrypted = true;
  authorized = false;
  authorizationError: Error | null = null;
  connecting = true;
  readonly servername: string;
  private raw: RawTLSSocket;
  private terminal = false;
  private opened = false;
  private pendingWrites: PendingWrite[] = [];
  private pendingFinal: ((error?: Error | null) => void) | undefined;

  constructor(host: string, port: number, allowHalfOpen = false, rawOptions?: { proxy: unknown }) {
    super({
      allowHalfOpen,
      write: (chunk, _encoding, callback) => {
        try {
          const data = bytes(chunk);
          if (this.terminal) throw new Error('TLS socket is closed');
          if (!this.opened) {
            this.pendingWrites.push({ data, callback });
            return;
          }
          this.raw.send(data);
          callback();
        } catch (error) {
          callback(error as Error);
        }
      },
      final: (callback) => {
        if (!this.opened && !this.terminal) {
          this.pendingFinal = callback;
          return;
        }
        this.closeAfterFinal(callback);
      },
    });
    this.servername = host;
    this.raw = new (rawConstructor())(host, port, rawOptions);
    this.raw.onopen = () => {
      if (this.terminal) return;
      this.opened = true;
      this.connecting = false;
      this.authorized = true;
      this.flushWrites();
      this.emit('secureConnect');
      if (this.pendingFinal) {
        const callback = this.pendingFinal;
        this.pendingFinal = undefined;
        this.closeAfterFinal(callback);
      }
    };
    this.raw.onmessage = (data) => this.push(data);
    this.raw.onclose = () => this.closeReadable();
    this.raw.onerror = (error) => this.fail(error instanceof Error ? error : new Error(String(error)));
  }

  override destroy(error?: Error | null): this {
    if (this.terminal) return this;
    this.terminal = true;
    this.connecting = false;
    if (!this.opened) this.authorized = false;
    this.failPending(error ?? new Error('TLS socket destroyed'));
    try { this.raw.close(); } catch { /* best-effort bridge shutdown */ }
    if (error) this.emit('error', error);
    // Duplex.destroy(error) emits through both its writable and readable
    // halves. The facade has already emitted the single public error above.
    return super.destroy();
  }

  private flushWrites(): void {
    while (this.pendingWrites.length > 0 && !this.terminal) {
      const pending = this.pendingWrites.shift()!;
      try {
        this.raw.send(pending.data);
        pending.callback();
      } catch (error) {
        pending.callback(error as Error);
      }
    }
  }

  private closeAfterFinal(callback: (error?: Error | null) => void): void {
    if (this.terminal) { callback(); return; }
    this.terminal = true;
    this.connecting = false;
    try {
      this.raw.close();
      this.push(null);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  private closeReadable(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.connecting = false;
    if (!this.opened) this.authorized = false;
    this.failPending(new Error('TLS socket closed'));
    const writable = this as unknown as { writableEnded: boolean; end(): unknown };
    if (!this.allowHalfOpen && !writable.writableEnded) writable.end();
    this.push(null);
  }

  private fail(error: Error): void {
    if (this.terminal) return;
    this.terminal = true;
    this.connecting = false;
    this.authorized = false;
    this.authorizationError = error;
    this.failPending(error);
    // Duplex forwards writable errors separately, so emit once before a
    // no-error destroy schedules the single readable-side close.
    this.emit('error', error);
    super.destroy();
  }

  private failPending(error: Error): void {
    while (this.pendingWrites.length > 0) {
      this.pendingWrites.shift()!.callback(error);
    }
    if (this.pendingFinal) {
      const callback = this.pendingFinal;
      this.pendingFinal = undefined;
      callback(error);
    }
  }
}

export const connect = (
  options: TLSConnectOptions | number,
  hostOrCallback?: string | (() => void),
  callback?: () => void,
): TLSSocket => {
  let host = 'localhost';
  let port: number;
  let onSecureConnect: (() => void) | undefined;
  let allowHalfOpen = false;
  let rawOptions: { proxy: unknown } | undefined;

  if (typeof options === 'number') {
    port = options;
    if (typeof hostOrCallback === 'string') host = hostOrCallback;
    if (typeof hostOrCallback === 'function') onSecureConnect = hostOrCallback;
    if (callback) onSecureConnect = callback;
  } else {
    unsupportedOptions(options);
    port = options.port;
    host = options.host ?? host;
    allowHalfOpen = options.allowHalfOpen ?? false;
    if (options.proxy !== undefined) rawOptions = { proxy: options.proxy };
    if (typeof hostOrCallback === 'function') onSecureConnect = hostOrCallback;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('TLS connection port must be an integer between 1 and 65535');

  const socket = new TLSSocket(host, port, allowHalfOpen, rawOptions);
  if (onSecureConnect) socket.once('secureConnect', onSecureConnect);
  return socket;
};

interface TlsServerOptions {
  cert: string | Uint8Array;
  key: string | Uint8Array;
  [key: string]: unknown;
}

const serverOptions = (options: unknown): TlsServerOptions => {
  if (!options || typeof options !== 'object') throw new TypeError('TLS server options must include cert and key');
  const value = options as TlsServerOptions;
  if (value.cert === undefined || value.key === undefined) throw new TypeError('TLS server options must include cert and key');
  for (const name of Object.keys(value)) {
    if (name !== 'cert' && name !== 'key') throw new Error(`browser TLS server does not support ${name}`);
  }
  return value;
};

export class Server extends EventEmitter {
  private serverId = -1;
  private host = '0.0.0.0';
  private port = 0;
  listening = false;

  constructor(private readonly options: TlsServerOptions, listener?: (socket: Socket) => void) {
    super();
    if (listener) this.on('secureConnection', listener as unknown as (...args: unknown[]) => void);
  }

  listen(...args: unknown[]): this {
    let host = this.host;
    let port = 0;
    let callback: (() => void) | undefined;
    for (const arg of args) {
      if (typeof arg === 'number') port = arg;
      else if (typeof arg === 'string') host = arg;
      else if (typeof arg === 'function') callback = arg as () => void;
      else if (arg && typeof arg === 'object') {
        const options = arg as { host?: string; port?: number };
        host = options.host ?? host;
        port = options.port ?? port;
      }
    }
    try {
      const result = ipc.send({ f: 'net.tls.listen', host, port, cert: this.options.cert, key: this.options.key }).value as { serverId: number; address: string; port: number };
      if (!result) throw new Error('Nova TLS server capability is not supported by the active relay host');
      this.serverId = result.serverId;
      this.host = result.address;
      this.port = result.port;
      this.listening = true;
      registerIncomingServer(this.serverId, (socket) => this.accept(socket), (error) => {
        this.emit('tlsClientError', error);
        this.emit('error', error);
      });
      Promise.resolve().then(() => { this.emit('listening'); callback?.(); });
    } catch (error) {
      Promise.resolve().then(() => this.emit('error', error));
    }
    return this;
  }

  close(callback?: (error?: Error) => void): this {
    if (!this.listening) { callback?.(new Error('ERR_SERVER_NOT_RUNNING')); return this; }
    try { ipc.send({ f: 'net.tls.unlisten', serverId: this.serverId }); } catch { /* close is best-effort */ }
    unregisterIncomingServer(this.serverId);
    this.listening = false;
    Promise.resolve().then(() => { this.emit('close'); callback?.(); });
    return this;
  }

  address(): { address: string; port: number; family: string } | null {
    return this.listening ? { address: this.host, port: this.port, family: 'IPv4' } : null;
  }

  ref(): this { return this; }
  unref(): this { return this; }

  private accept(socket: Socket): void {
    (socket as Socket & { encrypted?: boolean }).encrypted = true;
    this.emit('connection', socket);
    this.emit('secureConnection', socket);
  }
}

export const createServer = (options: TlsServerOptions, listener?: (socket: Socket) => void): Server =>
  {
    const capability = ipc.send({ f: 'net.tls.capability' });
    if (capability.value !== true) throw new Error('browser TLS does not support TLS servers');
    return new Server(serverOptions(options), listener);
  };

export const nodeTls = { TLSSocket, Server, SecureContext, connect, createServer, createSecureContext };
