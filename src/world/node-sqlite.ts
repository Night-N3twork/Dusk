declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

type SqlValue = null | number | bigint | string | Uint8Array;
type ResultSet = { columns: string[]; values: unknown[][] };

const sqliteError = (message: string, code = 'ERR_SQLITE_ERROR'): Error => {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  return error;
};

const call = (f: string, extra: Record<string, unknown>): unknown => {
  const reply = ipc.send({ f, ...extra });
  if (reply.error) throw sqliteError(reply.error);
  return reply.value;
};

const hexOf = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
};

const literal = (value: unknown): string => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw sqliteError(`Provided value cannot be bound to SQLite parameter: ${value}`, 'ERR_INVALID_ARG_TYPE');
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (ArrayBuffer.isView(value)) return `X'${hexOf(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))}'`;
  throw sqliteError(`Provided value cannot be bound to SQLite parameter`, 'ERR_INVALID_ARG_TYPE');
};

const bindParameters = (sql: string, named: Record<string, unknown> | undefined, positional: unknown[], allowBareNamed: boolean): string => {
  let out = '';
  let index = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '?') {
      let j = i + 1;
      while (j < sql.length && /[0-9]/.test(sql[j]!)) j++;
      const explicit = j > i + 1 ? Number(sql.slice(i + 1, j)) : undefined;
      const position = explicit !== undefined ? explicit - 1 : index++;
      if (position >= positional.length) throw sqliteError('column index out of range', 'ERR_SQLITE_ERROR');
      out += literal(positional[position]);
      i = j;
      continue;
    }
    if ((c === ':' || c === '@' || c === '$') && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
      const token = sql.slice(i, j);
      const bare = token.slice(1);
      if (!named || (!(token in named) && !(allowBareNamed && bare in named))) throw sqliteError(`Missing named parameter "${bare}"`, 'ERR_INVALID_STATE');
      out += literal(token in named ? named[token] : named[bare]);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
};

const decodeValue = (value: unknown, readBigInts: boolean): SqlValue => {
  if (value && typeof value === 'object' && (value as { __blob?: boolean }).__blob) {
    const bytes = (value as { bytes: Uint8Array | number[] }).bytes;
    return bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  }
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value) && readBigInts) return BigInt(value);
  if (typeof value === 'number' && readBigInts && Number.isInteger(value)) return BigInt(value);
  return value as SqlValue;
};

interface DatabaseOptions {
  open?: boolean;
  readOnly?: boolean;
  enableForeignKeyConstraints?: boolean;
  readBigInts?: boolean;
  returnArrays?: boolean;
  allowBareNamedParameters?: boolean;
}

export class StatementSync {
  private readBigInts: boolean;
  private returnArrays: boolean;
  private allowBareNamed: boolean;

  constructor(private readonly db: DatabaseSync, private readonly source: string, options: DatabaseOptions) {
    this.readBigInts = options.readBigInts ?? false;
    this.returnArrays = options.returnArrays ?? false;
    this.allowBareNamed = options.allowBareNamedParameters ?? true;
  }

  get sourceSQL(): string { return this.source; }
  get expandedSQL(): string { return this.source; }

  setReadBigInts(enabled: boolean): void { this.readBigInts = enabled; }
  setReturnArrays(enabled: boolean): void { this.returnArrays = enabled; }
  setAllowBareNamedParameters(enabled: boolean): void { this.allowBareNamed = enabled; }

  private bound(params: unknown[]): string {
    const first = params[0];
    const named = first !== null && typeof first === 'object' && !ArrayBuffer.isView(first) ? first as Record<string, unknown> : undefined;
    return bindParameters(this.source, named, named ? params.slice(1) : params, this.allowBareNamed);
  }

  private rows(params: unknown[]): { columns: string[]; values: unknown[][] } {
    const sets = this.db._exec(this.bound(params));
    const last = sets[sets.length - 1];
    return last ?? { columns: [], values: [] };
  }

  private shape(columns: string[], row: unknown[]): unknown {
    const values = row.map((v) => decodeValue(v, this.readBigInts));
    if (this.returnArrays) return values;
    const record: Record<string, unknown> = Object.create(null);
    columns.forEach((column, i) => { record[column] = values[i]; });
    return record;
  }

  all(...params: unknown[]): unknown[] {
    const { columns, values } = this.rows(params);
    return values.map((row) => this.shape(columns, row));
  }

  get(...params: unknown[]): unknown {
    const { columns, values } = this.rows(params);
    return values.length > 0 ? this.shape(columns, values[0]!) : undefined;
  }

  *iterate(...params: unknown[]): IterableIterator<unknown> {
    for (const row of this.all(...params)) yield row;
  }

  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    const sets = this.db._exec(this.bound(params) + ';\nSELECT changes(), last_insert_rowid();');
    const meta = sets[sets.length - 1]?.values[0] ?? [0, 0];
    const changes = Number(meta[0] ?? 0);
    const lastInsertRowid = Number(meta[1] ?? 0);
    return this.readBigInts
      ? { changes: BigInt(changes), lastInsertRowid: BigInt(lastInsertRowid) }
      : { changes, lastInsertRowid };
  }

  columns(): Array<{ name: string; column: null; database: null; table: null; type: null }> {
    const { columns } = this.db._describe(this.source);
    return columns.map((name) => ({ name, column: null, database: null, table: null, type: null }));
  }
}

export class DatabaseSync {
  private handle: number | undefined;
  private readonly options: DatabaseOptions;

  constructor(private readonly location: string | URL | Uint8Array, options: DatabaseOptions = {}) {
    this.options = options;
    if (options.open !== false) this.open();
  }

  get isOpen(): boolean { return this.handle !== undefined; }
  get isTransaction(): boolean { return false; }

  open(): void {
    if (this.handle !== undefined) throw sqliteError('database is already open', 'ERR_INVALID_STATE');
    const raw = this.location instanceof URL ? decodeURIComponent(this.location.pathname) : typeof this.location === 'string' ? this.location : new TextDecoder().decode(this.location);
    const path = raw === ':memory:' ? undefined : raw;
    const reply = call('sqlite.open', { ...(path ? { path } : {}), create: !this.options.readOnly }) as { handle?: number } | undefined;
    if (!reply || typeof reply.handle !== 'number') {
      throw sqliteError('node:sqlite requires the @nightnetwork/dusk-sqlite extension to be activated by the host', 'ERR_DUSK_SQLITE_UNAVAILABLE');
    }
    this.handle = reply.handle;
    if (this.options.enableForeignKeyConstraints !== false) this._exec('PRAGMA foreign_keys = ON;');
  }

  close(): void {
    if (this.handle === undefined) throw sqliteError('database is not open', 'ERR_INVALID_STATE');
    const handle = this.handle;
    this.handle = undefined;
    call('sqlite.close', { handle, flush: !this.options.readOnly });
  }

  _exec(sql: string): ResultSet[] {
    if (this.handle === undefined) throw sqliteError('database is not open', 'ERR_INVALID_STATE');
    const reply = call('sqlite.exec', { handle: this.handle, sql }) as { rows?: ResultSet[] } | undefined;
    return reply?.rows ?? [];
  }

  _describe(sql: string): ResultSet {
    const sets = this._exec(`SELECT * FROM (${sql.replace(/;\s*$/, '')}) LIMIT 0`);
    return sets[0] ?? { columns: [], values: [] };
  }

  exec(sql: string): void {
    this._exec(sql);
  }

  prepare(sql: string): StatementSync {
    if (this.handle === undefined) throw sqliteError('database is not open', 'ERR_INVALID_STATE');
    return new StatementSync(this, sql, this.options);
  }

  function(): never {
    throw sqliteError('user-defined SQL functions are not supported by the Dusk SQLite bridge', 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
  }

  aggregate(): never {
    throw sqliteError('user-defined SQL aggregates are not supported by the Dusk SQLite bridge', 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
  }

  [Symbol.dispose](): void {
    if (this.handle !== undefined) this.close();
  }
}

export const constants = {
  SQLITE_CHANGESET_OMIT: 0,
  SQLITE_CHANGESET_REPLACE: 1,
  SQLITE_CHANGESET_ABORT: 2,
};

export const nodeSqlite = { DatabaseSync, StatementSync, constants };
