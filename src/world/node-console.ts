// node:console — proper Console class wrapping any Writable.
// Also re-exports the global console for `require('console')` callers.

import type { Writable } from './node-stream';
import { format, inspect } from './node-util';

export interface ConsoleOptions {
  stdout?: Writable | { write: (data: string) => unknown };
  stderr?: Writable | { write: (data: string) => unknown };
  ignoreErrors?: boolean;
  colorMode?: 'auto' | boolean;
  inspectOptions?: Record<string, unknown>;
  groupIndentation?: number;
}

interface WriteTarget {
  write: (data: string) => unknown;
}

const writeTo = (target: WriteTarget | undefined, fallback: WriteTarget | undefined, text: string, ignoreErrors = true): void => {
  if (target) {
    try { target.write(text); return; } catch (error) { if (!ignoreErrors) throw error; }
  }
  if (fallback) {
    try { fallback.write(text); } catch (error) { if (!ignoreErrors) throw error; }
  }
};

export class Console {
  private _stdout: WriteTarget | undefined;
  private _stderr: WriteTarget | undefined;
  private _groupDepth = 0;
  private _groupIndent: number;
  private _times = new Map<string, number>();
  private _counts = new Map<string, number>();
  private _ignoreErrors: boolean;
  private _inspectOpts: Record<string, unknown>;

  constructor(stdoutOrOpts?: ConsoleOptions | (WriteTarget | undefined), stderr?: WriteTarget) {
    let opts: ConsoleOptions = {};
    if (stdoutOrOpts && typeof stdoutOrOpts === 'object' && 'stdout' in stdoutOrOpts) {
      opts = stdoutOrOpts;
    } else {
      if (stdoutOrOpts) opts.stdout = stdoutOrOpts as WriteTarget;
      if (stderr) opts.stderr = stderr;
    }
    this._stdout = opts.stdout as WriteTarget | undefined;
    this._stderr = opts.stderr as WriteTarget | undefined;
    this._ignoreErrors = opts.ignoreErrors ?? true;
    this._inspectOpts = opts.inspectOptions ?? {};
    this._groupIndent = opts.groupIndentation ?? 2;
  }

  private _indent(): string {
    if (this._groupDepth === 0) return '';
    return ' '.repeat(this._groupDepth * this._groupIndent);
  }

  private _fmt(args: unknown[]): string {
    if (args.length === 0) return '';
    if (typeof args[0] === 'string') return format(...args);
    return args.map((a) => typeof a === 'string' ? a : inspect(a, this._inspectOpts)).join(' ');
  }

  log(...args: unknown[]): void {
    writeTo(this._stdout, this._stderr, this._indent() + this._fmt(args) + '\n', this._ignoreErrors);
  }

  info(...args: unknown[]): void {
    this.log(...args);
  }

  debug(...args: unknown[]): void {
    this.log(...args);
  }

  warn(...args: unknown[]): void {
    writeTo(this._stderr, this._stdout, this._indent() + this._fmt(args) + '\n', this._ignoreErrors);
  }

  error(...args: unknown[]): void {
    this.warn(...args);
  }

  dir(obj: unknown, opts?: Record<string, unknown>): void {
    this.log(inspect(obj, { ...this._inspectOpts, ...opts }));
  }

  dirxml(...args: unknown[]): void {
    this.log(...args);
  }

  trace(...args: unknown[]): void {
    const e = new Error('Trace');
    e.name = 'Trace';
    e.message = this._fmt(args);
    this.error(e.stack ?? e.message);
  }

  assert(value: unknown, ...args: unknown[]): void {
    if (!value) {
      const message = args.length > 0 ? this._fmt(args) : '';
      this.error(`Assertion failed${message ? ': ' + message : ''}`);
    }
  }

  count(label = 'default'): void {
    const next = (this._counts.get(label) ?? 0) + 1;
    this._counts.set(label, next);
    this.log(`${label}: ${next}`);
  }

  countReset(label = 'default'): void {
    this._counts.delete(label);
  }

  group(...args: unknown[]): void {
    if (args.length > 0) this.log(...args);
    this._groupDepth++;
  }

  groupCollapsed(...args: unknown[]): void {
    this.group(...args);
  }

  groupEnd(): void {
    if (this._groupDepth > 0) this._groupDepth--;
  }

  time(label = 'default'): void {
    this._times.set(label, Date.now());
  }

  timeLog(label = 'default', ...args: unknown[]): void {
    const start = this._times.get(label);
    if (start === undefined) {
      this.warn(`No such label: '${label}' for console.timeLog()`);
      return;
    }
    const elapsed = Date.now() - start;
    const extra = args.length > 0 ? ' ' + this._fmt(args) : '';
    this.log(`${label}: ${elapsed}ms${extra}`);
  }

  timeEnd(label = 'default'): void {
    const start = this._times.get(label);
    if (start === undefined) {
      this.warn(`No such label: '${label}' for console.timeEnd()`);
      return;
    }
    const elapsed = Date.now() - start;
    this._times.delete(label);
    this.log(`${label}: ${elapsed}ms`);
  }

  table(data: unknown, columns?: string[]): void {
    // Minimal table: detect array of objects, else fall back to dir.
    if (!Array.isArray(data) || data.length === 0) {
      this.dir(data);
      return;
    }
    const sample = data[0];
    if (sample === null || typeof sample !== 'object') {
      // Array of primitives
      const rows: Array<{ index: number; value: unknown }> = data.map((v, i) => ({ index: i, value: v }));
      this._renderTable(rows, ['index', 'value']);
      return;
    }
    const cols = columns ?? Object.keys(sample as Record<string, unknown>);
    this._renderTable(data as Array<Record<string, unknown>>, cols);
  }

  private _renderTable(rows: Array<Record<string, unknown>>, cols: string[]): void {
    const headers = ['(index)', ...cols];
    const widths: Record<string, number> = {};
    for (const h of headers) widths[h] = h.length;
    const stringRows = rows.map((r, i) => {
      const out: Record<string, string> = { '(index)': String(i) };
      for (const c of cols) out[c] = typeof r[c] === 'object' ? inspect(r[c], { depth: 0 }) : String(r[c]);
      for (const h of headers) widths[h] = Math.max(widths[h]!, out[h]!.length);
      return out;
    });
    const sep = '┼' + headers.map((h) => '─'.repeat(widths[h]! + 2)).join('┼') + '┼';
    const top = '┌' + headers.map((h) => '─'.repeat(widths[h]! + 2)).join('┬') + '┐';
    const bot = '└' + headers.map((h) => '─'.repeat(widths[h]! + 2)).join('┴') + '┘';
    const headerLine = '│ ' + headers.map((h) => h.padEnd(widths[h]!)).join(' │ ') + ' │';
    this.log(top);
    this.log(headerLine);
    this.log(sep);
    for (const r of stringRows) {
      this.log('│ ' + headers.map((h) => (r[h] ?? '').padEnd(widths[h]!)).join(' │ ') + ' │');
    }
    this.log(bot);
  }

  clear(): void {
    // best-effort: emit clear sequence
    writeTo(this._stdout, this._stderr, '\x1b[2J\x1b[H', this._ignoreErrors);
  }

  profile(_label?: string): void { /* no-op */ }
  profileEnd(_label?: string): void { /* no-op */ }
  timeStamp(_label?: string): void { /* no-op */ }

  static get Console(): typeof Console { return Console; }
}

// Singleton bound to the global stdout/stderr (which exist as host shims).
const getGlobalConsole = (): Console => {
  const g = globalThis as Record<string, unknown>;
  const proc = g['process'] as { stdout?: WriteTarget; stderr?: WriteTarget } | undefined;
  return new Console({
    ...(proc?.stdout ? { stdout: proc.stdout } : {}),
    ...(proc?.stderr ? { stderr: proc.stderr } : {}),
  });
};

let _defaultConsole: Console | undefined;
const defaultConsole = (): Console => {
  if (!_defaultConsole) _defaultConsole = getGlobalConsole();
  return _defaultConsole;
};

export const nodeConsole = new Proxy({} as Record<string, unknown>, {
  get(_t, key) {
    if (key === 'Console') return Console;
    if (key === 'default') return defaultConsole();
    const c = defaultConsole() as unknown as Record<string, unknown>;
    const v = c[key as string];
    if (typeof v === 'function') return v.bind(c);
    return v;
  },
  has(_t, key) {
    if (key === 'Console') return true;
    return (defaultConsole() as unknown as object).hasOwnProperty(key as string);
  },
});

export const installConsole = (): void => {
  const g = globalThis as Record<string, unknown>;
  // Only replace if the existing console is the host shim (no _times Map etc.)
  const existing = g['console'] as { _times?: unknown } | undefined;
  if (!existing || !existing._times) {
    g['console'] = defaultConsole();
  }
};
