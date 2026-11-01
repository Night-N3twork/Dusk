declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const call = (f: string, extra: Record<string, unknown>): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) throw new Error(r.error);
  return r.value;
};

const inheritEnv = (options: Record<string, unknown>): Record<string, unknown> => {
  // Match Node default: if no env supplied, inherit from process.env
  if (options['env'] === undefined) {
    const g = globalThis as Record<string, unknown>;
    const proc = g['process'] as { env?: Record<string, string> } | undefined;
    if (proc?.env) {
      // Materialize the Proxy into a plain object snapshot
      const snap: Record<string, string> = {};
      for (const k of Object.keys(proc.env)) snap[k] = proc.env[k]!;
      return { ...options, env: snap };
    }
  }
  return options;
};

const normalizeStdinOption = (options: Record<string, unknown>): Record<string, unknown> => {
  options = inheritEnv(options);
  const stdin = options['stdin'];
  if (stdin === undefined || stdin === null) return options;
  if (stdin instanceof Uint8Array) {
    const arr: number[] = [];
    for (let i = 0; i < stdin.length; i++) arr.push(stdin[i]!);
    return { ...options, stdin: arr };
  }
  if (Array.isArray(stdin)) return options;
  return options;
};

interface BufferLike extends Uint8Array { toString(encoding?: string): string }

const makeBuffer = (u8: Uint8Array): BufferLike => {
  Object.defineProperty(u8, 'toString', {
    value: function (encoding?: string): string {
      if (encoding === undefined || encoding === 'utf8' || encoding === 'utf-8') return decodeUtf8(this as Uint8Array);
      if (encoding === 'hex') { let s = ''; for (let i = 0; i < this.length; i++) { const b = (this as Uint8Array)[i]!; s += (b < 16 ? '0' : '') + b.toString(16); } return s; }
      if (encoding === 'base64') { let s = ''; for (let i = 0; i < this.length; i++) s += String.fromCharCode((this as Uint8Array)[i]!); return btoa(s); }
      return decodeUtf8(this as Uint8Array);
    },
    writable: false,
    enumerable: false,
    configurable: false,
  });
  return u8 as BufferLike;
};

const decodeUtf8 = (bytes: Uint8Array): string => {
  let s = '';
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i++]!;
    if (b1 < 0x80) {
      s += String.fromCharCode(b1);
    } else if (b1 < 0xc0) {
      s += '\ufffd';
    } else if (b1 < 0xe0) {
      const b2 = bytes[i++] ?? 0;
      s += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f));
    } else if (b1 < 0xf0) {
      const b2 = bytes[i++] ?? 0;
      const b3 = bytes[i++] ?? 0;
      s += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
    } else {
      const b2 = bytes[i++] ?? 0;
      const b3 = bytes[i++] ?? 0;
      const b4 = bytes[i++] ?? 0;
      const cp = ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
      const off = cp - 0x10000;
      s += String.fromCharCode(0xd800 | (off >> 10), 0xdc00 | (off & 0x3ff));
    }
  }
  return s;
};

interface PendingProcess {
  onData: ((stream: 'stdout' | 'stderr', chunk: Uint8Array) => void)[];
  onStreamEnd: ((stream: 'stdout' | 'stderr') => void)[];
  onExit: ((code: number) => void)[];
  onError: ((e: Error) => void)[];
  stdoutStreamId?: number;
  stderrStreamId?: number;
  stdoutEnded?: boolean;
  stderrEnded?: boolean;
  exited?: boolean;
}

const pendingProcesses = new Map<number, PendingProcess>();

// Coalesced credit-grant helper. When the engine consumes bytes from the
// host-side __process.dispatch firehose, grant that many bytes back to the
// host StreamRegistry so the host pump can push the next chunk. Coalesce
// via microtask so many small pushes collapse into one IPC round trip.
// Mirrors the pattern in engine-streams.ts (createStreamSink).
const pendingGrants = new Map<number, number>();
let grantFlushScheduled = false;
const scheduleGrantFlush = (): void => {
  if (grantFlushScheduled) return;
  grantFlushScheduled = true;
  void Promise.resolve().then(() => {
    grantFlushScheduled = false;
    for (const [id, amount] of pendingGrants) {
      try { call('stream.grantCredit', { id, amount }); } catch { /* engine teardown */ }
    }
    pendingGrants.clear();
  });
};
const grant = (id: number, amount: number): void => {
  if (amount <= 0) return;
  pendingGrants.set(id, (pendingGrants.get(id) ?? 0) + amount);
  scheduleGrantFlush();
};

const g = globalThis as Record<string, unknown>;
const existing = g['__process'] as Record<string, unknown> | undefined;
const procState: Record<string, unknown> = existing ?? {};
if (!existing) g['__process'] = procState;
// A process entry must outlive its `exit` event. The host dispatches `exit`
// off child.exit, independently of the stdout/stderr pumps, so a chunk parked
// on the host credit gate can still arrive afterwards. Deleting the entry at
// `exit` silently discarded those chunks (and their credit grants), truncating
// output under load. Release the entry only once the process has exited AND
// both pipes have delivered their end-of-stream sentinel.
const releaseIfComplete = (pid: number, p: PendingProcess): void => {
  if (p.exited === true && p.stdoutEnded === true && p.stderrEnded === true) {
    pendingProcesses.delete(pid);
  }
};

procState['dispatch'] = (pid: number, event: string, data: unknown): void => {
  const p = pendingProcesses.get(pid);
  if (!p) return;
  if (event === 'stdout' || event === 'stderr') {
    // `null` payload is the end-of-stream sentinel — host has already
    // cleared the registry entry, so no credit grant is needed. This is the
    // only place a stream's 'end' is announced, which guarantees 'end' can
    // never be observed before the stream's last data chunk.
    if (data === null) {
      if (event === 'stdout') p.stdoutEnded = true;
      else p.stderrEnded = true;
      for (const cb of p.onStreamEnd) cb(event);
      releaseIfComplete(pid, p);
      return;
    }
    const arr = data as number[];
    const bytes = makeBuffer(new Uint8Array(arr));
    for (const cb of p.onData) cb(event, bytes);
    const streamId = event === 'stdout' ? p.stdoutStreamId : p.stderrStreamId;
    if (streamId !== undefined) grant(streamId, arr.length);
  } else if (event === 'exit') {
    p.exited = true;
    for (const cb of p.onExit) cb(data as number);
    releaseIfComplete(pid, p);
  } else if (event === 'error') {
    for (const cb of p.onError) cb(new Error(String(data)));
    pendingProcesses.delete(pid);
  }
};

type ChildEvent = 'exit' | 'close' | 'error' | 'spawn';

class ChildProcess {
  pid: number;
  exit: Promise<number>;
  stdin: { write(data: Uint8Array): boolean; end(): void };
  stdout: { on(event: 'data' | 'end', cb: (data?: Uint8Array) => void): void };
  stderr: { on(event: 'data' | 'end', cb: (data?: Uint8Array) => void): void };
  private _exitResolve!: (code: number) => void;
  private _stdoutDataCbs: ((data: Uint8Array) => void)[] = [];
  private _stdoutEndCbs: (() => void)[] = [];
  private _stderrDataCbs: ((data: Uint8Array) => void)[] = [];
  private _stderrEndCbs: (() => void)[] = [];
  private _stdoutBacklog: Uint8Array[] = [];
  private _stderrBacklog: Uint8Array[] = [];
  private _stdoutListening = false;
  private _stderrListening = false;
  private _stdoutEnded = false;
  private _stderrEnded = false;
  private _ended = false;
  private _exitCode: number | null = null;
  private _errorValue: Error | null = null;
  private _exitListeners: ((code: number) => void)[] = [];
  private _closeListeners: ((code: number) => void)[] = [];
  private _errorListeners: ((e: Error) => void)[] = [];
  private _spawnListeners: (() => void)[] = [];

  constructor(pid: number, stdoutStreamId?: number, stderrStreamId?: number) {
    this.pid = pid;
    this.exit = new Promise<number>((resolve) => { this._exitResolve = resolve; });
    this.stdin = {
      write: (data: Uint8Array): boolean => {
        call('process.stdinWrite', { pid, data });
        return true;
      },
      end: (): void => { call('process.stdinClose', { pid }); },
    };
    const self = this;
    this.stdout = {
      on(event, cb) {
        if (event === 'data') {
          const dataCb = cb as (d: Uint8Array) => void;
          self._stdoutDataCbs.push(dataCb);
          self._stdoutListening = true;
          for (const chunk of self._stdoutBacklog) dataCb(chunk);
          self._stdoutBacklog = [];
        } else if (event === 'end') {
          const endCb = cb as () => void;
          self._stdoutEndCbs.push(endCb);
          if (self._stdoutEnded) endCb();
        }
      },
    };
    this.stderr = {
      on(event, cb) {
        if (event === 'data') {
          const dataCb = cb as (d: Uint8Array) => void;
          self._stderrDataCbs.push(dataCb);
          self._stderrListening = true;
          for (const chunk of self._stderrBacklog) dataCb(chunk);
          self._stderrBacklog = [];
        } else if (event === 'end') {
          const endCb = cb as () => void;
          self._stderrEndCbs.push(endCb);
          if (self._stderrEnded) endCb();
        }
      },
    };

    const pending: PendingProcess = {
      onData: [(stream, chunk) => {
        if (stream === 'stdout') {
          if (this._stdoutListening) for (const cb of this._stdoutDataCbs) cb(chunk);
          else this._stdoutBacklog.push(chunk);
        } else {
          if (this._stderrListening) for (const cb of this._stderrDataCbs) cb(chunk);
          else this._stderrBacklog.push(chunk);
        }
      }],
      onStreamEnd: [(stream) => {
        // 'end' means real stream EOF, never "the process exited". Firing it
        // from onExit raced the pumps and let consumers stop reading while
        // chunks were still in flight.
        if (stream === 'stdout') {
          if (this._stdoutEnded) return;
          this._stdoutEnded = true;
          for (const cb of this._stdoutEndCbs) cb();
        } else {
          if (this._stderrEnded) return;
          this._stderrEnded = true;
          for (const cb of this._stderrEndCbs) cb();
        }
      }],
      onExit: [(code) => {
        this._ended = true;
        this._exitCode = code;
        for (const cb of this._exitListeners.slice()) { try { cb(code); } catch (e) { this._reportListenerError(e); } }
        for (const cb of this._closeListeners.slice()) { try { cb(code); } catch (e) { this._reportListenerError(e); } }
        this._exitResolve(code);
      }],
      onError: [(e) => {
        this._errorValue = e;
        for (const cb of this._errorListeners.slice()) { try { cb(e); } catch (err) { this._reportListenerError(err); } }
      }],
    };
    // No stream id means the host never wired a pump for that pipe, so no EOF
    // sentinel will ever arrive. Treat it as already ended so 'end' listeners
    // still fire and the entry is still releasable on exit.
    if (stdoutStreamId !== undefined) pending.stdoutStreamId = stdoutStreamId;
    else { pending.stdoutEnded = true; this._stdoutEnded = true; }
    if (stderrStreamId !== undefined) pending.stderrStreamId = stderrStreamId;
    else { pending.stderrEnded = true; this._stderrEnded = true; }
    pendingProcesses.set(pid, pending);
  }

  on(event: ChildEvent, cb: (...args: unknown[]) => void): this {
    if (event === 'exit') {
      const ecb = cb as (code: number) => void;
      this._exitListeners.push(ecb);
      if (this._ended && this._exitCode !== null) ecb(this._exitCode);
    } else if (event === 'close') {
      const ccb = cb as (code: number) => void;
      this._closeListeners.push(ccb);
      if (this._ended && this._exitCode !== null) ccb(this._exitCode);
    } else if (event === 'error') {
      const errCb = cb as (e: Error) => void;
      this._errorListeners.push(errCb);
      if (this._errorValue) errCb(this._errorValue);
    } else if (event === 'spawn') {
      const sCb = cb as () => void;
      this._spawnListeners.push(sCb);
      sCb();
    }
    return this;
  }

  once(event: ChildEvent, cb: (...args: unknown[]) => void): this {
    const wrapper = (...args: unknown[]): void => {
      this.off(event, wrapper);
      cb(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: ChildEvent, cb: (...args: unknown[]) => void): this {
    const remove = <T>(list: T[], target: unknown): T[] => list.filter((x) => x !== target);
    if (event === 'exit') this._exitListeners = remove(this._exitListeners, cb);
    else if (event === 'close') this._closeListeners = remove(this._closeListeners, cb);
    else if (event === 'error') this._errorListeners = remove(this._errorListeners, cb);
    else if (event === 'spawn') this._spawnListeners = remove(this._spawnListeners, cb);
    return this;
  }

  removeListener(event: ChildEvent, cb: (...args: unknown[]) => void): this {
    return this.off(event, cb);
  }

  removeAllListeners(event?: ChildEvent): this {
    if (event === undefined || event === 'exit') this._exitListeners = [];
    if (event === undefined || event === 'close') this._closeListeners = [];
    if (event === undefined || event === 'error') this._errorListeners = [];
    if (event === undefined || event === 'spawn') this._spawnListeners = [];
    return this;
  }

  private _reportListenerError(e: unknown): void {
    try { console.error('ChildProcess listener threw:', e instanceof Error ? (e.stack ?? e.message) : String(e)); } catch { /* */ }
  }
}

export const nodeChildProcess: Record<string, unknown> = {
  spawn: (command: string, args: string[] = [], options: Record<string, unknown> = {}): ChildProcess => {
    const result = call('process.spawn', { command, args, options: normalizeStdinOption(options) }) as {
      pid: number;
      stdoutStreamId?: number;
      stderrStreamId?: number;
    };
    return new ChildProcess(result.pid, result.stdoutStreamId, result.stderrStreamId);
  },

  execFile: (command: string, args: string[], options: Record<string, unknown> | ((e: unknown, stdout: string, stderr: string) => void), cb?: (e: unknown, stdout: string, stderr: string) => void): ChildProcess => {
    const callback = typeof options === 'function' ? options : cb;
    const opts = typeof options === 'function' ? {} : options;
    const spawnFn = nodeChildProcess['spawn'] as (c: string, a: string[], o: Record<string, unknown>) => ChildProcess;
    const child = spawnFn(command, args ?? [], opts);
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    child.stdout.on('data', (d) => { if (d) stdoutChunks.push(d); });
    child.stderr.on('data', (d) => { if (d) stderrChunks.push(d); });
    void child.exit.then((code) => {
      const concat = (parts: Uint8Array[]): Uint8Array => {
        const total = parts.reduce((a, c) => a + c.length, 0);
        const out = new Uint8Array(total);
        let off = 0; for (const c of parts) { out.set(c, off); off += c.length; }
        return out;
      };
      const stdoutStr = decodeUtf8(concat(stdoutChunks));
      const stderrStr = decodeUtf8(concat(stderrChunks));
      if (callback) {
        try {
          if (code === 0) callback(null, stdoutStr, stderrStr);
          else {
            const err = new Error(`Command failed: ${command} (exit ${code})`);
            (err as { code?: number }).code = code;
            callback(err, stdoutStr, stderrStr);
          }
        } catch (e) {
          try { console.error('execFile callback threw:', e instanceof Error ? (e.stack ?? e.message) : String(e)); } catch { /* */ }
        }
      }
    });
    return child;
  },

  exec: (command: string, options: Record<string, unknown> | ((e: unknown, stdout: string, stderr: string) => void), cb?: (e: unknown, stdout: string, stderr: string) => void): ChildProcess => {
    const execFileFn = nodeChildProcess['execFile'] as (c: string, a: string[], o: Record<string, unknown> | ((e: unknown, stdout: string, stderr: string) => void), cb?: (e: unknown, stdout: string, stderr: string) => void) => ChildProcess;
    return execFileFn('/bin/sh', ['-c', command], options as Record<string, unknown>, cb);
  },

  execSync: (command: string, options: Record<string, unknown> = {}): Uint8Array => {
    const result = call('process.spawnSync', { command: '/bin/sh', args: ['-c', command], options: normalizeStdinOption(options) }) as { stdout: number[]; stderr: number[]; status: number };
    const stdout = makeBuffer(new Uint8Array(result.stdout));
    const stderr = makeBuffer(new Uint8Array(result.stderr));
    if (result.status !== 0) {
      const err = new Error(`Command failed: ${command} (exit ${result.status})`) as Error & { status?: number; stdout?: Uint8Array; stderr?: Uint8Array };
      err.status = result.status;
      err.stdout = stdout;
      err.stderr = stderr;
      throw err;
    }
    return stdout;
  },

  spawnSync: (command: string, args: string[] = [], options: Record<string, unknown> = {}): { stdout: Uint8Array; stderr: Uint8Array; status: number } => {
    const result = call('process.spawnSync', { command, args, options: normalizeStdinOption(options) }) as { stdout: number[]; stderr: number[]; status: number };
    return {
      stdout: makeBuffer(new Uint8Array(result.stdout)),
      stderr: makeBuffer(new Uint8Array(result.stderr)),
      status: result.status,
    };
  },
};
