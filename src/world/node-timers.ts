// node:timers — thin wrapper around globals.
// node:timers/promises lives at the bottom.

type STFn = (handler: Function, timeout?: number, ...args: unknown[]) => unknown;
type CTFn = (id: unknown) => void;

const _setTimeout: STFn = (handler, timeout, ...args) => (globalThis as { setTimeout: STFn }).setTimeout(handler, timeout, ...args);
const _setInterval: STFn = (handler, timeout, ...args) => (globalThis as { setInterval: STFn }).setInterval(handler, timeout, ...args);
const _clearTimeout: CTFn = (id) => (globalThis as { clearTimeout: CTFn }).clearTimeout(id);
const _clearInterval: CTFn = (id) => (globalThis as { clearInterval: CTFn }).clearInterval(id);

export { _setTimeout as setTimeout, _setInterval as setInterval, _clearTimeout as clearTimeout, _clearInterval as clearInterval };

// setImmediate / clearImmediate fallback (queueMicrotask)
const _setImmediate = (fn: Function, ...args: unknown[]): unknown => {
  const si = (globalThis as { setImmediate?: Function }).setImmediate;
  if (typeof si === 'function') {
    return si(fn, ...args);
  }
  return _setTimeout(() => (fn as Function)(...args), 0);
};

const _clearImmediate = (id: unknown): void => {
  const ci = (globalThis as { clearImmediate?: Function }).clearImmediate;
  if (typeof ci === 'function') {
    ci(id);
    return;
  }
  _clearTimeout(id);
};

export { _setImmediate as setImmediate, _clearImmediate as clearImmediate };

export const nodeTimers = {
  setTimeout: _setTimeout,
  setInterval: _setInterval,
  clearTimeout: _clearTimeout,
  clearInterval: _clearInterval,
  setImmediate: _setImmediate,
  clearImmediate: _clearImmediate,
};

// node:timers/promises
const abortError = (signal: AbortSignal): Error => {
  const error = new Error('The operation was aborted', { cause: signal.reason });
  error.name = 'AbortError';
  (error as Error & { code?: string }).code = 'ABORT_ERR';
  return error;
};

const promisesSetTimeout = (ms: number, value?: unknown, opts?: { signal?: AbortSignal; ref?: boolean }): Promise<unknown> => {
  const signal = opts?.signal;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      _clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = _setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

const promisesSetImmediate = (value?: unknown): Promise<unknown> => {
  return new Promise((resolve) => {
    _setImmediate(() => resolve(value));
  });
};

const promisesSetInterval = async function* (ms: number, value?: unknown): AsyncGenerator<unknown> {
  while (true) {
    yield new Promise((r) => _setTimeout(() => r(value), ms));
  }
};

export const nodeTimersPromises = {
  setTimeout: promisesSetTimeout,
  setImmediate: promisesSetImmediate,
  setInterval: promisesSetInterval,
};
(nodeTimers as Record<string, unknown>)['promises'] = nodeTimersPromises;
