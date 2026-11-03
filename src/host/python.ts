// Host-side Python bridge for /bin/python3 and the dsh built-in.
//
// Uses Pyodide (CPython compiled to WASM) loaded lazily on first use.
// Pyodide is large (~10MB WASM + stdlib) so we do NOT load it at boot —
// only when python.exec is first called.
//
// One shared interpreter is reused across invocations. This is safe for
// the shell use case (each invocation gets a fresh globals dict via a
// script wrapper), and avoids re-paying the ~2s WASM init cost.
//
// TFS integration: files can be pushed to Pyodide's in-memory FS via
// python.writeInputFile before exec, and pulled back via python.readOutputFile
// after. The /bin/python3 CLI wraps this so `python3 script.py` reads the
// script from TFS.

import type { FuncTable } from './engine-instance';
import type { FSBackend } from './fs-backend';
import { createEnvMounter, type EnvMounter } from './python-env';

type PyodideInterface = {
  runPython: (code: string) => unknown;
  runPythonAsync: (code: string) => Promise<unknown>;
  FS: {
    writeFile: (path: string, data: string | Uint8Array) => void;
    readFile: (path: string, opts?: { encoding?: string }) => string | Uint8Array;
    mkdirTree: (path: string) => void;
    unlink: (path: string) => void;
    analyzePath: (path: string) => { exists: boolean };
  };
  setStdout: (opts: { batched?: (s: string) => void; raw?: (n: number) => void; isatty?: boolean }) => void;
  setStderr: (opts: { batched?: (s: string) => void; raw?: (n: number) => void; isatty?: boolean }) => void;
  version: string;
};

let pyodidePromise: Promise<PyodideInterface> | undefined;

export const loadPyodide = async (): Promise<PyodideInterface> => {
  if (!pyodidePromise) {
    pyodidePromise = (async (): Promise<PyodideInterface> => {
      // The pyodide package exports a `loadPyodide` factory. We call it with
      // an `indexURL` that points to our served pyodide asset dir. Vite's
      // ?url import handles the WASM; the .mjs module itself imports internal
      // paths relative to its own module URL, so we tell pyodide where those
      // live via indexURL.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await import('pyodide') as unknown as { loadPyodide: (opts: { indexURL: string; stdout?: (s: string) => void; stderr?: (s: string) => void }) => Promise<PyodideInterface> };
      // Point at the CDN by default — packaging pyodide's ~30MB of assets
      // into our own dist for offline use is a follow-up.
      // The URL below matches the installed pyodide version exactly.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkg = (await import('pyodide/package.json')).default as { version: string };
      const indexURL = 'https://cdn.jsdelivr.net/pyodide/v' + pkg.version + '/full/';
      const py = await mod.loadPyodide({ indexURL });
      return py;
    })();
  }
  return pyodidePromise;
};

const ok = (send: (m: unknown) => void, value: unknown): void => { send({ value }); };
const err = (send: (m: unknown) => void, e: unknown): void => {
  send({ error: e instanceof Error ? e.message : String(e) });
};

// Sanitize output that Pyodide might have batched with an unexpected shape.
const asStr = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  return String(v);
};

// One mounter per filesystem: it remembers what is already in Pyodide.
const mounters = new WeakMap<FSBackend, EnvMounter>();
const mounterFor = (fs: FSBackend): EnvMounter => {
  let mounter = mounters.get(fs);
  if (!mounter) { mounter = createEnvMounter(fs); mounters.set(fs, mounter); }
  return mounter;
};

export const createPythonFuncs = (fs: FSBackend): FuncTable => ({
  // python.exec { code: string, argv?: string[], stdin?: string, scriptPath?: string, cwd?: string }
  //   → { stdout: string, stderr: string, exitCode: number }
  // Runs `code` with argv/stdin plumbed in. If scriptPath is set, __file__ is
  // configured to point at it (useful for scripts loaded from TFS).
  'python.exec': (m, send): void => {
    void (async (): Promise<void> => {
      try {
        const py = await loadPyodide();
        const code = m['code'] as string;
        const argv = (m['argv'] as string[] | undefined) ?? ['python3'];
        const stdin = (m['stdin'] as string | undefined) ?? '';
        const scriptPath = m['scriptPath'] as string | undefined;
        const cwd = m['cwd'] as string | undefined;
        const env = (m['env'] as Record<string, string> | undefined) ?? {};

        // Packages uv installed into the active virtualenv become importable.
        let mountWarning = '';
        if (cwd !== undefined) {
          const outcome = await mounterFor(fs).sync(py as unknown as Parameters<EnvMounter['sync']>[0], cwd, env);
          if (outcome.warning) mountWarning = `python3: ${outcome.warning}\n`;
        }

        // Buffer stdout/stderr for this execution. Pyodide's setStdout
        // is process-global, not per-call, so we swap it around this run.
        let stdoutBuf = '';
        let stderrBuf = mountWarning;
        py.setStdout({ batched: (s) => { stdoutBuf += asStr(s) + '\n'; } });
        py.setStderr({ batched: (s) => { stderrBuf += asStr(s) + '\n'; } });

        // Set sys.argv, sys.stdin, and __file__ (if applicable) before running.
        // Wrap user code in a top-level try so the exit code reflects errors.
        py.runPython(`
import sys, io
sys.argv = ${JSON.stringify(argv)}
sys.stdin = io.StringIO(${JSON.stringify(stdin)})
${scriptPath ? `__file__ = ${JSON.stringify(scriptPath)}` : ''}
`);
        let exitCode = 0;
        try {
          // runPythonAsync supports top-level await in the script.
          await py.runPythonAsync(code);
        } catch (e) {
          // Pyodide's PythonError carries the traceback string in .message.
          stderrBuf += (e instanceof Error ? (e.message + '\n') : String(e) + '\n');
          exitCode = 1;
        }
        ok(send, { stdout: stdoutBuf, stderr: stderrBuf, exitCode });
      } catch (e) { err(send, e); }
    })();
  },

  // python.version → { version: string }
  'python.version': (_m, send): void => {
    void (async (): Promise<void> => {
      try {
        const py = await loadPyodide();
        ok(send, { version: py.version });
      } catch (e) { err(send, e); }
    })();
  },

  // python.writeFile { path, data } → { ok }
  //   Write into Pyodide's in-memory FS at the given absolute path.
  //   Used by /bin/python3 to seed input files (or the script itself) before exec.
  'python.writeFile': (m, send): void => {
    void (async (): Promise<void> => {
      try {
        const py = await loadPyodide();
        const path = m['path'] as string;
        const data = m['data'] as string;
        // Ensure parent dir exists in Pyodide's FS.
        const parent = path.substring(0, path.lastIndexOf('/'));
        if (parent && !py.FS.analyzePath(parent).exists) py.FS.mkdirTree(parent);
        py.FS.writeFile(path, data);
        ok(send, { ok: true });
      } catch (e) { err(send, e); }
    })();
  },

  // python.readFile { path } → { data }
  //   Read a file from Pyodide's in-memory FS.
  'python.readFile': (m, send): void => {
    void (async (): Promise<void> => {
      try {
        const py = await loadPyodide();
        const path = m['path'] as string;
        const raw = py.FS.readFile(path, { encoding: 'utf8' });
        ok(send, { data: typeof raw === 'string' ? raw : new TextDecoder().decode(raw) });
      } catch (e) { err(send, e); }
    })();
  },
  // Marker so TS uses `fs` outside python.exec.
  __py_touch_fs: ((_m: Record<string, unknown>, send: (m: unknown) => void): void => {
    void fs; ok(send, { ok: true });
  }) as unknown as FuncTable[string],
});
