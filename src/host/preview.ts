import type { LoopbackConnection, ProcessManager } from './process-manager';

export interface LoopbackRequest {
  method?: string;
  path?: string;
  headers?: Array<[string, string]> | Record<string, string>;
  body?: Uint8Array | ArrayBuffer | string | null;
  host?: string;
  timeoutMs?: number;
}

export interface LoopbackResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

const indexOfSequence = (haystack: Uint8Array, needle: number[], from = 0): number => {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};

const CRLF = [13, 10];
const CRLFCRLF = [13, 10, 13, 10];

interface ParsedHead {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  bodyStart: number;
}

const parseHead = (buffer: Uint8Array): ParsedHead | undefined => {
  const end = indexOfSequence(buffer, CRLFCRLF);
  if (end === -1) return undefined;
  const lines = decoder.decode(buffer.subarray(0, end)).split('\r\n');
  const statusLine = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/.exec(lines[0] ?? '');
  if (!statusLine) throw new Error(`Invalid HTTP response: ${lines[0]}`);
  const headers: Array<[string, string]> = [];
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return { status: Number(statusLine[1]), statusText: statusLine[2] ?? '', headers, bodyStart: end + 4 };
};

const decodeChunked = (body: Uint8Array): { done: boolean; data: Uint8Array } => {
  const parts: Uint8Array[] = [];
  let offset = 0;
  while (true) {
    const lineEnd = indexOfSequence(body, CRLF, offset);
    if (lineEnd === -1) return { done: false, data: new Uint8Array(0) };
    const size = parseInt(decoder.decode(body.subarray(offset, lineEnd)).split(';')[0]!.trim(), 16);
    if (Number.isNaN(size)) throw new Error('Invalid chunked encoding');
    const start = lineEnd + 2;
    if (size === 0) {
      const trailerEnd = indexOfSequence(body, CRLFCRLF, lineEnd);
      const done = trailerEnd !== -1 || (body.length >= start + 2 && body[start] === 13 && body[start + 1] === 10);
      if (!done) return { done: false, data: new Uint8Array(0) };
      let total = 0;
      for (const part of parts) total += part.length;
      const out = new Uint8Array(total);
      let at = 0;
      for (const part of parts) { out.set(part, at); at += part.length; }
      return { done: true, data: out };
    }
    if (body.length < start + size + 2) return { done: false, data: new Uint8Array(0) };
    parts.push(body.subarray(start, start + size));
    offset = start + size + 2;
  }
};

const headerEntries = (headers: LoopbackRequest['headers']): Array<[string, string]> => {
  if (!headers) return [];
  return Array.isArray(headers) ? headers : Object.entries(headers);
};

const requestBody = (body: LoopbackRequest['body']): Uint8Array => {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === 'string') return encoder.encode(body);
  return body instanceof Uint8Array ? body : new Uint8Array(body);
};

export const fetchLoopback = (pm: ProcessManager, port: number, request: LoopbackRequest = {}): Promise<LoopbackResponse> => {
  const method = (request.method ?? 'GET').toUpperCase();
  const path = request.path ?? '/';
  const host = request.host ?? 'localhost';
  const body = requestBody(request.body);
  let connection: LoopbackConnection;
  try {
    connection = pm.connectLoopback(port, host);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<LoopbackResponse>((resolve, reject) => {
    let buffer: Uint8Array = new Uint8Array(0);
    let head: ParsedHead | undefined;
    let settled = false;
    const finish = (error?: unknown, response?: LoopbackResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.close();
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(response!);
    };
    const timer = setTimeout(() => finish(new Error(`Loopback request to port ${port} timed out`)), request.timeoutMs ?? 30_000);
    const tryComplete = (ended: boolean): void => {
      try {
        head ??= parseHead(buffer);
        if (!head) {
          if (ended) finish(new Error('Connection closed before response headers'));
          return;
        }
        const raw = buffer.subarray(head.bodyStart);
        const lookup = (name: string): string | undefined => head!.headers.find(([key]) => key.toLowerCase() === name)?.[1];
        const noBody = method === 'HEAD' || head.status === 204 || head.status === 304 || (head.status >= 100 && head.status < 200);
        const respond = (data: Uint8Array): void => finish(undefined, {
          status: head!.status,
          statusText: head!.statusText,
          headers: head!.headers.filter(([key]) => !HOP_BY_HOP.has(key.toLowerCase())),
          body: data,
        });
        if (noBody) { respond(new Uint8Array(0)); return; }
        if ((lookup('transfer-encoding') ?? '').toLowerCase().includes('chunked')) {
          const decoded = decodeChunked(raw);
          if (decoded.done) respond(decoded.data);
          else if (ended) finish(new Error('Connection closed in the middle of a chunked response'));
          return;
        }
        const length = lookup('content-length');
        if (length !== undefined) {
          const expected = Number(length);
          if (raw.length >= expected) respond(raw.slice(0, expected));
          else if (ended) finish(new Error('Connection closed before the full response body arrived'));
          return;
        }
        if (ended) respond(raw.slice());
      } catch (error) {
        finish(error);
      }
    };
    connection.onData((chunk) => {
      buffer = concat(buffer, chunk);
      tryComplete(false);
    });
    connection.onEnd(() => tryComplete(true));
    connection.onError((message) => finish(new Error(message)));
    const headers = headerEntries(request.headers).filter(([key]) => {
      const lower = key.toLowerCase();
      return lower !== 'host' && lower !== 'connection' && lower !== 'content-length' && lower !== 'transfer-encoding';
    });
    let text = `${method} ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n`;
    for (const [key, value] of headers) text += `${key}: ${value}\r\n`;
    if (body.length > 0 || !['GET', 'HEAD', 'OPTIONS'].includes(method)) text += `Content-Length: ${body.length}\r\n`;
    text += '\r\n';
    connection.write(body.length > 0 ? concat(encoder.encode(text), body) : encoder.encode(text));
  });
};

export interface PreviewOptions {
  serviceWorkerUrl: string | URL;
  scope?: string;
  host?: string;
}

export interface PreviewHandle {
  readonly scope: string;
  url(port: number, path?: string): string;
  stop(options?: { unregister?: boolean }): Promise<void>;
}

interface PreviewRequestMessage {
  type: 'dusk-preview-request';
  port: number;
  method: string;
  path: string;
  headers: Array<[string, string]>;
  body?: ArrayBuffer;
}

const waitForActive = (registration: ServiceWorkerRegistration): Promise<ServiceWorker> => {
  if (registration.active) return Promise.resolve(registration.active);
  const worker = registration.installing ?? registration.waiting;
  if (!worker) return Promise.reject(new Error('Service worker registration has no worker'));
  return new Promise((resolve, reject) => {
    const onState = (): void => {
      if (worker.state === 'activated') {
        worker.removeEventListener('statechange', onState);
        resolve(worker);
      } else if (worker.state === 'redundant') {
        worker.removeEventListener('statechange', onState);
        reject(new Error('Service worker became redundant before activating'));
      }
    };
    worker.addEventListener('statechange', onState);
    onState();
  });
};

export const startPreview = async (pm: ProcessManager, options: PreviewOptions): Promise<PreviewHandle> => {
  const container = (globalThis as { navigator?: { serviceWorker?: ServiceWorkerContainer } }).navigator?.serviceWorker;
  if (!container) throw new Error('Service workers are not available in this context');
  const scriptUrl = new URL(String(options.serviceWorkerUrl), location.href);
  const scope = new URL(options.scope ?? './__dusk_preview__/', scriptUrl).pathname.replace(/\/?$/, '/');
  scriptUrl.searchParams.set('scope', scope);
  const registration = await container.register(scriptUrl.href, { scope });
  const worker = await waitForActive(registration);

  const onMessage = (event: MessageEvent): void => {
    const data = event.data as PreviewRequestMessage | undefined;
    if (data?.type !== 'dusk-preview-request') return;
    const replyPort = event.ports[0];
    if (!replyPort) return;
    void fetchLoopback(pm, data.port, {
      method: data.method,
      path: data.path,
      headers: data.headers,
      ...(data.body ? { body: data.body } : {}),
      ...(options.host ? { host: options.host } : {}),
    }).then(
      (response) => {
        const body = response.body.buffer.slice(response.body.byteOffset, response.body.byteOffset + response.body.byteLength) as ArrayBuffer;
        replyPort.postMessage({ status: response.status, statusText: response.statusText, headers: response.headers, body }, [body]);
      },
      (error: unknown) => {
        const code = (error as { code?: string }).code;
        replyPort.postMessage({ error: error instanceof Error ? error.message : String(error), refused: code === 'ECONNREFUSED' });
      },
    );
  };
  container.addEventListener('message', onMessage);
  const announce = (): void => { (registration.active ?? worker).postMessage({ type: 'dusk-preview-host' }); };
  announce();
  container.addEventListener('controllerchange', announce);

  return {
    scope,
    url: (port: number, path = '/') => new URL(`${scope}${port}${path.startsWith('/') ? path : '/' + path}`, location.origin).href,
    stop: async (stopOptions = {}) => {
      container.removeEventListener('message', onMessage);
      container.removeEventListener('controllerchange', announce);
      if (stopOptions.unregister) await registration.unregister();
    },
  };
};
