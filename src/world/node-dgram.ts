import { EventEmitter } from './node-events';

const notRunning = (): Error => {
  const error = new Error('UDP sockets are not available in Dusk: browsers cannot send or receive datagrams');
  (error as Error & { code?: string }).code = 'EAFNOSUPPORT';
  return error;
};

export class Socket extends EventEmitter {
  readonly type: string;

  constructor(type: string | { type: string }) {
    super();
    this.type = typeof type === 'string' ? type : type.type;
  }

  bind(...args: unknown[]): this {
    const callback = args.find((arg) => typeof arg === 'function') as ((error?: Error) => void) | undefined;
    queueMicrotask(() => {
      const error = notRunning();
      if (callback) callback(error);
      else this.emit('error', error);
    });
    return this;
  }

  send(...args: unknown[]): void {
    const callback = [...args].reverse().find((arg) => typeof arg === 'function') as ((error: Error) => void) | undefined;
    queueMicrotask(() => {
      const error = notRunning();
      if (callback) callback(error);
      else this.emit('error', error);
    });
  }

  connect(..._args: unknown[]): void {
    queueMicrotask(() => this.emit('error', notRunning()));
  }

  close(callback?: () => void): this {
    queueMicrotask(() => {
      callback?.();
      this.emit('close');
    });
    return this;
  }

  disconnect(): void { }
  address(): never { throw notRunning(); }
  remoteAddress(): never { throw notRunning(); }
  setBroadcast(_flag: boolean): void { }
  setTTL(ttl: number): number { return ttl; }
  setMulticastTTL(ttl: number): number { return ttl; }
  setMulticastLoopback(flag: boolean): boolean { return flag; }
  setMulticastInterface(_iface: string): void { }
  addMembership(_group: string, _iface?: string): void { }
  dropMembership(_group: string, _iface?: string): void { }
  setRecvBufferSize(_size: number): void { }
  setSendBufferSize(_size: number): void { }
  getRecvBufferSize(): number { return 0; }
  getSendBufferSize(): number { return 0; }
  ref(): this { return this; }
  unref(): this { return this; }
}

export const createSocket = (type: string | { type: string }, listener?: (...args: unknown[]) => void): Socket => {
  const socket = new Socket(type);
  if (listener) socket.on('message', listener);
  return socket;
};

export const nodeDgram = { createSocket, Socket };
