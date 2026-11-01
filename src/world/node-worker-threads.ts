import { EventEmitter } from './node-events';

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };
declare const __DUSK_PID__: number | undefined;

const __call = (f: string, extra: Record<string, unknown> = {}): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) {
    const e = new Error(r.error);
    const m = /^([A-Z_]+):/.exec(r.error);
    if (m && m[1]) (e as Error & { code?: string }).code = m[1];
    throw e;
  }
  return r.value;
};

const _isMainThread = !(globalThis as Record<string, unknown>)['__DUSK_WORKER_DATA__'];
const _workerData = (_isMainThread ? null : (globalThis as Record<string, unknown>)['__DUSK_WORKER_DATA__']) as unknown;
const _threadId = (typeof __DUSK_PID__ !== 'undefined' && __DUSK_PID__ !== undefined) ? __DUSK_PID__ : 0;

// Worker child tracking (parent side)
const _workersByPid = new Map<number, Worker>();

// In each engine, install the dispatch hook so host can push worker messages.
(globalThis as Record<string, unknown>)['__worker'] = {
  dispatchMessage(targetPid: number, fromPid: number, data: unknown): void {
    if (_isMainThread) {
      const w = _workersByPid.get(fromPid);
      if (w) w._handleMessageFromWorker(data);
    } else {
      if (_parentPort) _parentPort._handleMessageFromParent(data);
    }
  },
  dispatchExit(pid: number, code: number): void {
    const w = _workersByPid.get(pid);
    if (w) w._handleExit(code);
  },
  dispatchError(pid: number, msg: string): void {
    const w = _workersByPid.get(pid);
    if (w) w._handleError(new Error(msg));
  },
};

// ---- MessagePort ----

export class MessagePort extends EventEmitter {
  private _other: MessagePort | null = null;
  private _started = false;
  private _queued: unknown[] = [];

  postMessage(value: unknown, _transferList?: unknown[]): void {
    if (this._other) {
      Promise.resolve().then(() => this._other?._deliver(value));
    }
  }

  _deliver(value: unknown): void {
    if (this._started || this.listenerCount('message') > 0) {
      this.emit('message', value);
    } else {
      this._queued.push(value);
    }
  }

  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    super.on(event, listener);
    if (event === 'message' && !this._started) this.start();
    return this;
  }

  start(): void {
    if (this._started) return;
    this._started = true;
    const queued = this._queued.splice(0);
    for (const v of queued) Promise.resolve().then(() => this.emit('message', v));
  }

  close(): void {
    this._started = false;
    this.emit('close');
  }

  ref(): void { /* */ }
  unref(): void { /* */ }
}

const linkPorts = (a: MessagePort, b: MessagePort): void => {
  (a as unknown as { _other: MessagePort })._other = b;
  (b as unknown as { _other: MessagePort })._other = a;
};

export class MessageChannel {
  port1: MessagePort;
  port2: MessagePort;
  constructor() {
    this.port1 = new MessagePort();
    this.port2 = new MessagePort();
    linkPorts(this.port1, this.port2);
  }
}

// ---- parentPort ----

let _parentPort: ParentPort | null = null;

class ParentPort extends EventEmitter {
  private _started = false;
  private _queued: unknown[] = [];

  postMessage(value: unknown, _transferList?: unknown[]): void {
    try {
      __call('worker.postToParent', { data: value });
    } catch { /* */ }
  }

  _handleMessageFromParent(value: unknown): void {
    if (this._started || this.listenerCount('message') > 0) this.emit('message', value);
    else this._queued.push(value);
  }

  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    super.on(event, listener);
    if (event === 'message' && !this._started) {
      this._started = true;
      const queued = this._queued.splice(0);
      for (const v of queued) Promise.resolve().then(() => this.emit('message', v));
    }
    return this;
  }

  close(): void {
    this.emit('close');
  }

  ref(): void { /* */ }
  unref(): void { /* */ }
}

if (!_isMainThread) {
  _parentPort = new ParentPort();
}

// ---- Worker (parent-side) ----

export interface WorkerOptions {
  workerData?: unknown;
  env?: Record<string, string>;
  argv?: unknown[];
  execArgv?: string[];
  stdin?: boolean;
  stdout?: boolean;
  stderr?: boolean;
  eval?: boolean;
  resourceLimits?: unknown;
  transferList?: unknown[];
  trackUnmanagedFds?: boolean;
  name?: string;
}

export class Worker extends EventEmitter {
  threadId = 0;
  resourceLimits: Record<string, number> = {};
  performance: { eventLoopUtilization: () => Record<string, number> } = { eventLoopUtilization: () => ({}) };
  stdin: null = null;
  stdout: null = null;
  stderr: null = null;
  private _exited = false;

  constructor(filename: string, opts: WorkerOptions = {}) {
    super();
    try {
      const result = __call('worker.spawn', {
        filename,
        workerData: opts.workerData ?? null,
        env: opts.env ?? null,
        evalMode: opts.eval === true,
      }) as { pid: number };
      this.threadId = result.pid;
      _workersByPid.set(result.pid, this);
      Promise.resolve().then(() => this.emit('online'));
    } catch (e) {
      Promise.resolve().then(() => this.emit('error', e));
    }
  }

  postMessage(value: unknown, _transferList?: unknown[]): void {
    try {
      __call('worker.postToChild', { pid: this.threadId, data: value });
    } catch { /* */ }
  }

  terminate(): Promise<number> {
    if (this._exited) return Promise.resolve(0);
    try {
      __call('worker.terminate', { pid: this.threadId });
    } catch { /* */ }
    return new Promise<number>((resolve) => {
      this.once('exit', (...args) => resolve((args[0] as number) ?? 0));
    });
  }

  _handleMessageFromWorker(data: unknown): void {
    this.emit('message', data);
  }

  _handleExit(code: number): void {
    if (this._exited) return;
    this._exited = true;
    this.emit('exit', code);
    _workersByPid.delete(this.threadId);
  }

  _handleError(err: Error): void {
    this.emit('error', err);
  }

  ref(): void { /* */ }
  unref(): void { /* */ }

  getHeapSnapshot(): Promise<unknown> {
    return Promise.resolve({});
  }
}

// ---- Module surface ----

export const isMainThread = _isMainThread;
export const threadId = _threadId;
export const parentPort = _parentPort;
export const workerData = _workerData;

export const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV');

export const setEnvironmentData = (_key: string | symbol, _value: unknown): void => undefined;
export const getEnvironmentData = (_key: string | symbol): unknown => undefined;
export const markAsUntransferable = (_v: unknown): void => undefined;
export const moveMessagePortToContext = (port: MessagePort, _ctx: object): MessagePort => port;
export const receiveMessageOnPort = (_port: MessagePort): { message: unknown } | undefined => undefined;

export const BroadcastChannel = class BroadcastChannel extends EventEmitter {
  readonly name: string;
  constructor(name: string) { super(); this.name = name; }
  postMessage(_v: unknown): void { /* */ }
  close(): void { /* */ }
  ref(): void { /* */ }
  unref(): void { /* */ }
};

export const nodeWorkerThreads = {
  Worker,
  MessageChannel,
  MessagePort,
  BroadcastChannel,
  isMainThread,
  threadId,
  parentPort,
  workerData,
  SHARE_ENV,
  setEnvironmentData,
  getEnvironmentData,
  markAsUntransferable,
  moveMessagePortToContext,
  receiveMessageOnPort,
};
