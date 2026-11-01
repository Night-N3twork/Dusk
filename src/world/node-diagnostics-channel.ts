type Listener = (message: unknown, name: string | symbol) => void;

export class Channel {
  readonly name: string | symbol;
  private listeners: Listener[] = [];
  private stores = new Map<{ run: <T>(store: unknown, fn: () => T) => T }, ((message: unknown) => unknown) | undefined>();

  constructor(name: string | symbol) {
    this.name = name;
  }

  get hasSubscribers(): boolean {
    return this.listeners.length > 0 || this.stores.size > 0;
  }

  subscribe(listener: Listener): void {
    if (typeof listener !== 'function') throw new TypeError('The "subscription" argument must be of type function');
    this.listeners.push(listener);
  }

  unsubscribe(listener: Listener): boolean {
    const index = this.listeners.indexOf(listener);
    if (index === -1) return false;
    this.listeners.splice(index, 1);
    return true;
  }

  publish(message: unknown): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(message, this.name);
      } catch (error) {
        Promise.reject(error);
      }
    }
  }

  bindStore(store: { run: <T>(store: unknown, fn: () => T) => T }, transform?: (message: unknown) => unknown): void {
    this.stores.set(store, transform);
  }

  unbindStore(store: { run: <T>(store: unknown, fn: () => T) => T }): boolean {
    return this.stores.delete(store);
  }

  runStores<T>(message: unknown, fn: (...args: unknown[]) => T, thisArg?: unknown, ...args: unknown[]): T {
    let run = (): T => {
      this.publish(message);
      return fn.apply(thisArg, args);
    };
    for (const [store, transform] of this.stores) {
      const next = run;
      run = (): T => store.run(transform ? transform(message) : message, next);
    }
    return run();
  }
}

const channels = new Map<string | symbol, Channel>();

export const channel = (name: string | symbol): Channel => {
  if (typeof name !== 'string' && typeof name !== 'symbol') throw new TypeError('The "channel" argument must be of type string or symbol');
  let existing = channels.get(name);
  if (!existing) {
    existing = new Channel(name);
    channels.set(name, existing);
  }
  return existing;
};

export const hasSubscribers = (name: string | symbol): boolean => channels.get(name)?.hasSubscribers ?? false;
export const subscribe = (name: string | symbol, listener: Listener): void => channel(name).subscribe(listener);
export const unsubscribe = (name: string | symbol, listener: Listener): boolean => channel(name).unsubscribe(listener);

interface TracingHandlers {
  start?: Listener;
  end?: Listener;
  asyncStart?: Listener;
  asyncEnd?: Listener;
  error?: Listener;
}

const TRACING_EVENTS = ['start', 'end', 'asyncStart', 'asyncEnd', 'error'] as const;

export class TracingChannel {
  readonly start: Channel;
  readonly end: Channel;
  readonly asyncStart: Channel;
  readonly asyncEnd: Channel;
  readonly error: Channel;

  constructor(nameOrChannels: string | Record<(typeof TRACING_EVENTS)[number], Channel>) {
    const pick = (event: (typeof TRACING_EVENTS)[number]): Channel =>
      typeof nameOrChannels === 'string' ? channel(`tracing:${nameOrChannels}:${event}`) : nameOrChannels[event];
    this.start = pick('start');
    this.end = pick('end');
    this.asyncStart = pick('asyncStart');
    this.asyncEnd = pick('asyncEnd');
    this.error = pick('error');
  }

  get hasSubscribers(): boolean {
    return TRACING_EVENTS.some((event) => this[event].hasSubscribers);
  }

  subscribe(handlers: TracingHandlers): void {
    for (const event of TRACING_EVENTS) {
      const handler = handlers[event];
      if (handler) this[event].subscribe(handler);
    }
  }

  unsubscribe(handlers: TracingHandlers): boolean {
    let done = true;
    for (const event of TRACING_EVENTS) {
      const handler = handlers[event];
      if (handler && !this[event].unsubscribe(handler)) done = false;
    }
    return done;
  }

  traceSync<T>(fn: (...args: unknown[]) => T, context: Record<string, unknown> = {}, thisArg?: unknown, ...args: unknown[]): T {
    if (!this.hasSubscribers) return fn.apply(thisArg, args);
    return this.start.runStores(context, () => {
      try {
        const result = fn.apply(thisArg, args);
        context['result'] = result;
        return result;
      } catch (error) {
        context['error'] = error;
        this.error.publish(context);
        throw error;
      } finally {
        this.end.publish(context);
      }
    });
  }

  tracePromise<T>(fn: (...args: unknown[]) => Promise<T>, context: Record<string, unknown> = {}, thisArg?: unknown, ...args: unknown[]): Promise<T> {
    if (!this.hasSubscribers) return fn.apply(thisArg, args);
    return this.start.runStores(context, () => {
      try {
        const promise = Promise.resolve(fn.apply(thisArg, args));
        this.end.publish(context);
        return promise.then(
          (result) => {
            context['result'] = result;
            this.asyncStart.publish(context);
            this.asyncEnd.publish(context);
            return result;
          },
          (error: unknown) => {
            context['error'] = error;
            this.error.publish(context);
            this.asyncStart.publish(context);
            this.asyncEnd.publish(context);
            throw error;
          },
        );
      } catch (error) {
        context['error'] = error;
        this.error.publish(context);
        this.end.publish(context);
        throw error;
      }
    });
  }

  traceCallback<T>(fn: (...args: unknown[]) => T, position = -1, context: Record<string, unknown> = {}, thisArg?: unknown, ...args: unknown[]): T {
    if (!this.hasSubscribers) return fn.apply(thisArg, args);
    const index = position < 0 ? args.length + position : position;
    const callback = args[index];
    if (typeof callback !== 'function') throw new TypeError('The "callback" argument must be of type function');
    args[index] = (error: unknown, result: unknown) => {
      if (error) {
        context['error'] = error;
        this.error.publish(context);
      } else {
        context['result'] = result;
      }
      return this.asyncStart.runStores(context, () => {
        try {
          return (callback as (e: unknown, r: unknown) => unknown).call(thisArg, error, result);
        } finally {
          this.asyncEnd.publish(context);
        }
      });
    };
    return this.start.runStores(context, () => {
      try {
        return fn.apply(thisArg, args);
      } catch (error) {
        context['error'] = error;
        this.error.publish(context);
        throw error;
      } finally {
        this.end.publish(context);
      }
    });
  }
}

export const tracingChannel = (nameOrChannels: string | Record<(typeof TRACING_EVENTS)[number], Channel>): TracingChannel =>
  new TracingChannel(nameOrChannels);

export const nodeDiagnosticsChannel = {
  channel,
  hasSubscribers,
  subscribe,
  unsubscribe,
  tracingChannel,
  Channel,
};
