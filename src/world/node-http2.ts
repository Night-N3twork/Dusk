import { EventEmitter } from './node-events';

const unsupported = (what: string): Error => {
  const error = new Error(`${what} is not supported in Dusk: browsers do not expose raw HTTP/2 framing`);
  (error as Error & { code?: string }).code = 'ERR_HTTP2_UNSUPPORTED';
  return error;
};

export const constants: Record<string, string | number> = {
  NGHTTP2_SESSION_SERVER: 0,
  NGHTTP2_SESSION_CLIENT: 1,
  NGHTTP2_NO_ERROR: 0,
  NGHTTP2_PROTOCOL_ERROR: 1,
  NGHTTP2_INTERNAL_ERROR: 2,
  NGHTTP2_CANCEL: 8,
  HTTP2_HEADER_STATUS: ':status',
  HTTP2_HEADER_METHOD: ':method',
  HTTP2_HEADER_AUTHORITY: ':authority',
  HTTP2_HEADER_SCHEME: ':scheme',
  HTTP2_HEADER_PATH: ':path',
  HTTP2_HEADER_PROTOCOL: ':protocol',
  HTTP2_HEADER_CONTENT_TYPE: 'content-type',
  HTTP2_HEADER_CONTENT_LENGTH: 'content-length',
  HTTP2_METHOD_GET: 'GET',
  HTTP2_METHOD_POST: 'POST',
  HTTP2_METHOD_PUT: 'PUT',
  HTTP2_METHOD_DELETE: 'DELETE',
  HTTP_STATUS_OK: 200,
  HTTP_STATUS_NOT_FOUND: 404,
  HTTP_STATUS_INTERNAL_SERVER_ERROR: 500,
};

export const sensitiveHeaders = Symbol('nodejs.http2.sensitiveHeaders');

export const getDefaultSettings = (): Record<string, number | boolean> => ({
  headerTableSize: 4096,
  enablePush: true,
  initialWindowSize: 65535,
  maxFrameSize: 16384,
  maxConcurrentStreams: 4294967295,
  maxHeaderListSize: 65535,
  enableConnectProtocol: false,
});

export const getPackedSettings = (_settings?: Record<string, unknown>): Uint8Array => new Uint8Array(0);
export const getUnpackedSettings = (_buffer: Uint8Array): Record<string, unknown> => ({});

class Http2Server extends EventEmitter {
  listen(..._args: unknown[]): this {
    queueMicrotask(() => this.emit('error', unsupported('http2 servers')));
    return this;
  }
  close(callback?: () => void): this {
    if (callback) queueMicrotask(callback);
    return this;
  }
}

export const createServer = (..._args: unknown[]): Http2Server => new Http2Server();
export const createSecureServer = createServer;

export const connect = (authority: string, ..._args: unknown[]): EventEmitter => {
  const session = new EventEmitter() as EventEmitter & { close: () => void; destroy: () => void; request: () => never };
  session.close = (): void => undefined;
  session.destroy = (): void => undefined;
  session.request = (): never => { throw unsupported('http2.connect'); };
  queueMicrotask(() => session.emit('error', unsupported(`http2.connect(${String(authority)})`)));
  return session;
};

export const nodeHttp2 = {
  constants,
  sensitiveHeaders,
  getDefaultSettings,
  getPackedSettings,
  getUnpackedSettings,
  createServer,
  createSecureServer,
  connect,
};
