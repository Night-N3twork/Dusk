import { describe, expect, test } from 'vitest';
import { createMemoryBackend, type FSBackend } from '../src/host/fs-backend';
import { ProcessManager } from '../src/host/process-manager';
import { createUvHost, parseTty, projectRootFor } from '../src/host/uv';
import { fakeUvEndpoint } from './helpers/fake-uv-engine';

const decoder = new TextDecoder();

// What TFS (which backs /home) looks like to uv: no symlinks.
const withoutSymlinks = (fs: FSBackend): FSBackend => ({
  ...fs,
  symlink: async (_target: string, path: string) => {
    throw Object.assign(new Error(`symlinks are not supported on this mount, '${path}'`), { code: 'ENOSYS' });
  },
});

const setup = async (files: Record<string, string> = {}, options: { symlinks?: boolean } = {}) => {
  const fs = options.symlinks === false ? withoutSymlinks(createMemoryBackend()) : createMemoryBackend();
  for (const [path, text] of Object.entries(files)) {
    await fs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true });
    await fs.writeFile(path, text);
  }
  const fake = fakeUvEndpoint();
  const uv = createUvHost({
    fs,
    loadPyodide: () => Promise.reject(new Error('no Pyodide in this test')),
    options: { cache: { kind: 'memory' } },
    createEndpoint: fake.endpoint,
  });
  const pm = new ProcessManager(fs);
  pm.registerStreamingHostBinary('/bin/uv', uv.uv);
  pm.registerStreamingHostBinary('/bin/pip', uv.pip);
  const run = async (cmd: string, args: string[], options: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}) => {
    const result = await pm.spawnSync(cmd, args, { cwd: options.cwd ?? '/home/user/proj', env: options.env ?? {}, ...(options.stdin ? { stdin: options.stdin } : {}) });
    return { status: result.status, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
  };
  return { fs, uv, pm, run, engine: () => fake.engines[0]! };
};

const text = async (fs: FSBackend, path: string): Promise<string | undefined> =>
  (await fs.exists(path)) ? fs.readFile(path) : undefined;

describe('uv host', () => {
  test('boots no engine until the first command', async () => {
    const { run, engine } = await setup({ '/home/user/proj/requirements.txt': 'idna\n' });
    expect(engine()).toBeUndefined();
    const result = await run('/bin/uv', ['echo']);
    expect(result.status).toBe(0);
    expect(engine()).toBeDefined();
  }, 30_000);

  test('hands uv the project, so it can read requirements.txt', async () => {
    const { run } = await setup({ '/home/user/proj/requirements.txt': 'idna==3.11\n' });
    const result = await run('/bin/uv', ['cat', 'requirements.txt']);
    expect(result).toMatchObject({ status: 0, stdout: 'idna==3.11\n' });
  }, 30_000);

  test('finds the project from a subdirectory, the way uv walks up', async () => {
    const { fs, run } = await setup({ '/home/user/proj/pyproject.toml': '[project]\nname = "p"\n', '/home/user/proj/src/app.py': '' });
    expect(await projectRootFor(fs, '/home/user/proj/src')).toBe('/home/user/proj');
    const result = await run('/bin/uv', ['cat', '../pyproject.toml'], { cwd: '/home/user/proj/src' });
    expect(result.stdout).toContain('name = "p"');
  }, 30_000);

  test('leaves node_modules and .git out of what it sends', async () => {
    const { run, engine } = await setup({
      '/home/user/proj/requirements.txt': '',
      '/home/user/proj/node_modules/x/index.js': '',
      '/home/user/proj/.git/HEAD': 'ref: refs/heads/main\n',
    });
    await run('/bin/uv', ['echo']);
    expect(engine().fsKind('/home/user/proj/requirements.txt')).toBe('file');
    expect(engine().fsKind('/home/user/proj/node_modules')).toBeUndefined();
    expect(engine().fsKind('/home/user/proj/.git')).toBeUndefined();
  }, 30_000);

  test('copies a venv uv created back into Dusk, symlink included', async () => {
    const { fs, run } = await setup({ '/home/user/proj/requirements.txt': '' });
    expect((await run('/bin/uv', ['venv'])).status).toBe(0);
    expect(await text(fs, '/home/user/proj/.venv/pyvenv.cfg')).toBe('home = /bin\n');
    expect(await fs.readlink!('/home/user/proj/.venv/bin/python')).toBe('/bin/python3');
  }, 30_000);

  test('keeps a venv whole on a filesystem without symlinks', async () => {
    const { fs, run, engine } = await setup({ '/home/user/proj/requirements.txt': '' }, { symlinks: false });
    const created = await run('/bin/uv', ['venv']);
    expect(created).toMatchObject({ status: 0, stderr: '' });
    // Everything else came back, and the link is on record instead.
    expect(await text(fs, '/home/user/proj/.venv/pyvenv.cfg')).toBe('home = /bin\n');
    expect(JSON.parse((await text(fs, '/home/user/proj/.dusk-symlinks.json'))!)).toEqual({ '.venv/bin/python': '/bin/python3' });

    // A change on Dusk's side forces a resend; the link must survive it.
    await fs.writeFile('/home/user/proj/requirements.txt', 'idna\n');
    await run('/bin/uv', ['echo']);
    expect(engine().fsReadLink('/home/user/proj/.venv/bin/python')).toBe('/bin/python3');
    expect(engine().fsKind('/home/user/proj/.dusk-symlinks.json')).toBeUndefined();
  }, 30_000);

  test('removes what uv uninstalled, and nothing it never saw', async () => {
    const { fs, run } = await setup({
      '/home/user/proj/requirements.txt': '',
      '/home/user/proj/node_modules/keep.js': 'keep',
    });
    await run('/bin/uv', ['venv']);
    await run('/bin/uv', ['pip', 'install', 'idna', 'rich']);
    const site = '/home/user/proj/.venv/lib/python3.14/site-packages';
    expect(await fs.exists(`${site}/idna/__init__.py`)).toBe(true);
    expect(await fs.exists(`${site}/rich/__init__.py`)).toBe(true);

    await run('/bin/uv', ['pip', 'uninstall', 'idna']);
    expect(await fs.exists(`${site}/idna`)).toBe(false);
    expect(await fs.exists(`${site}/rich/__init__.py`)).toBe(true);
    expect(await text(fs, '/home/user/proj/node_modules/keep.js')).toBe('keep');
  }, 30_000);

  test('does not resend a project nothing changed in', async () => {
    const { fs, run, engine } = await setup({ '/home/user/proj/requirements.txt': 'a\n' });
    await run('/bin/uv', ['echo']);
    // Changed only on uv's side: if Dusk resent the tree, this would be overwritten.
    engine().fsWrite('/home/user/proj/marker', new TextEncoder().encode('uv-side'));
    await run('/bin/uv', ['echo']);
    expect(engine().text('/home/user/proj/marker')).toBe('uv-side');
    // And it came back to Dusk.
    expect(await text(fs, '/home/user/proj/marker')).toBe('uv-side');

    // A change on Dusk's side is sent, and replaces uv's copy.
    await fs.writeFile('/home/user/proj/requirements.txt', 'b\n');
    await run('/bin/uv', ['echo']);
    expect(engine().text('/home/user/proj/requirements.txt')).toBe('b\n');
  }, 30_000);

  test('a file Dusk deleted does not linger on uv\'s side', async () => {
    const { fs, run, engine } = await setup({ '/home/user/proj/requirements.txt': '', '/home/user/proj/old.txt': 'x' });
    await run('/bin/uv', ['echo']);
    await fs.rm('/home/user/proj/old.txt');
    await run('/bin/uv', ['echo']);
    expect(engine().fsKind('/home/user/proj/old.txt')).toBeUndefined();
  }, 30_000);

  test('brings back what a failed command wrote', async () => {
    const { fs, run } = await setup({ '/home/user/proj/requirements.txt': '' });
    const result = await run('/bin/uv', ['fail-after-write']);
    expect(result).toMatchObject({ status: 1, stderr: 'boom\n' });
    expect(await text(fs, '/home/user/proj/partial.txt')).toBe('half');
  }, 30_000);

  test('passes cwd and env through, and DUSK_TTY becomes a terminal instead of a variable', async () => {
    const { run } = await setup({ '/home/user/proj/requirements.txt': '' });
    const plain = JSON.parse((await run('/bin/uv', ['echo'], { env: { FOO: 'bar' } })).stdout);
    expect(plain).toMatchObject({ cwd: '/home/user/proj', env: { FOO: 'bar' } });
    expect(plain.tty).toBeUndefined();

    const attached = JSON.parse((await run('/bin/uv', ['echo'], { env: { DUSK_TTY: '120x40' } })).stdout);
    expect(attached.tty).toEqual({ cols: 120, rows: 40 });
    expect(attached.env.DUSK_TTY).toBeUndefined();
  }, 30_000);

  test('reads standard input only when told to with -', async () => {
    const { run } = await setup({ '/home/user/proj/requirements.txt': '' });
    const ignored = JSON.parse((await run('/bin/uv', ['echo'], { stdin: 'idna\n' })).stdout);
    expect(ignored.stdin).toBeUndefined();
    const read = JSON.parse((await run('/bin/uv', ['echo', '-r', '-'], { stdin: 'idna\n' })).stdout);
    expect(read.stdin).toBe('idna\n');
  }, 30_000);

  test('syncs $VIRTUAL_ENV too when it lies outside the project', async () => {
    const { fs, run } = await setup({ '/home/user/proj/requirements.txt': '' });
    await run('/bin/uv', ['venv', '/opt/env']);
    expect(await fs.exists('/opt/env/pyvenv.cfg')).toBe(false); // outside every synced root
    await fs.mkdir('/opt/env', { recursive: true });
    await fs.writeFile('/opt/env/pyvenv.cfg', 'home = /bin\n');
    await run('/bin/uv', ['pip', 'install', 'idna'], { env: { VIRTUAL_ENV: '/opt/env' } });
    expect(await fs.exists('/opt/env/lib/python3.14/site-packages/idna/__init__.py')).toBe(true);
  }, 30_000);

  test('kill cancels a running command', async () => {
    const { pm, uv } = await setup({ '/home/user/proj/requirements.txt': '' });
    const handle = await pm.spawn('/bin/uv', ['wait'], { cwd: '/home/user/proj' });
    await uv.engine();
    await new Promise((resolve) => setTimeout(resolve, 50));
    handle.kill();
    expect(await handle.exit).toBe(137);
    // The engine is free for the next command, rather than stuck behind the cancelled one.
    const next = await pm.spawnSync('/bin/uv', ['echo'], { cwd: '/home/user/proj' });
    expect(next.status).toBe(0);
  }, 30_000);

  test('reports an engine that will not start instead of hanging', async () => {
    const fs = createMemoryBackend();
    const uv = createUvHost({
      fs,
      loadPyodide: () => Promise.reject(new Error('unused')),
      createEndpoint: () => { throw new Error('no worker here'); },
    });
    const pm = new ProcessManager(fs);
    pm.registerStreamingHostBinary('/bin/uv', uv.uv);
    const result = await pm.spawnSync('/bin/uv', ['--version'], { cwd: '/' });
    expect(result.status).toBe(1);
    expect(decoder.decode(result.stderr)).toContain('could not start the uv engine: no worker here');
  }, 30_000);
});

describe('pip shim', () => {
  test('runs uv pip', async () => {
    const { run } = await setup({ '/home/user/proj/requirements.txt': '' });
    expect((await run('/bin/pip', ['--version'])).stdout).toBe('uv-pip (fake)\n');
  }, 30_000);

  test('creates a venv for pip install when there is none, and installs into it', async () => {
    const { fs, run } = await setup({ '/home/user/proj/requirements.txt': '' });
    const result = await run('/bin/pip', ['install', 'idna']);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('creating /home/user/proj/.venv');
    expect(await fs.exists('/home/user/proj/.venv/lib/python3.14/site-packages/idna/__init__.py')).toBe(true);
  }, 30_000);

  test('leaves an explicit target alone', async () => {
    const { fs, run } = await setup({ '/home/user/proj/requirements.txt': '' });
    const result = await run('/bin/pip', ['install', '--system', 'idna']);
    expect(result.stderr).not.toContain('creating');
    expect(await fs.exists('/home/user/proj/.venv')).toBe(false);
  }, 30_000);
});

test('parseTty accepts only a positive <cols>x<rows>', () => {
  expect(parseTty('80x24')).toEqual({ cols: 80, rows: 24 });
  expect(parseTty('0x24')).toBeUndefined();
  expect(parseTty('wide')).toBeUndefined();
  expect(parseTty(undefined)).toBeUndefined();
});
