import { describe, expect, test } from 'vitest';
import type { PyodideLike } from '@tholus/pyodide';
import { createMemoryBackend } from '../src/host/fs-backend';
import { createEnvMounter, findVirtualEnv, sitePackagesOf } from '../src/host/python-env';

const MOUNTED = '/uv_envs/dusk-active/site-packages';

// Enough of Pyodide for @tholus/pyodide's probe and mount, plus a log of the
// Python Dusk runs so the tests can see mounts and unmounts.
const fakePyodide = (extensionSuffix = '.cpython-314-wasm32-emscripten.so') => {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(['/']);
  const ran: string[] = [];
  let writes = 0;
  const py: PyodideLike = {
    version: '314.0.5',
    runPython(code: string) {
      if (code.includes('json.dumps')) {
        return JSON.stringify({ pythonVersion: '3.14.0', extensionSuffix, platform: 'emscripten-5.0.3-wasm32', sitePackages: '/lib/python3.14/site-packages' });
      }
      ran.push(code);
      if (code.includes('shutil.rmtree')) {
        for (const path of [...files.keys()]) if (path.startsWith(MOUNTED + '/')) files.delete(path);
      }
      return undefined;
    },
    FS: {
      writeFile(path, data) { files.set(path, data); writes++; },
      mkdirTree(path) { dirs.add(path); },
      symlink() { /* unused */ },
      analyzePath(path) { return { exists: files.has(path) || dirs.has(path) }; },
      readFile(path) { return files.get(path)!; },
      readdir() { return []; },
      lstat() { return { mode: 0 }; },
      readlink() { return ''; },
      unlink(path) { files.delete(path); },
      rmdir(path) { dirs.delete(path); },
      isDir() { return false; },
      isFile() { return true; },
      isLink() { return false; },
    },
  };
  return { py, files, ran, writes: () => writes };
};

const seedVenv = async (fs: ReturnType<typeof createMemoryBackend>, venv: string, pkgs: Record<string, string>) => {
  await fs.mkdir(`${venv}/lib/python3.14/site-packages`, { recursive: true });
  await fs.writeFile(`${venv}/pyvenv.cfg`, 'home = /bin\n');
  for (const [rel, text] of Object.entries(pkgs)) {
    const path = `${venv}/lib/python3.14/site-packages/${rel}`;
    await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(path, text);
  }
};

describe('finding the active environment', () => {
  test('prefers $VIRTUAL_ENV, then the nearest .venv up the tree', async () => {
    const fs = createMemoryBackend();
    await seedVenv(fs, '/home/user/proj/.venv', {});
    await seedVenv(fs, '/opt/env', {});
    await fs.mkdir('/home/user/proj/src/deep', { recursive: true });
    expect(await findVirtualEnv(fs, '/home/user/proj/src/deep', {})).toBe('/home/user/proj/.venv');
    expect(await findVirtualEnv(fs, '/home/user/proj', { VIRTUAL_ENV: '/opt/env' })).toBe('/opt/env');
    expect(await findVirtualEnv(fs, '/tmp', {})).toBeUndefined();
    expect(await sitePackagesOf(fs, '/opt/env')).toBe('/opt/env/lib/python3.14/site-packages');
  });
});

describe('mounting into Pyodide', () => {
  test('makes the venv importable, through site so .pth files apply', async () => {
    const fs = createMemoryBackend();
    await seedVenv(fs, '/home/user/proj/.venv', { 'idna/__init__.py': '__version__ = "3.11"\n' });
    const fake = fakePyodide();
    const outcome = await createEnvMounter(fs).sync(fake.py, '/home/user/proj', {});
    expect(outcome).toEqual({ mounted: '/home/user/proj/.venv/lib/python3.14/site-packages' });
    expect(new TextDecoder().decode(fake.files.get(`${MOUNTED}/idna/__init__.py`))).toBe('__version__ = "3.11"\n');
    expect(fake.ran.some((code) => code.includes('site.addsitedir'))).toBe(true);
  });

  test('costs nothing on a second run when nothing changed', async () => {
    const fs = createMemoryBackend();
    await seedVenv(fs, '/home/user/proj/.venv', { 'idna/__init__.py': 'x' });
    const fake = fakePyodide();
    const envs = createEnvMounter(fs);
    await envs.sync(fake.py, '/home/user/proj', {});
    const writes = fake.writes();
    await envs.sync(fake.py, '/home/user/proj', {});
    expect(fake.writes()).toBe(writes);
  });

  test('remounts after an install, dropping modules imported from the old copy', async () => {
    const fs = createMemoryBackend();
    await seedVenv(fs, '/home/user/proj/.venv', { 'idna/__init__.py': 'x' });
    const fake = fakePyodide();
    const envs = createEnvMounter(fs);
    await envs.sync(fake.py, '/home/user/proj', {});
    await fs.mkdir('/home/user/proj/.venv/lib/python3.14/site-packages/rich', { recursive: true });
    await fs.writeFile('/home/user/proj/.venv/lib/python3.14/site-packages/rich/__init__.py', 'y');
    fake.ran.length = 0;
    await envs.sync(fake.py, '/home/user/proj', {});
    expect(fake.ran.some((code) => code.includes('del sys.modules[_name]'))).toBe(true);
    expect(fake.files.has(`${MOUNTED}/rich/__init__.py`)).toBe(true);
  });

  test('unmounts when the directory has no environment', async () => {
    const fs = createMemoryBackend();
    await seedVenv(fs, '/home/user/proj/.venv', { 'idna/__init__.py': 'x' });
    await fs.mkdir('/tmp', { recursive: true });
    const fake = fakePyodide();
    const envs = createEnvMounter(fs);
    await envs.sync(fake.py, '/home/user/proj', {});
    expect(await envs.sync(fake.py, '/tmp', {})).toEqual({});
    expect(fake.files.has(`${MOUNTED}/idna/__init__.py`)).toBe(false);
  });

  test('refuses an extension module built for another Python, with a warning not a crash', async () => {
    const fs = createMemoryBackend();
    await seedVenv(fs, '/home/user/proj/.venv', { 'fast/_speedups.cpython-312-x86_64-linux-gnu.so': '' });
    const fake = fakePyodide();
    const outcome = await createEnvMounter(fs).sync(fake.py, '/home/user/proj', {});
    expect(outcome.mounted).toBeUndefined();
    expect(outcome.warning).toContain('cpython-312-x86_64-linux-gnu');
    expect(fake.files.size).toBe(0);
  });
});
