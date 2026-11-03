// dsh custom command: python3 (and alias `python`).
//
// Same public CLI as /bin/python3 minus the REPL: inside dsh, python3
// runs in one-shot mode. For a REPL, invoke /bin/python3 directly.

// @ts-nocheck
import type { Command, CommandContext, ExecResult } from '../../../vendor/just-bash/types';

type Ipc = { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const call = (f: string, args: Record<string, unknown> = {}): unknown => {
  const ipc = (globalThis as { ipc?: Ipc }).ipc;
  if (!ipc) throw new Error('python3: ipc unavailable in this context');
  const r = ipc.send({ f, ...args });
  if (r.error) throw new Error(r.error);
  return r.value;
};

export const python3Command: Command = {
  name: 'python3',
  trusted: true,
  async execute(argv: string[], ctx: CommandContext): Promise<ExecResult> {
    let inlineCode: string | null = null;
    let scriptPath: string | null = null;
    let readStdinFlag = false;
    const scriptArgs: string[] = [];

    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === '-c' && i + 1 < argv.length) {
        inlineCode = argv[i + 1]!;
        for (let j = i + 2; j < argv.length; j++) scriptArgs.push(argv[j]!);
        break;
      }
      if (a === '--version' || a === '-V') {
        try {
          const r = call('python.version') as { version: string };
          return { stdout: 'Python ' + r.version + '\n', stderr: '', exitCode: 0 };
        } catch (e) {
          return { stdout: '', stderr: 'python3: ' + (e instanceof Error ? e.message : String(e)) + '\n', exitCode: 1 };
        }
      }
      if (a === '--help' || a === '-h') {
        return {
          stdout: 'python3 (dsh built-in) [-c CODE | SCRIPT | -] [args...]\n',
          stderr: '', exitCode: 0,
        };
      }
      if (a === '-') { readStdinFlag = true; for (let j = i + 1; j < argv.length; j++) scriptArgs.push(argv[j]!); break; }
      if (a.startsWith('-') && a.length > 1) {
        return { stdout: '', stderr: 'python3: unrecognized option: ' + a + '\n', exitCode: 2 };
      }
      scriptPath = a;
      for (let j = i + 1; j < argv.length; j++) scriptArgs.push(argv[j]!);
      break;
    }

    const stdinText = typeof ctx.stdin === 'string' ? ctx.stdin : '';

    let code: string;
    let displayName = '<string>';
    if (inlineCode !== null) {
      code = inlineCode; displayName = '<-c>';
    } else if (readStdinFlag) {
      code = stdinText; displayName = '<stdin>';
    } else if (scriptPath !== null) {
      try {
        code = await ctx.fs.readFile(scriptPath);
      } catch (e) {
        return { stdout: '', stderr: "python3: can't open file '" + scriptPath + "': " + (e instanceof Error ? e.message : String(e)) + '\n', exitCode: 2 };
      }
      displayName = scriptPath;
    } else if (stdinText.trim().length > 0) {
      // Piped SQL/code: treat stdin as script (like /bin/python3 does).
      code = stdinText; displayName = '<stdin>';
    } else {
      return {
        stdout: '',
        stderr: 'python3: no script provided. Use -c CODE, SCRIPT, or pipe code via stdin.\n' +
                'For interactive REPL, run /bin/python3 directly outside dsh.\n',
        exitCode: 2,
      };
    }

    try {
      const argvForPy = [displayName, ...scriptArgs];
      const virtualEnv = ctx.env.get('VIRTUAL_ENV');
      const r = call('python.exec', {
        code, argv: argvForPy, stdin: stdinText,
        scriptPath: scriptPath ?? undefined,
        // Lets the host mount the active virtualenv (see host/python-env.ts).
        cwd: ctx.cwd,
        env: virtualEnv ? { VIRTUAL_ENV: virtualEnv } : {},
      }) as { stdout: string; stderr: string; exitCode: number };
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
    } catch (e) {
      return { stdout: '', stderr: 'python3: ' + (e instanceof Error ? e.message : String(e)) + '\n', exitCode: 1 };
    }
  },
};

// Alias: `python` is the same command.
export const pythonCommand: Command = { ...python3Command, name: 'python' };
