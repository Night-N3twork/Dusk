// node:tty — query host PtyManager for TTY state.

import { Readable, Writable } from './node-stream';

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const __call = (f: string, extra: Record<string, unknown> = {}): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) throw new Error(r.error);
  return r.value;
};

export const isatty = (fd: number): boolean => {
  try { return __call('tty.isatty', { fd }) === true; } catch { return false; }
};

export class ReadStream extends Readable {
  isRaw = false;
  isTTY = true;
  columns = 80;
  rows = 24;

  constructor(_fd?: number, opts?: { highWaterMark?: number }) {
    super(opts);
    try {
      const size = __call('tty.getWinSize') as [number, number] | undefined;
      if (size) { this.columns = size[0]; this.rows = size[1]; }
    } catch { /* */ }
  }

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    try { __call('tty.setRawMode', { raw: mode }); } catch { /* */ }
    return this;
  }

  override resume(): this {
    super.resume();
    return this;
  }

  override pause(): this {
    super.pause();
    return this;
  }
}

export class WriteStream extends Writable {
  isTTY = true;
  columns = 80;
  rows = 24;
  private _fd: number;

  constructor(fd?: number, opts?: { highWaterMark?: number }) {
    super(opts);
    this._fd = fd ?? 1;
    try {
      const size = __call('tty.getWinSize') as [number, number] | undefined;
      if (size) { this.columns = size[0]; this.rows = size[1]; }
    } catch { /* */ }
  }

  override _write(chunk: unknown, _encoding: string, cb: (err?: Error | null) => void): void {
    try {
      let bytes: Uint8Array;
      if (typeof chunk === 'string') {
        bytes = new TextEncoder().encode(chunk);
      } else if (chunk instanceof Uint8Array) {
        bytes = chunk;
      } else {
        bytes = new Uint8Array(0);
      }
      __call('proc.write', { fd: this._fd, data: bytes });
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }

  cursorTo(_x: number, _yOrCb?: number | (() => void), _cb?: () => void): boolean { return true; }
  moveCursor(_dx: number, _dy: number, _cb?: () => void): boolean { return true; }
  clearLine(_dir: number, _cb?: () => void): boolean { return true; }
  clearScreenDown(_cb?: () => void): boolean { return true; }
  getColorDepth(_env?: Record<string, string>): number { return 1; }
  hasColors(count?: number | Record<string, string>, _env?: Record<string, string>): boolean {
    if (typeof count === 'number') return false;
    return false;
  }
  getWindowSize(): [number, number] { return [this.columns, this.rows]; }
}

export const nodeTty = {
  isatty,
  ReadStream,
  WriteStream,
};
