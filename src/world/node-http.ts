import { EventEmitter } from './node-events';
import { Writable, Readable } from './node-stream';
import { Socket, createConnection, Server as NetServer } from './node-net';
import { createServer as createTlsServer, type Server as TlsServer } from './node-tls';
import { HttpParser, type HttpHeadersInfo } from './http-parser';
import { errnoError } from './node-errors';
import { Buffer } from './node-buffer';

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };
const __call = (f: string, extra: Record<string, unknown> = {}): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) {
    const mt = /^([A-Z_]+):/.exec(r.error);
    const code = mt && mt[1] ? mt[1] : 'UNKNOWN';
    const syscall = f.replace(/^http\./, '');
    throw errnoError(code, syscall, undefined, r.error);
  }
  return r.value;
};

const STATUS_CODES: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols', 102: 'Processing', 103: 'Early Hints',
  200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information',
  204: 'No Content', 205: 'Reset Content', 206: 'Partial Content',
  300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
  304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable',
  408: 'Request Timeout', 409: 'Conflict', 410: 'Gone', 411: 'Length Required',
  413: 'Payload Too Large', 414: 'URI Too Long', 415: 'Unsupported Media Type',
  418: "I'm a Teapot", 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout', 505: 'HTTP Version Not Supported',
};

const METHODS = [
  'ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD',
  'LINK', 'LOCK', 'M-SEARCH', 'MERGE', 'MKACTIVITY', 'MKCALENDAR', 'MKCOL',
  'MOVE', 'NOTIFY', 'OPTIONS', 'PATCH', 'POST', 'PRI', 'PROPFIND', 'PROPPATCH',
  'PURGE', 'PUT', 'QUERY', 'REBIND', 'REPORT', 'SEARCH', 'SOURCE', 'SUBSCRIBE',
  'TRACE', 'UNBIND', 'UNLINK', 'UNLOCK', 'UNSUBSCRIBE',
];

const encodeUtf8 = (str: string): Uint8Array => {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
};

// ---- IncomingMessage ----

export class IncomingMessage extends Readable {
  httpVersion = '1.1';
  httpVersionMajor = 1;
  httpVersionMinor = 1;
  headers: Record<string, string> = {};
  rawHeaders: string[] = [];
  trailers: Record<string, string> = {};
  rawTrailers: string[] = [];
  method: string | undefined = undefined;
  url: string | undefined = undefined;
  statusCode: number | undefined = undefined;
  statusMessage: string | undefined = undefined;
  socket: Socket;
  complete = false;

  constructor(socket: Socket) {
    super({ read: () => undefined });
    this.socket = socket;
  }

  setTimeout(ms: number, cb?: () => void): this {
    this.socket.setTimeout(ms, cb);
    return this;
  }
}

// ---- OutgoingMessage / ServerResponse / ClientRequest ----

const HeaderMethods = {
  formatHeaders(headers: Record<string, string | string[]>): string {
    let s = '';
    for (const [k, v] of Object.entries(headers)) {
      if (Array.isArray(v)) for (const item of v) s += `${k}: ${item}\r\n`;
      else s += `${k}: ${v}\r\n`;
    }
    return s;
  },
};

class OutgoingMessage extends Writable {
  protected _headers: Record<string, string | string[]> = {};
  protected _headersSent = false;
  socket: Socket | null = null;
  finished = false;

  constructor() {
    super({ write: (_chunk, _enc, cb) => cb(), final: (cb) => cb() });
  }

  setHeader(name: string, value: string | number | string[]): this {
    this._headers[name] = Array.isArray(value) ? value : String(value);
    return this;
  }

  getHeader(name: string): string | string[] | undefined {
    const lname = name.toLowerCase();
    for (const k of Object.keys(this._headers)) if (k.toLowerCase() === lname) return this._headers[k];
    return undefined;
  }

  removeHeader(name: string): void {
    const lname = name.toLowerCase();
    for (const k of Object.keys(this._headers)) if (k.toLowerCase() === lname) delete this._headers[k];
  }

  hasHeader(name: string): boolean {
    return this.getHeader(name) !== undefined;
  }

  getHeaderNames(): string[] {
    return Object.keys(this._headers);
  }

  getHeaders(): Record<string, string | string[]> {
    return { ...this._headers };
  }

  flushHeaders(): void {
    // Subclasses implement
  }
}

export class ServerResponse extends OutgoingMessage {
  statusCode = 200;
  statusMessage = '';
  sendDate = true;
  private shouldKeepAlive: boolean;
  private chunked = false;
  private requestMethod: string;

  constructor(socket: Socket, shouldKeepAlive = true, requestMethod = 'GET') {
    super();
    this.socket = socket;
    this.shouldKeepAlive = shouldKeepAlive;
    this.requestMethod = requestMethod;
  }

  writeHead(status: number, statusMessageOrHeaders?: string | Record<string, string | string[]>, headers?: Record<string, string | string[]>): this {
    this.statusCode = status;
    let extra: Record<string, string | string[]> | undefined;
    if (typeof statusMessageOrHeaders === 'string') {
      this.statusMessage = statusMessageOrHeaders;
      extra = headers;
    } else {
      extra = statusMessageOrHeaders;
    }
    if (extra) for (const [k, v] of Object.entries(extra)) this._headers[k] = v;
    return this;
  }

  override write(chunk: unknown, encOrCb?: string | ((err?: Error | null) => void), maybeCb?: (err?: Error | null) => void): boolean {
    if (!this._headersSent) this._sendHeaders(true);
    const data = this._toBytes(chunk);
    if (!this.socket) return false;
    this._writeBody(data);
    const cb = typeof encOrCb === 'function' ? encOrCb : maybeCb;
    if (cb) cb();
    return true;
  }

  override end(chunkOrCb?: unknown, encOrCb?: string | (() => void), maybeCb?: () => void): this {
    if (typeof chunkOrCb !== 'undefined' && typeof chunkOrCb !== 'function') {
      if (!this._headersSent) {
        if (!this.hasHeader('content-length') && !this.hasHeader('transfer-encoding')) {
          const data = this._toBytes(chunkOrCb);
          this.setHeader('Content-Length', String(data.length));
          this._sendHeaders();
          this._writeBody(data);
        } else {
          this._sendHeaders();
          this._writeBody(this._toBytes(chunkOrCb));
        }
      } else {
        this._writeBody(this._toBytes(chunkOrCb));
      }
    } else if (!this._headersSent) {
      if (!this.hasHeader('content-length') && !this.hasHeader('transfer-encoding') && this._contentLengthAllowed()) this.setHeader('Content-Length', '0');
      this._sendHeaders();
    }
    if (this.chunked && this.socket && this._bodyAllowed()) this.socket.write(encodeUtf8('0\r\n\r\n'));
    this.finished = true;
    const cb = typeof chunkOrCb === 'function' ? chunkOrCb as () => void : (typeof encOrCb === 'function' ? encOrCb : maybeCb);
    if (this.socket && !this.shouldKeepAlive) this.socket.end();
    this.emit('finish');
    if (cb) cb();
    return this;
  }

  private _sendHeaders(streaming = false): void {
    if (this._headersSent || !this.socket) return;
    if (!this.shouldKeepAlive) {
      this.removeHeader('connection');
      this.setHeader('Connection', 'close');
    }
    if (!this._bodyAllowed()) {
      this.removeHeader('transfer-encoding');
      if (!this._contentLengthAllowed()) this.removeHeader('content-length');
    } else if (streaming && !this.hasHeader('content-length') && !this.hasHeader('transfer-encoding')) {
      this.setHeader('Transfer-Encoding', 'chunked');
    }
    const transferEncoding = this.getHeader('transfer-encoding');
    this.chunked = transferEncoding !== undefined && /(?:^|,)\s*chunked\s*(?:,|$)/i.test(Array.isArray(transferEncoding) ? transferEncoding.join(',') : transferEncoding);
    this._headersSent = true;
    const msg = this.statusMessage || STATUS_CODES[this.statusCode] || '';
    let head = `HTTP/1.1 ${this.statusCode} ${msg}\r\n`;
    if (this.sendDate && !this.hasHeader('date')) head += `Date: ${new Date().toUTCString()}\r\n`;
    head += HeaderMethods.formatHeaders(this._headers);
    head += '\r\n';
    this.socket.write(encodeUtf8(head));
  }

  private _writeBody(data: Uint8Array): void {
    if (!this.socket || !this._bodyAllowed()) return;
    if (this.chunked) {
      this.socket.write(encodeUtf8(`${data.length.toString(16)}\r\n`));
      this.socket.write(data);
      this.socket.write(encodeUtf8('\r\n'));
      return;
    }
    this.socket.write(data);
  }

  private _bodyAllowed(): boolean {
    return this.requestMethod !== 'HEAD' && this.statusCode !== 204 && this.statusCode !== 304 && (this.statusCode < 100 || this.statusCode >= 200);
  }

  private _contentLengthAllowed(): boolean {
    return this.statusCode !== 204 && (this.statusCode < 100 || this.statusCode >= 200);
  }

  private _toBytes(chunk: unknown): Uint8Array {
    if (chunk instanceof Uint8Array) return chunk;
    if (typeof chunk === 'string') return encodeUtf8(chunk);
    if (chunk == null) return new Uint8Array(0);
    return encodeUtf8(String(chunk));
  }
}

export class ClientRequest extends OutgoingMessage {
  method: string;
  path: string;
  host: string;
  port: number;
  protocol: string;

  private _bodyChunks: Uint8Array[] = [];

  constructor(opts: RequestOptions, cb?: (res: IncomingMessage) => void) {
    super();
    this.method = (opts.method ?? 'GET').toUpperCase();
    this.host = opts.host ?? opts.hostname ?? '127.0.0.1';
    this.path = opts.path ?? '/';
    this.protocol = opts.protocol ?? 'http:';
    this.port = opts.port ?? (this.protocol === 'https:' ? 443 : 80);
    if (opts.headers) for (const [k, v] of Object.entries(opts.headers)) this._headers[k] = v as string;
    if (!this.hasHeader('host')) this.setHeader('Host', this.host + (this.port !== 80 && this.port !== 443 ? ':' + this.port : ''));
    if (cb) this.once('response', cb as unknown as (...args: unknown[]) => void);
  }

  override write(chunk: unknown, encOrCb?: string | ((err?: Error | null) => void), maybeCb?: (err?: Error | null) => void): boolean {
    this._bodyChunks.push(this._toBytes(chunk));
    const cb = typeof encOrCb === 'function' ? encOrCb : maybeCb;
    if (cb) cb();
    return true;
  }

  override end(chunkOrCb?: unknown, encOrCb?: string | (() => void), maybeCb?: () => void): this {
    if (typeof chunkOrCb !== 'undefined' && typeof chunkOrCb !== 'function') {
      this._bodyChunks.push(this._toBytes(chunkOrCb));
    }
    this._send();
    const cb = typeof chunkOrCb === 'function' ? chunkOrCb as () => void : (typeof encOrCb === 'function' ? encOrCb : maybeCb);
    if (cb) cb();
    return this;
  }

  private _toBytes(chunk: unknown): Uint8Array {
    if (chunk instanceof Uint8Array) return chunk;
    if (typeof chunk === 'string') return encodeUtf8(chunk);
    return new Uint8Array(0);
  }

  private _send(): void {
    let totalLen = 0;
    for (const c of this._bodyChunks) totalLen += c.length;
    if (totalLen > 0 && !this.hasHeader('content-length') && !this.hasHeader('transfer-encoding')) {
      this.setHeader('Content-Length', String(totalLen));
    }

    // Check if there's a loopback server registered for this host:port.
    let hasLoopback = false;
    try {
      hasLoopback = __call('net.hasLoopback', { host: this.host, port: this.port }) === true;
    } catch { /* */ }
    if (!hasLoopback) {
      this._sendViaFetch();
      return;
    }

    const socket = createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.on('connect', () => {
      let head = `${this.method} ${this.path} HTTP/1.1\r\n`;
      head += HeaderMethods.formatHeaders(this._headers);
      head += '\r\n';
      socket.write(encodeUtf8(head));
      for (const c of this._bodyChunks) socket.write(c);
    });

    const parser = new HttpParser('RESPONSE');
    let res: IncomingMessage | null = null;
    parser.onHeadersComplete = (info: HttpHeadersInfo) => {
      res = new IncomingMessage(socket);
      res.httpVersionMajor = info.versionMajor;
      res.httpVersionMinor = info.versionMinor;
      res.httpVersion = `${info.versionMajor}.${info.versionMinor}`;
      res.statusCode = info.statusCode;
      res.statusMessage = info.statusMessage;
      res.rawHeaders = info.headers;
      for (let i = 0; i + 1 < info.headers.length; i += 2) {
        res.headers[info.headers[i]!.toLowerCase()] = info.headers[i + 1]!;
      }
      this.emit('response', res);
    };
    parser.onBody = (chunk) => { if (res) res.push(Buffer.from(chunk)); };
    parser.onMessageComplete = () => { if (res) { res.complete = true; res.push(null); } };
    parser.onError = (err) => { this.emit('error', err); };

    socket.on('data', (...args) => {
      const buf = args[0];
      if (buf instanceof Uint8Array) parser.execute(buf);
    });
    socket.on('end', () => { parser.finish(); if (res) res.push(null); });
    socket.on('error', (...args) => { this.emit('error', args[0] as Error); });
  }

  private _sendViaFetch(): void {
    // Collect body
    let totalLen = 0;
    for (const c of this._bodyChunks) totalLen += c.length;
    const body = new Uint8Array(totalLen);
    let off = 0;
    for (const c of this._bodyChunks) { body.set(c, off); off += c.length; }

    // Build URL
    const scheme = this.protocol.replace(':', '');
    const portPart = (this.port === 80 && scheme === 'http') || (this.port === 443 && scheme === 'https') ? '' : ':' + this.port;
    const url = `${scheme}://${this.host}${portPart}${this.path}`;

    // Build headers; filter out Host (fetch sets it) and Content-Length (fetch sets it from body)
    const fetchHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(this._headers)) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'content-length') continue;
      fetchHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }

    // Make fake socket so res.socket works
    const fakeSocket = {} as Socket;
    this.socket = fakeSocket;

    // Synchronous IPC fetch
    try {
      const result = __call('http.fetchRequest', {
        url,
        method: this.method,
        headers: fetchHeaders,
        body,
      }) as {
        status: number;
        statusText: string;
        headers: string[];
        body: number[];
      };

      const res = new IncomingMessage(fakeSocket);
      res.statusCode = result.status;
      res.statusMessage = result.statusText;
      res.rawHeaders = result.headers;
      for (let i = 0; i + 1 < result.headers.length; i += 2) {
        res.headers[result.headers[i]!.toLowerCase()] = result.headers[i + 1]!;
      }

      // Emit response on next microtask so caller can attach data handlers first
      Promise.resolve().then(() => {
        this.emit('response', res);
        // Push body bytes (may be empty)
        Promise.resolve().then(() => {
          if (result.body.length > 0) res.push(Uint8Array.from(result.body));
          res.complete = true;
          res.push(null);
        });
      });
    } catch (e) {
      Promise.resolve().then(() => this.emit('error', e));
    }
  }
}

// ---- Server ----

export interface RequestOptions {
  host?: string;
  hostname?: string;
  port?: number;
  method?: string;
  path?: string;
  protocol?: string;
  headers?: Record<string, string | string[]>;
  agent?: unknown;
  ca?: unknown;
  cert?: unknown;
  key?: unknown;
  pfx?: unknown;
  passphrase?: unknown;
  crl?: unknown;
  rejectUnauthorized?: boolean;
  servername?: string;
  secureContext?: unknown;
  minVersion?: unknown;
  maxVersion?: unknown;
  secureProtocol?: unknown;
  secureOptions?: unknown;
  sigalgs?: unknown;
  ecdhCurve?: unknown;
  ALPNProtocols?: unknown;
  session?: unknown;
  enableTrace?: unknown;
  minDHSize?: unknown;
  clientCertEngine?: unknown;
  privateKeyEngine?: unknown;
  privateKeyIdentifier?: unknown;
  requestOCSP?: unknown;
  allowPartialTrustChain?: unknown;
  checkServerIdentity?: unknown;
  pskCallback?: unknown;
  ALPNCallback?: unknown;
  SNICallback?: unknown;
  keylog?: unknown;
  ciphers?: unknown;
  timeout?: number;
}

export class Server extends EventEmitter {
  private _net: NetServer;
  timeout = 0;
  keepAliveTimeout = 5000;

  constructor(opts?: unknown, requestListener?: (req: IncomingMessage, res: ServerResponse) => void) {
    super();
    let listener = requestListener;
    if (typeof opts === 'function') listener = opts as (req: IncomingMessage, res: ServerResponse) => void;
    this._net = new NetServer({}, (socket) => this._onConnection(socket));
    if (listener) this.on('request', listener as unknown as (...args: unknown[]) => void);
  }

  listen(...args: unknown[]): this {
    const cb = args.find((a) => typeof a === 'function') as (() => void) | undefined;
    this._net.on('listening', () => {
      this.emit('listening');
      if (cb) cb();
    });
    this._net.on('error', (...errArgs) => this.emit('error', errArgs[0]));
    this._net.listen(...args.filter((a) => typeof a !== 'function'));
    return this;
  }

  close(cb?: (err?: Error) => void): this {
    this._net.close(cb);
    this.emit('close');
    return this;
  }

  address(): { port: number; address: string; family: string } | null {
    return this._net.address();
  }

  ref(): this {
    this._net.ref();
    return this;
  }

  unref(): this {
    this._net.unref();
    return this;
  }

  _onConnection(socket: Socket): void {
    const parser = new HttpParser('REQUEST');
    let req: IncomingMessage | null = null;
    let res: ServerResponse | null = null;
    let upgradeReq: IncomingMessage | null = null;

    parser.onHeadersComplete = (info: HttpHeadersInfo) => {
      req = new IncomingMessage(socket);
      req.httpVersionMajor = info.versionMajor;
      req.httpVersionMinor = info.versionMinor;
      req.httpVersion = `${info.versionMajor}.${info.versionMinor}`;
      req.method = info.method;
      req.url = info.url;
      req.rawHeaders = info.headers;
      for (let i = 0; i + 1 < info.headers.length; i += 2) {
        req.headers[info.headers[i]!.toLowerCase()] = info.headers[i + 1]!;
      }
      if (info.upgrade) {
        upgradeReq = req;
        return 2;
      }
      res = new ServerResponse(socket, info.shouldKeepAlive, info.method);
      this.emit('request', req, res);
    };
    parser.onBody = (chunk) => { if (req) req.push(Buffer.from(chunk)); };
    parser.onMessageComplete = () => { if (req) { req.complete = true; req.push(null); } };
    parser.onError = (err) => { this.emit('clientError', err, socket); };

    socket.on('data', (...args) => {
      const buf = args[0];
      if (!(buf instanceof Uint8Array) || upgradeReq) return;
      parser.execute(buf);
      if (upgradeReq) {
        const handled = this.emit('upgrade', upgradeReq, socket, Buffer.from(parser.takeRemaining()));
        if (!handled) socket.destroy();
      }
    });
    socket.on('end', () => parser.finish());
    socket.on('error', (...args) => this.emit('clientError', args[0], socket));
  }
}

export const createServer = (opts?: unknown, listener?: (req: IncomingMessage, res: ServerResponse) => void): Server => {
  return new Server(opts, listener);
};

const HTTPS_UNSUPPORTED_OPTIONS = [
  'ca', 'cert', 'key', 'pfx', 'passphrase', 'crl', 'rejectUnauthorized', 'servername', 'secureContext',
  'minVersion', 'maxVersion', 'secureProtocol', 'secureOptions', 'sigalgs', 'ecdhCurve',
  'ALPNProtocols', 'session', 'enableTrace', 'minDHSize', 'clientCertEngine', 'privateKeyEngine', 'privateKeyIdentifier',
  'requestOCSP', 'allowPartialTrustChain',
  'checkServerIdentity', 'pskCallback', 'ALPNCallback', 'SNICallback', 'keylog', 'ciphers',
] as const;

const assertBrowserHttpsOptions = (opts: RequestOptions, isHttps = opts.protocol === 'https:'): void => {
  if (!isHttps) return;
  for (const name of HTTPS_UNSUPPORTED_OPTIONS) {
    if (opts[name] !== undefined) throw new Error(`browser HTTPS does not support ${name}`);
  }
  if (opts.agent != null && opts.agent !== false && opts.agent !== globalAgent) {
    throw new Error('browser HTTPS does not support agent');
  }
};

export const request = (urlOrOpts: string | RequestOptions, optsOrCb?: RequestOptions | ((res: IncomingMessage) => void), maybeCb?: (res: IncomingMessage) => void): ClientRequest => {
  let opts: RequestOptions;
  let cb: ((res: IncomingMessage) => void) | undefined;
  if (typeof urlOrOpts === 'string') {
    const u = new URL(urlOrOpts);
    opts = {
      host: u.hostname,
      port: parseInt(u.port || (u.protocol === 'https:' ? '443' : '80'), 10),
      path: u.pathname + u.search,
      protocol: u.protocol,
    };
    if (typeof optsOrCb === 'object' && optsOrCb !== null) Object.assign(opts, optsOrCb);
    if (typeof optsOrCb === 'function') cb = optsOrCb;
    else if (maybeCb) cb = maybeCb;
  } else {
    opts = urlOrOpts;
    if (typeof optsOrCb === 'function') cb = optsOrCb;
  }
  assertBrowserHttpsOptions(opts);
  const req = new ClientRequest(opts, cb);
  return req;
};

export const get = (urlOrOpts: string | RequestOptions, optsOrCb?: RequestOptions | ((res: IncomingMessage) => void), maybeCb?: (res: IncomingMessage) => void): ClientRequest => {
  const req = request(urlOrOpts, optsOrCb, maybeCb);
  req.end();
  return req;
};

const httpsRequest = (urlOrOpts: string | URL | RequestOptions, optsOrCb?: RequestOptions | ((res: IncomingMessage) => void), maybeCb?: (res: IncomingMessage) => void): ClientRequest => {
  if (typeof urlOrOpts === 'string' || urlOrOpts instanceof URL) {
    if (typeof optsOrCb === 'object' && optsOrCb !== null) assertBrowserHttpsOptions(optsOrCb, true);
    return request(String(urlOrOpts), optsOrCb, maybeCb);
  }
  const opts = { ...urlOrOpts, protocol: urlOrOpts.protocol ?? 'https:' };
  assertBrowserHttpsOptions(opts, true);
  return request(opts, optsOrCb, maybeCb);
};

const httpsGet = (urlOrOpts: string | URL | RequestOptions, optsOrCb?: RequestOptions | ((res: IncomingMessage) => void), maybeCb?: (res: IncomingMessage) => void): ClientRequest => {
  const req = httpsRequest(urlOrOpts, optsOrCb, maybeCb);
  req.end();
  return req;
};

const httpsCreateServer = (opts?: unknown, listener?: (req: IncomingMessage, res: ServerResponse) => void): TlsServer => {
  let tls: TlsServer;
  try {
    tls = createTlsServer(opts as { cert: string | Uint8Array; key: string | Uint8Array });
  } catch (error) {
    if (error instanceof Error && error.message === 'browser TLS does not support TLS servers') {
      throw new Error('browser HTTPS does not support TLS servers');
    }
    throw error;
  }
  const http = new Server({}, listener);
  tls.on('connection', (socket) => http._onConnection(socket as Socket));
  return tls;
};

export class Agent {
  maxSockets = Infinity;
  maxFreeSockets = 256;
  keepAlive = false;
  keepAliveMsecs = 1000;
  constructor(opts?: { keepAlive?: boolean; keepAliveMsecs?: number; maxSockets?: number; maxFreeSockets?: number }) {
    if (opts) Object.assign(this, opts);
  }
  destroy(): void { /* */ }
}

export const globalAgent = new Agent();

export const nodeHttp = {
  STATUS_CODES,
  METHODS,
  Server,
  ServerResponse,
  IncomingMessage,
  ClientRequest,
  Agent,
  globalAgent,
  createServer,
  request,
  get,
};

export const nodeHttps = {
  ...nodeHttp,
  createServer: httpsCreateServer,
  request: httpsRequest,
  get: httpsGet,
};
