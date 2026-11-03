// Making packages uv installed importable from /bin/python3.
//
// uv writes virtual environments into Dusk's filesystem (see uv.ts). Pyodide
// has a filesystem of its own, so before python3 runs, the active
// environment's site-packages is copied in with @tholus/pyodide's mount,
// which checks every extension module's ABI against the running Pyodide
// before writing anything. The copy is skipped when nothing changed since the
// last run.
//
// The active environment is found the way uv finds it: $VIRTUAL_ENV if set,
// otherwise the nearest `.venv` holding a `pyvenv.cfg` in the working
// directory or one of its ancestors.

// Types only: the adapter loads the first time there is an environment to mount.
import type { PyodideLike } from '@tholus/pyodide';
import type { FSBackend } from './fs-backend';
import { collectTree, signTree } from './uv-tree';

/** Where the active environment lives inside Pyodide. One at a time. */
export const ACTIVE_ENV_NAME = 'dusk-active';
const MOUNT_ROOT = `/uv_envs/${ACTIVE_ENV_NAME}/site-packages`;

const parentOf = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf('/')));

export const findVirtualEnv = async (fs: FSBackend, cwd: string, env: Record<string, string>): Promise<string | undefined> => {
  const declared = env['VIRTUAL_ENV'];
  if (declared && (await fs.exists(`${declared}/pyvenv.cfg`))) return declared;
  let dir = cwd || '/';
  while (true) {
    const candidate = dir === '/' ? '/.venv' : `${dir}/.venv`;
    if (await fs.exists(`${candidate}/pyvenv.cfg`)) return candidate;
    if (dir === '/') return undefined;
    dir = parentOf(dir);
  }
};

export const sitePackagesOf = async (fs: FSBackend, venv: string): Promise<string | undefined> => {
  const lib = `${venv}/lib`;
  if (!(await fs.exists(lib))) return undefined;
  const pythons = (await fs.readdir(lib)).filter((name) => /^python3\.\d+$/.test(name)).sort();
  for (const name of pythons.reverse()) {
    const site = `${lib}/${name}/site-packages`;
    if (await fs.exists(site)) return site;
  }
  return undefined;
};

export interface MountOutcome {
  /** site-packages in Dusk's filesystem that is now importable, if any. */
  mounted?: string;
  /** Why an environment was found but not mounted. */
  warning?: string;
}

export interface EnvMounter {
  /** Mount the environment active for `cwd`/`env`, or unmount if there is none. */
  sync(py: PyodideLike, cwd: string, env: Record<string, string>): Promise<MountOutcome>;
}

const UNMOUNT = (root: string): string => `
import shutil, sys
_root = ${JSON.stringify(root)}
for _name, _mod in list(sys.modules.items()):
    _file = getattr(_mod, "__file__", None) or ""
    if _file.startswith(_root + "/"):
        del sys.modules[_name]
while _root in sys.path:
    sys.path.remove(_root)
shutil.rmtree(_root, ignore_errors=True)
import importlib
importlib.invalidate_caches()
`;

const ADD_SITE_DIR = (root: string): string => `
import site
site.addsitedir(${JSON.stringify(root)})
`;

const within = (path: string | undefined, root: string): boolean =>
  path !== undefined && (path === root || path.startsWith(root + '/') || root.startsWith(path + '/'));

export const createEnvMounter = (fs: FSBackend): EnvMounter => {
  let current: { sitePackages: string; signature: string } | undefined;
  // Set by any filesystem mutation that could touch the mounted tree, so an
  // unchanged environment costs no directory walk at all.
  let dirty = true;
  fs.subscribe((event) => {
    if (current && (within(event.path, current.sitePackages) || within(event.previousPath, current.sitePackages))) dirty = true;
  });

  return {
    async sync(py, cwd, env) {
      const venv = await findVirtualEnv(fs, cwd, env);
      const sitePackages = venv ? await sitePackagesOf(fs, venv) : undefined;
      if (!sitePackages) {
        if (current) {
          py.runPython(UNMOUNT(MOUNT_ROOT));
          current = undefined;
        }
        return {};
      }

      if (current?.sitePackages === sitePackages && !dirty) return { mounted: sitePackages };
      dirty = false;
      const signature = await signTree(fs, sitePackages);
      if (current?.sitePackages === sitePackages && current.signature === signature) {
        return { mounted: sitePackages };
      }

      // Modules imported from the old copy would otherwise shadow upgrades.
      if (current) py.runPython(UNMOUNT(MOUNT_ROOT));
      current = undefined;

      const { attachPyodide } = await import('@tholus/pyodide');
      const runtime = attachPyodide({
        exportTree: async (path) => {
          const { entries, bytes } = await collectTree(fs, path);
          return { entries, bytes };
        },
      }, py);
      try {
        await runtime.mount(sitePackages, { name: ACTIVE_ENV_NAME });
      } catch (error) {
        py.runPython(UNMOUNT(MOUNT_ROOT));
        return { warning: `${venv} was not mounted: ${error instanceof Error ? error.message : String(error)}` };
      }
      // .pth files (editable installs, namespace packages) only take effect through site.
      py.runPython(ADD_SITE_DIR(MOUNT_ROOT));
      current = { sitePackages, signature };
      return { mounted: sitePackages };
    },
  };
};
