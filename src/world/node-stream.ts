// node:stream — minimal but functional in-engine implementation.
//
// Provides Readable, Writable, Duplex, Transform, PassThrough with:
//   - flowing + paused modes for Readable
//   - highWaterMark + drain backpressure for Writable
//   - pipe() with auto-end forwarding
//   - destroy() with error propagation
//   - object mode
//   - 'data' / 'end' / 'error' / 'close' / 'drain' / 'finish' / 'readable' events
//
// This is NOT byte-for-byte Node-equivalent on every internal field, but
// it satisfies typical library expectations (req/res, fs streams, gzip
// transforms, child_process stdio).

import { EventEmitter } from './node-events';

const queueMicrotaskShim = (fn: () => void): void => {
  const g = globalThis as { queueMicrotask?: (f: () => void) => void };
  if (typeof g.queueMicrotask === 'function') g.queueMicrotask(fn);
  else Promise.resolve().then(fn);
};

// ---- Readable ----

export interface ReadableOptions {
  highWaterMark?: number;
  objectMode?: boolean;
  encoding?: string | null;
  read?: (this: Readable, size: number) => void;
  destroy?: (this: Readable, err: Error | null, cb: (err?: Error | null) => void) => void;
}

export class Readable extends EventEmitter {
  readable = true;
  destroyed = false;
  readableEnded = false;
  readableFlowing: boolean | null = null;
  readableObjectMode: boolean;
  readableHighWaterMark: number;
  readableLength = 0;

  private _buffer: unknown[] = [];
  private _ended = false;
  private _pushable = true;
  private _encoding: string | null;
  private _userRead?: (this: Readable, size: number) => void;
  private _userDestroy?: (this: Readable, err: Error | null, cb: (err?: Error | null) => void) => void;
  private _emittedReadable = false;

  constructor(options: ReadableOptions = {}) {
    super();
    this.readableObjectMode = !!options.objectMode;
    this.readableHighWaterMark = options.highWaterMark ?? (this.readableObjectMode ? 16 : 16 * 1024);
    this._encoding = options.encoding ?? null;
    if (options.read) this._userRead = options.read;
    if (options.destroy) this._userDestroy = options.destroy;
  }

  _read(_size: number): void {
    if (this._userRead) this._userRead.call(this, _size);
  }

  push(chunk: unknown, encoding?: string): boolean {
    if (this._ended) {
      this.emit('error', new Error('stream.push() after EOF'));
      return false;
    }
    if (chunk === null) {
      this._ended = true;
      this._maybeEmitEnd();
      return false;
    }
    if (chunk === undefined) return this._pushable;
    let normalized = chunk;
    if (typeof chunk === 'string' && !this.readableObjectMode) {
      const g = globalThis as Record<string, unknown>;
      const Buffer = g['Buffer'] as undefined | { from(s: string, e?: string): Uint8Array };
      if (Buffer) normalized = Buffer.from(chunk, encoding ?? 'utf8');
    }
    this._buffer.push(normalized);
    this.readableLength += this.readableObjectMode ? 1 : ((normalized as Uint8Array).length ?? 1);
    this._pushable = this.readableLength < this.readableHighWaterMark;

    if (this.readableFlowing) {
      this._flushFlow();
    } else if (!this._emittedReadable) {
      this._emittedReadable = true;
      queueMicrotaskShim(() => {
        this._emittedReadable = false;
        this.emit('readable');
      });
    }
    return this._pushable;
  }

  read(size?: number): unknown {
    if (this._buffer.length === 0) {
      try { this._read(size ?? this.readableHighWaterMark); } catch (e) { queueMicrotaskShim(() => this.emit('error', e)); }
      if (this._buffer.length === 0) {
        if (this._ended) this._maybeEmitEnd();
        return null;
      }
    }
    if (this.readableObjectMode) {
      const item = this._buffer.shift();
      this.readableLength--;
      this._pushable = this.readableLength < this.readableHighWaterMark;
      if (this._buffer.length === 0 && this._ended) this._maybeEmitEnd();
      return item;
    }
    // byte mode: concat into a single Buffer up to `size`
    const want = size ?? this.readableLength;
    let total = 0;
    const parts: Uint8Array[] = [];
    while (this._buffer.length > 0 && total < want) {
      const next = this._buffer[0] as Uint8Array;
      if (total + next.length <= want) {
        parts.push(next);
        total += next.length;
        this._buffer.shift();
      } else {
        const take = want - total;
        parts.push(next.subarray(0, take));
        this._buffer[0] = next.subarray(take);
        total = want;
        break;
      }
    }
    this.readableLength -= total;
    this._pushable = this.readableLength < this.readableHighWaterMark;
    if (parts.length === 0) {
      if (this._ended) this._maybeEmitEnd();
      return null;
    }
    let out: Uint8Array;
    if (parts.length === 1) out = parts[0]!;
    else {
      out = new Uint8Array(total);
      let off = 0;
      for (const p of parts) { out.set(p, off); off += p.length; }
    }
    if (this._encoding) {
      const g = globalThis as Record<string, unknown>;
      const Buffer = g['Buffer'] as undefined | { from(b: Uint8Array): { toString(enc: string): string } };
      if (Buffer) return Buffer.from(out).toString(this._encoding);
    }
    if (this._buffer.length === 0 && this._ended) this._maybeEmitEnd();
    return out;
  }

  setEncoding(enc: string | null): this {
    this._encoding = enc;
    return this;
  }

  pause(): this {
    if (this.readableFlowing !== false) {
      this.readableFlowing = false;
      this.emit('pause');
    }
    return this;
  }

  resume(): this {
    if (this.readableFlowing !== true) {
      this.readableFlowing = true;
      this.emit('resume');
      if (this._buffer.length === 0 && !this._ended) this._read(this.readableHighWaterMark);
      this._flushFlow();
    }
    return this;
  }

  isPaused(): boolean {
    return this.readableFlowing === false;
  }

  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    super.on(event, listener);
    if (event === 'data' && this.readableFlowing === null) {
      this.resume();
    }
    return this;
  }

  private _flushFlow(): void {
    while (this.readableFlowing && this._buffer.length > 0) {
      const chunk = this.read();
      if (chunk === null) break;
      this.emit('data', chunk);
    }
    if (this._buffer.length === 0 && this._ended) this._maybeEmitEnd();
  }

  private _maybeEmitEnd(): void {
    if (this.readableEnded) return;
    if (!this._ended || this._buffer.length > 0) return;
    this.readableEnded = true;
    this.readable = false;
    queueMicrotaskShim(() => {
      this.emit('end');
      queueMicrotaskShim(() => this.emit('close'));
    });
  }

  pipe<T extends Writable>(dest: T, opts?: { end?: boolean }): T {
    const autoEnd = opts?.end !== false;
    const onData = (...args: unknown[]): void => {
      const chunk = args[0];
      const ok = dest.write(chunk as Uint8Array | string);
      if (!ok) this.pause();
    };
    const onDrain = (): void => { this.resume(); };
    const onEnd = (): void => {
      cleanup();
      if (autoEnd) dest.end();
    };
    const onError = (...args: unknown[]): void => {
      cleanup();
      dest.destroy(args[0] as Error);
    };
    const cleanup = (): void => {
      this.off('data', onData);
      this.off('end', onEnd);
      this.off('error', onError);
      dest.off('drain', onDrain);
    };
    this.on('data', onData);
    this.on('end', onEnd);
    this.on('error', onError);
    dest.on('drain', onDrain);
    return dest;
  }

  unpipe(_dest?: Writable): this {
    // Best-effort: removeAllListeners('data')/'end' won't disturb other listeners.
    // For a minimal impl we leave pipe management to the caller.
    return this;
  }

  destroy(err?: Error | null): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.readable = false;
    if (this._userDestroy) {
      this._userDestroy.call(this, err ?? null, (e) => {
        if (e) this.emit('error', e);
        queueMicrotaskShim(() => this.emit('close'));
      });
    } else {
      if (err) queueMicrotaskShim(() => this.emit('error', err));
      queueMicrotaskShim(() => this.emit('close'));
    }
    return this;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
    const self = this;
    const queue: unknown[] = [];
    const waiters: Array<{ resolve: (v: IteratorResult<unknown>) => void; reject: (e: unknown) => void }> = [];
    let done = false;
    let errVal: unknown = null;
    self.on('data', (c) => {
      if (waiters.length) waiters.shift()!.resolve({ value: c, done: false });
      else queue.push(c);
    });
    self.on('end', () => {
      done = true;
      while (waiters.length) waiters.shift()!.resolve({ value: undefined, done: true });
    });
    self.on('error', (e) => {
      errVal = e;
      done = true;
      while (waiters.length) waiters.shift()!.reject(e);
    });
    return {
      [Symbol.asyncIterator](): AsyncIterableIterator<unknown> { return this; },
      next(): Promise<IteratorResult<unknown>> {
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        if (errVal) return Promise.reject(errVal);
        if (done) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<unknown>>((resolve, reject) => waiters.push({ resolve, reject }));
      },
      return(): Promise<IteratorResult<unknown>> {
        done = true;
        self.destroy();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  static from(iter: Iterable<unknown> | AsyncIterable<unknown>, opts?: ReadableOptions): Readable {
    const r = new Readable({ objectMode: true, ...opts });
    void (async () => {
      try {
        for await (const v of iter as AsyncIterable<unknown>) r.push(v);
        r.push(null);
      } catch (e) { r.destroy(e as Error); }
    })();
    return r;
  }
}

// ---- Writable ----

export interface WritableOptions {
  highWaterMark?: number;
  objectMode?: boolean;
  decodeStrings?: boolean;
  defaultEncoding?: string;
  write?: (this: Writable, chunk: unknown, encoding: string, cb: (err?: Error | null) => void) => void;
  writev?: (this: Writable, chunks: Array<{ chunk: unknown; encoding: string }>, cb: (err?: Error | null) => void) => void;
  final?: (this: Writable, cb: (err?: Error | null) => void) => void;
  destroy?: (this: Writable, err: Error | null, cb: (err?: Error | null) => void) => void;
}

export class Writable extends EventEmitter {
  writable = true;
  destroyed = false;
  writableEnded = false;
  writableFinished = false;
  writableObjectMode: boolean;
  writableHighWaterMark: number;
  writableLength = 0;
  writableNeedDrain = false;

  private _userWrite?: (this: Writable, chunk: unknown, encoding: string, cb: (err?: Error | null) => void) => void;
  private _userFinal?: (this: Writable, cb: (err?: Error | null) => void) => void;
  private _userDestroy?: (this: Writable, err: Error | null, cb: (err?: Error | null) => void) => void;
  private _writing = false;
  private _queue: Array<{ chunk: unknown; encoding: string; cb: (err?: Error | null) => void }> = [];
  private _decodeStrings: boolean;
  private _defaultEncoding: string;
  private _endingCb: ((err?: Error | null) => void) | undefined = undefined;
  // cork counter: while >0, _drain is a no-op so queued writes accumulate.
  private _corkLevel = 0;
  get writableCorked(): number { return this._corkLevel; }

  constructor(options: WritableOptions = {}) {
    super();
    this.writableObjectMode = !!options.objectMode;
    this.writableHighWaterMark = options.highWaterMark ?? (this.writableObjectMode ? 16 : 16 * 1024);
    this._decodeStrings = options.decodeStrings ?? true;
    this._defaultEncoding = options.defaultEncoding ?? 'utf8';
    if (options.write) this._userWrite = options.write;
    if (options.final) this._userFinal = options.final;
    if (options.destroy) this._userDestroy = options.destroy;
  }

  _write(_chunk: unknown, _encoding: string, cb: (err?: Error | null) => void): void {
    if (this._userWrite) this._userWrite.call(this, _chunk, _encoding, cb);
    else cb();
  }

  _final(cb: (err?: Error | null) => void): void {
    if (this._userFinal) this._userFinal.call(this, cb);
    else cb();
  }

  write(chunk: unknown, encOrCb?: string | ((err?: Error | null) => void), maybeCb?: (err?: Error | null) => void): boolean {
    if (this.writableEnded || this.destroyed) {
      const e = new Error('write after end');
      (e as Error & { code?: string }).code = 'ERR_STREAM_WRITE_AFTER_END';
      const callback = typeof encOrCb === 'function' ? encOrCb : maybeCb;
      if (callback) queueMicrotaskShim(() => callback(e));
      else queueMicrotaskShim(() => this.emit('error', e));
      return false;
    }
    let encoding = this._defaultEncoding;
    let cb: ((err?: Error | null) => void) | undefined;
    if (typeof encOrCb === 'string') encoding = encOrCb;
    else if (typeof encOrCb === 'function') cb = encOrCb;
    if (maybeCb) cb = maybeCb;

    let processedChunk = chunk;
    if (this._decodeStrings && typeof chunk === 'string' && !this.writableObjectMode) {
      const g = globalThis as Record<string, unknown>;
      const Buffer = g['Buffer'] as undefined | { from(s: string, e?: string): Uint8Array };
      if (Buffer) processedChunk = Buffer.from(chunk, encoding);
    }

    const len = this.writableObjectMode ? 1 : ((processedChunk as Uint8Array).length ?? 1);
    this.writableLength += len;
    this._queue.push({ chunk: processedChunk, encoding, cb: cb ?? (() => undefined) });
    this._drain();
    if (this.writableLength >= this.writableHighWaterMark) {
      this.writableNeedDrain = true;
      return false;
    }
    return true;
  }

  private _drain(): void {
    if (this._writing) return;
    if (this._corkLevel > 0) return;
    const item = this._queue.shift();
    if (!item) {
      if (this.writableNeedDrain) {
        this.writableNeedDrain = false;
        queueMicrotaskShim(() => this.emit('drain'));
      }
      if (this._endingCb) {
        const cb = this._endingCb;
        this._endingCb = undefined;
        this._doFinal(cb);
      }
      return;
    }
    this._writing = true;
    try {
      this._write(item.chunk, item.encoding, (err) => {
        this._writing = false;
        const len = this.writableObjectMode ? 1 : ((item.chunk as Uint8Array).length ?? 1);
        this.writableLength -= len;
        if (err) {
          try { item.cb(err); } catch { /* */ }
          this.destroy(err);
          return;
        }
        try { item.cb(); } catch { /* */ }
        this._drain();
      });
    } catch (e) {
      this._writing = false;
      this.destroy(e as Error);
    }
  }

  end(chunkOrCb?: unknown, encOrCb?: string | (() => void), maybeCb?: () => void): this {
    let chunk: unknown;
    let encoding = this._defaultEncoding;
    let cb: (() => void) | undefined;
    if (typeof chunkOrCb === 'function') cb = chunkOrCb as () => void;
    else chunk = chunkOrCb;
    if (typeof encOrCb === 'string') encoding = encOrCb;
    else if (typeof encOrCb === 'function') cb = encOrCb;
    if (maybeCb) cb = maybeCb;

    if (chunk !== undefined) this.write(chunk, encoding);
    this.writableEnded = true;
    this._endingCb = (err) => {
      this.writableFinished = true;
      this.writable = false;
      if (err) {
        this.emit('error', err);
      } else {
        this.emit('finish');
      }
      queueMicrotaskShim(() => this.emit('close'));
      if (cb) cb();
    };
    if (this._queue.length === 0 && !this._writing && this._corkLevel === 0) {
      const ec = this._endingCb;
      this._endingCb = undefined;
      this._doFinal(ec);
    }
    return this;
  }

  private _doFinal(cb: (err?: Error | null) => void): void {
    try { this._final(cb); }
    catch (e) { cb(e as Error); }
  }

  cork(): void { this._corkLevel++; }
  uncork(): void {
    if (this._corkLevel === 0) return;
    this._corkLevel--;
    if (this._corkLevel === 0) {
      queueMicrotaskShim(() => this._drain());
    }
  }
  setDefaultEncoding(enc: string): this { this._defaultEncoding = enc; return this; }

  destroy(err?: Error | null): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.writable = false;
    if (this._userDestroy) {
      this._userDestroy.call(this, err ?? null, (e) => {
        if (e) this.emit('error', e);
        queueMicrotaskShim(() => this.emit('close'));
      });
    } else {
      if (err) queueMicrotaskShim(() => this.emit('error', err));
      queueMicrotaskShim(() => this.emit('close'));
    }
    return this;
  }
}

// ---- Duplex ----

export interface DuplexOptions {
  highWaterMark?: number;
  objectMode?: boolean;
  encoding?: string | null;
  read?: (this: Readable, size: number) => void;
  write?: (this: Writable, chunk: unknown, encoding: string, cb: (err?: Error | null) => void) => void;
  writev?: (this: Writable, chunks: Array<{ chunk: unknown; encoding: string }>, cb: (err?: Error | null) => void) => void;
  final?: (this: Writable, cb: (err?: Error | null) => void) => void;
  decodeStrings?: boolean;
  defaultEncoding?: string;
  allowHalfOpen?: boolean;
  readableObjectMode?: boolean;
  writableObjectMode?: boolean;
}

export class Duplex extends Readable {
  allowHalfOpen: boolean;
  private _w: Writable;

  constructor(opts: DuplexOptions = {}) {
    super(opts);
    this.allowHalfOpen = opts.allowHalfOpen ?? true;
    this._w = new Writable(opts);
    // Re-export writable APIs
    const passthrough = (name: keyof Writable): void => {
      (this as unknown as Record<string, unknown>)[name as string] = (...args: unknown[]) => (this._w as unknown as Record<string, Function>)[name as string]!(...args);
    };
    passthrough('write');
    passthrough('end');
    passthrough('cork');
    passthrough('uncork');
    passthrough('setDefaultEncoding');
    Object.defineProperties(this, {
      writable: { get: () => this._w.writable, configurable: true },
      writableEnded: { get: () => this._w.writableEnded, configurable: true },
      writableFinished: { get: () => this._w.writableFinished, configurable: true },
      writableLength: { get: () => this._w.writableLength, configurable: true },
      writableHighWaterMark: { get: () => this._w.writableHighWaterMark, configurable: true },
      writableObjectMode: { get: () => this._w.writableObjectMode, configurable: true },
      writableNeedDrain: { get: () => this._w.writableNeedDrain, configurable: true },
    });
    this._w.on('drain', () => this.emit('drain'));
    this._w.on('finish', () => this.emit('finish'));
    this._w.on('error', (err) => this.emit('error', err));
  }

  override destroy(err?: Error | null): this {
    this._w.destroy();
    return super.destroy(err);
  }
}

// ---- Transform ----

export interface TransformOptions extends DuplexOptions {
  transform?: (this: Transform, chunk: unknown, encoding: string, cb: (err?: Error | null, data?: unknown) => void) => void;
  flush?: (this: Transform, cb: (err?: Error | null, data?: unknown) => void) => void;
}

export class Transform extends Duplex {
  private _userTransform?: (this: Transform, chunk: unknown, encoding: string, cb: (err?: Error | null, data?: unknown) => void) => void;
  private _userFlush?: (this: Transform, cb: (err?: Error | null, data?: unknown) => void) => void;

  constructor(opts: TransformOptions = {}) {
    super({
      ...opts,
      write: (chunk, encoding, cb) => {
        this._transform(chunk, encoding, (err, data) => {
          if (err) cb(err);
          else {
            if (data !== undefined && data !== null) this.push(data);
            cb();
          }
        });
      },
      final: (cb) => {
        if (this._userFlush) {
          this._userFlush.call(this, (err, data) => {
            if (err) return cb(err);
            if (data !== undefined && data !== null) this.push(data);
            this.push(null);
            cb();
          });
        } else {
          this.push(null);
          cb();
        }
      },
    });
    if (opts.transform) this._userTransform = opts.transform;
    if (opts.flush) this._userFlush = opts.flush;
  }

  _transform(chunk: unknown, encoding: string, cb: (err?: Error | null, data?: unknown) => void): void {
    if (this._userTransform) this._userTransform.call(this, chunk, encoding, cb);
    else cb(null, chunk);
  }

  _flush(cb: (err?: Error | null, data?: unknown) => void): void {
    if (this._userFlush) this._userFlush.call(this, cb);
    else cb();
  }
}

// ---- PassThrough ----

export class PassThrough extends Transform {
  constructor(opts: TransformOptions = {}) {
    super({ ...opts, transform: (chunk, _enc, cb) => cb(null, chunk) });
  }
}

// ---- pipeline / finished helpers ----

export const finished = (
  stream: Readable | Writable,
  cb: (err?: Error | null) => void,
): (() => void) => {
  let done = false;
  const onEnd = (): void => { if (!done) { done = true; cb(); } };
  const onFinish = onEnd;
  const onClose = onEnd;
  const onError = (...args: unknown[]): void => { if (!done) { done = true; cb(args[0] as Error); } };
  stream.on('end', onEnd);
  stream.on('finish', onFinish);
  stream.on('close', onClose);
  stream.on('error', onError);
  return () => {
    stream.off('end', onEnd);
    stream.off('finish', onFinish);
    stream.off('close', onClose);
    stream.off('error', onError);
  };
};

export const pipeline = (...args: unknown[]): Promise<void> | unknown => {
  const streams: Array<Readable | Writable> = [];
  let cb: ((err?: Error | null, value?: unknown) => void) | undefined;
  for (const a of args) {
    if (typeof a === 'function' && !(a instanceof Readable) && !(a instanceof Writable)) {
      cb = a as (e?: Error | null) => void;
    } else {
      streams.push(a as Readable | Writable);
    }
  }
  const runPipeline = (): Promise<void> => new Promise<void>((resolve, reject) => {
    let pending = streams.length;
    let errored = false;
    const onErr = (err: Error): void => {
      if (errored) return;
      errored = true;
      for (const s of streams) (s as Readable).destroy?.(err);
      reject(err);
      if (cb) cb(err);
    };
    for (let i = 0; i < streams.length - 1; i++) {
      (streams[i] as Readable).pipe(streams[i + 1] as Writable);
    }
    for (const s of streams) {
      finished(s, (err) => {
        if (err) onErr(err);
        else if (--pending === 0) { resolve(); if (cb) cb(null); }
      });
    }
  });
  if (cb) { void runPipeline().catch(() => undefined); return undefined; }
  return runPipeline();
};

export const nodeStream = {
  Readable,
  Writable,
  Duplex,
  Transform,
  PassThrough,
  finished,
  pipeline,
  default: undefined as unknown,
};
(nodeStream as { default: unknown }).default = nodeStream;

export const nodeStreamPromises = {
  finished: (stream: Readable | Writable): Promise<void> => new Promise((resolve, reject) => {
    finished(stream, (error) => error ? reject(error) : resolve());
  }),
  pipeline: (...streams: Array<Readable | Writable>): Promise<void> => pipeline(...streams) as Promise<void>,
};
(nodeStream as Record<string, unknown>)['promises'] = nodeStreamPromises;
