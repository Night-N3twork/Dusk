import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';
import { ProcessManager } from '../src/host/process-manager';
import { createMemoryBackend } from '../src/host/fs-backend';
import type { FuncTable } from '../src/host/engine-instance';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

test('node:test runs suites, hooks, subtests and mocks with TAP output', async () => {
  const backend = createMemoryBackend();
  await backend.writeFile('/t.mjs', `
    import { test, describe, it, before, beforeEach, mock } from 'node:test';
    import assert from 'node:assert/strict';
    const log = [];
    before(() => log.push('before'));
    describe('math', () => {
      beforeEach(() => log.push('each'));
      it('adds', () => assert.equal(1 + 1, 2));
      it('fails', () => assert.equal(1 + 1, 3));
      it.skip('skipped', () => {});
      it.todo('later');
    });
    test('async with subtest', async (t) => {
      await t.test('inner', () => { const fn = mock.fn((x) => x * 2); fn(2); assert.equal(fn.mock.callCount(), 1); assert.equal(fn.mock.calls[0].result, 4); });
    });
    test('callback style', (t, done) => setTimeout(done, 5));
    test('report', () => { console.log('LOG:' + log.join(',')); });
  `);
  const pm = new ProcessManager(backend);
  const r = await pm.spawnSync('/bin/node', ['/t.mjs'], { cwd: '/' });
  const out = decode(r.stdout);
  expect(out).toContain('TAP version 13');
  expect(out).toContain('ok 1 - adds');
  expect(out).toContain('not ok 2 - fails');
  expect(out).toContain('# SKIP');
  expect(out).toContain('# TODO');
  expect(out).toContain('ok 1 - inner');
  expect(out).toContain('ok 3 - callback style');
  expect(out).toContain('LOG:before,each,each');
  expect(out).toMatch(/# pass 5\n# fail 1/);
  expect(r.status).toBe(1);
}, 60_000);

test('diagnostics_channel publishes to subscribers and traces promises', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const dc = require('node:diagnostics_channel'); const seen = []; dc.subscribe('my:ch', (m, name) => seen.push(name + '=' + m.v)); " +
    "dc.channel('my:ch').publish({ v: 1 }); const tc = dc.tracingChannel('op'); " +
    "tc.subscribe({ start: () => seen.push('start'), asyncEnd: (ctx) => seen.push('asyncEnd:' + ctx.result) }); " +
    "tc.tracePromise(async () => 42, {}).then(() => process.stdout.write('DC:' + seen.join(',') + '|' + dc.hasSubscribers('my:ch') + ':END'));"
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  await repl.engine.terminate();
  expect(out.join('')).toContain('DC:my:ch=1,start,asyncEnd:42|true:END');
}, 60_000);

test('v8 serialize round-trips structured values and stubs report unsupported transports', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const v8 = require('node:v8'); const value = { m: new Map([[1, 'a']]), s: new Set([2n]), d: new Date(5), r: /x/g, b: new Uint16Array([7]), u: undefined, n: NaN }; " +
    "const back = v8.deserialize(v8.serialize(value)); " +
    "const sock = require('node:dgram').createSocket('udp4'); " +
    "sock.bind(0, (err) => { const h2 = require('node:http2'); " +
    "process.stdout.write('V:' + [back.m.get(1), typeof [...back.s][0], back.d.getTime(), back.r.flags, back.b[0], 'u' in back, Number.isNaN(back.n), " +
    "typeof v8.getHeapStatistics().heap_size_limit, err.code, h2.constants.HTTP2_HEADER_PATH, require('node:module').isBuiltin('node:test')].join('|') + ':END'); });"
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  await repl.engine.terminate();
  expect(out.join('')).toContain('V:a|bigint|5|g|7|true|true|number|EAFNOSUPPORT|:path|true:END');
}, 60_000);

test('node:sqlite binds parameters safely over the sqlite extension bridge', async () => {
  const statements: string[] = [];
  let rowid = 0;
  const funcs: FuncTable = {
    'sqlite.open': (_m, send) => send({ value: { handle: 7 } }),
    'sqlite.close': (_m, send) => send({ value: true }),
    'sqlite.exec': (m, send) => {
      const sql = m['sql'] as string;
      statements.push(sql);
      if (sql.includes('changes()')) { rowid++; send({ value: { rows: [{ columns: ['changes()', 'last_insert_rowid()'], values: [[1, rowid]] }] } }); return; }
      if (sql.startsWith('SELECT')) { send({ value: { rows: [{ columns: ['id', 'name', 'blob'], values: [[1, "o'k", { __blob: true, bytes: [1, 2] }]] }] } }); return; }
      send({ value: { rows: [] } });
    },
  };
  const pm = new ProcessManager(createMemoryBackend(), {}, funcs);
  const code = "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); " +
    "db.exec('CREATE TABLE t (id INTEGER, name TEXT)'); const ins = db.prepare('INSERT INTO t VALUES (?, :name) -- ?'); " +
    "const r = ins.run({ name: \"it's\" }, 5); const row = db.prepare(\"SELECT * FROM t WHERE name = '?'\").get(); " +
    "console.log(JSON.stringify([r.changes, r.lastInsertRowid, row.name, Array.from(row.blob)])); db.close();";
  const r = await pm.spawnSync('/bin/node', ['-e', code], { cwd: '/' });
  expect(decode(r.stderr)).toBe('');
  expect(decode(r.stdout)).toContain('[1,1,"o\'k",[1,2]]');
  expect(statements).toContain("INSERT INTO t VALUES (5, 'it''s') -- ?;\nSELECT changes(), last_insert_rowid();");
  expect(statements).toContain("SELECT * FROM t WHERE name = '?'");
}, 60_000);

test('node:sqlite reports a clear error without the extension', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const r = await pm.spawnSync('/bin/node', ['-e', "try { new (require('node:sqlite').DatabaseSync)(':memory:'); } catch (e) { console.log(e.code); }"], { cwd: '/' });
  expect(decode(r.stdout)).toContain('ERR_DUSK_SQLITE_UNAVAILABLE');
}, 60_000);
