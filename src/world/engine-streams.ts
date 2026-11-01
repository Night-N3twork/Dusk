// Engine-side stream bridge.
//
// When the host creates a "stream sink" for this engine (via stream.registerSink
// IPC), chunks arriving from the host are dispatched into the global
// __streams.dispatch hook installed by this module. It routes them to the
// Readable instance associated with the stream ID.

import { Readable, Writable } from './node-stream';

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const __call = (f: string, extra: Record<string, unknown> = {}): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) throw new Error(r.error);
  return r.value;
};

// Mirror of STREAM_INITIAL_WINDOW in src/host/stream-registry.ts.
// Keep in sync. If you change one, change both. Tested in stream-backpressure.test.ts.
const STREAM_INITIAL_WINDOW = 64 * 1024;

interface StreamSink {
  readable: Readable;
}

const sinks = new Map<number, StreamSink>();

// Writables (engine → host direction) park here when credit is exhausted.
// Keyed by stream id; each waiter is a resolver that unparks a `write` cb.
const writableWaiters = new Map<number, Array<() => void>>();

// Install the global dispatch hook. The host pushes data into the engine by
// emitting JS that calls __streams.dispatch(id, kind, payload).
(globalThis as Record<string, unknown>)['__streams'] = {
  dispatch(id: number, kind: 'chunk' | 'end' | 'error' | 'creditGranted', payload?: unknown): void {
    if (kind === 'creditGranted') {
      const waiters = writableWaiters.get(id);
      if (waiters) {
        writableWaiters.delete(id);
        for (const w of waiters) w();
      }
      return;
    }
    const sink = sinks.get(id);
    if (!sink) return;
    if (kind === 'chunk') {
      const bytes = payload as number[];
      sink.readable.push(Uint8Array.from(bytes));
    } else if (kind === 'end') {
      sink.readable.push(null);
      sinks.delete(id);
    } else if (kind === 'error') {
      sink.readable.destroy(new Error(String(payload)));
      sinks.delete(id);
    }
  },
};

/**
 * Allocate a new stream ID host-side and register a Readable to receive its chunks.
 * Returns the stream ID and the Readable that will receive chunks.
 */
export const createStreamSink = (producerPid?: number): { id: number; readable: Readable } => {
  const result = __call('stream.allocate') as { id: number };
  const id = result.id;

  let pendingGrant = 0;
  let flushScheduled = false;
  const flushGrant = (): void => {
    if (pendingGrant === 0) return;
    const amount = pendingGrant;
    pendingGrant = 0;
    flushScheduled = false;
    try { __call('stream.grantCredit', { id, amount }); } catch { /* engine teardown */ }
  };
  const scheduleFlush = (): void => {
    if (flushScheduled) return;
    flushScheduled = true;
    // Microtask coalescing — collapse many small reads into one IPC.
    Promise.resolve().then(flushGrant);
  };

  const readable = new Readable({
    read(): void {
      // Called by the Readable machinery when downstream drains.
      // We grant credit equal to what we just released downstream.
      // _read does not tell us the released byte count directly, so we
      // track it via the wrapped push (see below).
    },
  });

  // Wrap push so we know when bytes leave the engine-internal buffer
  // toward the consumer. Each successful push of N bytes => N bytes of
  // headroom we can give back to the host.
  const origPush = readable.push.bind(readable);
  readable.push = (chunk: Uint8Array | null, ...rest: unknown[]): boolean => {
    if (chunk && chunk.byteLength > 0) {
      pendingGrant += chunk.byteLength;
      scheduleFlush();
    }
    return (origPush as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
  };

  sinks.set(id, { readable });
  __call('stream.registerSink', { id, producerPid: producerPid ?? 0 });
  return { id, readable };
};

/**
 * Push a chunk to a stream from this engine (acting as producer).
 * Returns the remaining host-side credit (bytes) after this chunk was accepted.
 * When the returned value is <= 0 the producer should park until a
 * `creditGranted` dispatch fires for this stream id.
 */
export const pushStreamChunk = (id: number, data: Uint8Array): number => {
  const v = __call('stream.pushChunk', { id, data }) as { credit: number };
  return v.credit;
};

/**
 * Signal end-of-stream from this engine.
 */
export const pushStreamEnd = (id: number): void => {
  __call('stream.pushEnd', { id });
};

/**
 * Signal an error on the stream from this engine.
 */
export const pushStreamError = (id: number, message: string): void => {
  __call('stream.pushError', { id, message });
};

/**
 * Wrap a stream ID as a Writable that pushes chunks via the registry when written to.
 *
 * Backpressure: each `pushStreamChunk` returns the host's remaining credit.
 * When credit is exhausted (<= 0) the `write` callback is parked until a
 * `stream.creditGranted` dispatch arrives from the host (see the `__streams`
 * hook above). This lets a slow host-side consumer throttle a fast engine
 * producer, symmetric to `createStreamSink`'s host→engine direction.
 */
export const createStreamWritable = (id: number): Writable => {
  let localCredit = STREAM_INITIAL_WINDOW; // mirrors host initial window
  void localCredit; // referenced by symmetry with plan; actual gate uses the fresh return value below
  return new Writable({
    write(chunk, _enc, cb) {
      const bytes = chunk instanceof Uint8Array
        ? chunk
        : Uint8Array.from(typeof chunk === 'string'
            ? Array.from(chunk as string).map((c) => (c as string).charCodeAt(0) & 0xff)
            : []);
      try {
        localCredit = pushStreamChunk(id, bytes);
        if (localCredit > 0) {
          cb();
        } else {
          // Park until the host dispatches creditGranted for this id.
          const waiters = writableWaiters.get(id) ?? [];
          waiters.push(() => cb());
          writableWaiters.set(id, waiters);
        }
      } catch (e) { cb(e as Error); }
    },
    final(cb) {
      try { pushStreamEnd(id); cb(); } catch (e) { cb(e as Error); }
    },
  });
};
