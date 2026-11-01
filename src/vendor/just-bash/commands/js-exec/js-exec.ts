// @ts-nocheck
// DuskJS replacement for just-bash's js-exec.
//
// The original js-exec ran JS in a QuickJS WASM worker for sandboxing. In
// DuskJS the whole dsh binary already runs inside the SpiderMonkey engine
// worker (which IS the sandbox — WASI-isolated from the host page). So we
// can eval user JS directly in this engine's globalThis. Captures console
// output and returns it as the command's stdout/stderr.
//
// Available inside the code: everything the DuskJS engine exposes —
// `require('node:*')`, `process`, `console`, `Buffer`, TextEncoder/Decoder,
// timers, crypto shim, etc. See src/world/world.ts for the polyfill set.
//
// For a true child-process shell-out to /bin/node (with full process
// isolation and its own module cache), see /bin/node — invoke it directly
// from bash: `/bin/node -e "..."`. This js-exec command is a lightweight
// in-process eval that avoids the spawn cost.

import type { Command, CommandContext, ExecResult } from "../../types.js";
import { hasHelpFlag } from "../help.js";
import { DefenseInDepthBox } from "../../security/defense-in-depth-box.js";

const HELP = `js-exec - Evaluate JavaScript in the current DuskJS engine

Usage: js-exec [OPTIONS] [-c CODE | FILE] [ARGS...]

Options:
  -c CODE          Execute inline code
  -e CODE          Alias for -c
  --version, -V    Show version
  --help           Show this help

Examples:
  js-exec -c "console.log(2 + 2)"
  js-exec -c "console.log(require('node:os').platform())"
  echo 'console.log("hi")' | js-exec

Runs in the current DuskJS engine's globalThis (not sandboxed). For a
separate process with its own state, use /bin/node instead.`;

const parseArgs = (argv) => {
  let code = null;
  let file = null;
  let showVersion = false;
  let fromStdin = false;
  const args = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "-c" || a === "-e") {
      if (i + 1 >= argv.length) return { error: "js-exec: option " + a + " requires an argument" };
      code = argv[i + 1];
      for (let j = i + 2; j < argv.length; j++) args.push(argv[j]);
      break;
    } else if (a === "--version" || a === "-V") {
      showVersion = true;
      i++;
    } else if (a === "--help" || a === "-h") {
      // Handled by hasHelpFlag pre-check.
      i++;
    } else if (a === "--") {
      for (let j = i + 1; j < argv.length; j++) args.push(argv[j]);
      break;
    } else if (a && a.length > 1 && a[0] === "-") {
      return { error: "js-exec: unknown option: " + a };
    } else {
      file = a;
      for (let j = i + 1; j < argv.length; j++) args.push(argv[j]);
      break;
    }
    if (i >= argv.length) break;
  }
  if (code === null && file === null && !showVersion) fromStdin = true;
  return { code, file, showVersion, fromStdin, args };
};

const runCode = async (code: string, stdin: string, cwd: string, args: string[]): Promise<ExecResult> => {
  const g = globalThis;
  let stdoutBuf = "";
  let stderrBuf = "";

  // Capture console output.
  const origConsole = g.console;
  const captureConsole = {
    log: (...xs) => { stdoutBuf += xs.map((x) => (typeof x === "string" ? x : String(x))).join(" ") + "\n"; },
    error: (...xs) => { stderrBuf += xs.map((x) => (typeof x === "string" ? x : String(x))).join(" ") + "\n"; },
    warn: (...xs) => { stderrBuf += xs.map((x) => (typeof x === "string" ? x : String(x))).join(" ") + "\n"; },
    info: (...xs) => { stdoutBuf += xs.map((x) => (typeof x === "string" ? x : String(x))).join(" ") + "\n"; },
    debug: () => { /* silent */ },
    trace: (...xs) => { stderrBuf += xs.map((x) => (typeof x === "string" ? x : String(x))).join(" ") + "\n"; },
    dir: (obj) => { stdoutBuf += String(obj) + "\n"; },
    group: () => {},
    groupCollapsed: () => {},
    groupEnd: () => {},
    time: () => {},
    timeEnd: () => {},
    timeLog: () => {},
    count: () => {},
    countReset: () => {},
    assert: (cond, ...xs) => { if (!cond) stderrBuf += "Assertion failed: " + xs.map(String).join(" ") + "\n"; },
    table: (obj) => { stdoutBuf += String(obj) + "\n"; },
    clear: () => {},
  };

  // Swap argv temporarily so scripts see their args.
  const origArgv = g.process?.argv;
  const origCwd = g.process?._cwd;
  const origEnv = g.process?.env;

  if (g.process) {
    // process.argv[0] = 'node', [1] = '<eval>' or filename, [2..] = args
    try { g.process.argv = ["node", "<eval>", ...args]; } catch { /* */ }
  }

  g.console = captureConsole;

  try {
    // eval the user code. Wrapping in an async function to allow top-level await.
    // The `code` here can be any JS — sync or async. DefenseInDepthBox blocks
    // eval during script execution; runTrusted temporarily marks the frame as
    // trusted so eval is permitted. (We're inside a WASI-isolated engine
    // already, so this doesn't defeat any real isolation.)
    const wrapped = "(async () => { " + code + "\n})();";
    const lifecycle = g.__process?.__duskLifecycle;
    const baseline = lifecycle && typeof lifecycle.active === "function" ? lifecycle.active() : 0;
    // eslint-disable-next-line no-eval
    const result = await DefenseInDepthBox.runTrustedAsync(async () => (0, eval)(wrapped));
    if (result && typeof result.then === "function") await result;
    if (lifecycle && typeof lifecycle.whenAtMost === "function") await lifecycle.whenAtMost(baseline);
    return { stdout: stdoutBuf, stderr: stderrBuf, exitCode: 0 };
  } catch (e) {
    stderrBuf += (e && e.stack ? e.stack : String(e)) + "\n";
    return { stdout: stdoutBuf, stderr: stderrBuf, exitCode: 1 };
  } finally {
    g.console = origConsole;
    if (g.process) {
      try { if (origArgv) g.process.argv = origArgv; } catch { /* */ }
      // env/cwd restore is a no-op since we didn't touch them; belt and suspenders.
      void origEnv; void origCwd; void stdin; void cwd;
    }
  }
};

export const jsExecCommand: Command = {
  name: "js-exec",

  async execute(argv: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(argv)) {
      return { stdout: HELP + "\n", stderr: "", exitCode: 0 };
    }

    const parsed = parseArgs(argv);
    if ("error" in parsed) {
      return { stdout: "", stderr: parsed.error + "\n", exitCode: 2 };
    }
    if (parsed.showVersion) {
      return { stdout: "js-exec (DuskJS in-engine eval) 1.0.0\n", stderr: "", exitCode: 0 };
    }

    let code = parsed.code;

    if (parsed.fromStdin) {
      const stdinText = typeof ctx.stdin === "string" ? ctx.stdin : "";
      // No -c, no file, no piped input — the user typed `node` or `js-exec`
      // expecting an interactive REPL. We don't have one inside dsh (dsh is
      // line-based, not stream-based). Print a hint instead of silently
      // consuming empty stdin.
      if (!stdinText) {
        const name = argv[0] === "node" ? "node" : "js-exec";
        return {
          stdout: "",
          stderr: name + ": interactive REPL not available inside dsh.\n" +
                  "  Use: " + name + " -c \"<code>\"   or   echo '<code>' | " + name + "\n" +
                  "  For a real REPL, spawn /bin/node directly from the host.\n",
          exitCode: 1,
        };
      }
      code = stdinText;
    } else if (parsed.file !== null) {
      try {
        code = await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, parsed.file));
      } catch (e) {
        return {
          stdout: "",
          stderr: "js-exec: " + parsed.file + ": " + (e && e.message ? e.message : String(e)) + "\n",
          exitCode: 1,
        };
      }
    }

    if (code === null || code === "") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    return await runCode(code, "", ctx.cwd, parsed.args);
  },
};

// The registry expects a `nodeStubCommand` export. Our js-exec is already the
// full node runtime (in-engine eval), so `node` is an alias of the same impl.
export const nodeStubCommand = { ...jsExecCommand, name: "node" };
export const jsCommand = jsExecCommand;

export const flagsForFuzzing = {
  name: "js-exec",
  flags: [
    { flag: "-c", type: "value" },
    { flag: "-e", type: "value" },
    { flag: "--version", type: "boolean" },
    { flag: "-V", type: "boolean" },
  ],
  stdinType: "text",
  needsArgs: false,
};
