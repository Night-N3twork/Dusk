import type { Command, CommandContext, ExecResult } from '../../../vendor/just-bash/types';
import { latin1FromBytes } from '../../../vendor/just-bash/encoding';
import { latin1, stdinBytes } from './command-io';

type Ipc = { send: (m: unknown) => { value?: unknown; error?: string } };

interface Child {
  stdin: { write(data: Uint8Array): boolean; end(): void };
  stdout: { on(event: 'data', cb: (data?: Uint8Array) => void): void };
  stderr: { on(event: 'data', cb: (data?: Uint8Array) => void): void };
  exit: Promise<number>;
}

type Spawn = (command: string, args: string[], options: Record<string, unknown>) => Child;

const spawnAsync = ((): Spawn | undefined => {
  try {
    const load = (globalThis as { require?: (id: string) => unknown }).require;
    return (load?.('child_process') as { spawn?: Spawn } | undefined)?.spawn;
  } catch {
    return undefined;
  }
})();

const environment = (ctx: CommandContext): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx.exportedEnv ?? {})) env[key] = String(value);
  for (const name of ['PATH', 'HOME', 'USER', 'PWD', 'TERM']) {
    const value = ctx.env.get(name);
    if (value !== undefined && env[name] === undefined) env[name] = value;
  }
  return env;
};

const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return new Uint8Array(0);
};

const runAttached = async (binary: string, args: string[], ctx: CommandContext): Promise<ExecResult> => {
  const terminal = ctx.terminal!;
  const child = spawnAsync!(binary, args, { cwd: ctx.cwd, env: environment(ctx) });
  const encoder = new TextEncoder();
  const out = new TextDecoder();
  const err = new TextDecoder();
  child.stdout.on('data', (data) => { if (data) terminal.write(out.decode(data, { stream: true })); });
  child.stderr.on('data', (data) => { if (data) terminal.write(err.decode(data, { stream: true })); });
  let running = true;
  const pump = (async () => {
    while (running) {
      const key = await terminal.pollKey(50);
      if (!running) break;
      if (key === null) {
        child.stdin.end();
        break;
      }
      if (key !== undefined) child.stdin.write(encoder.encode(key));
    }
  })();
  const code = await child.exit;
  running = false;
  await pump;
  terminal.write(out.decode() + err.decode());
  return { stdout: '', stderr: '', exitCode: code };
};

const runBuffered = (binary: string, args: string[], ctx: CommandContext): ExecResult => {
  const ipc = (globalThis as { ipc?: Ipc }).ipc;
  if (!ipc) return { stdout: '', stderr: `${binary}: process bridge unavailable\n`, exitCode: 127 };
  const stdin = latin1FromBytes(ctx.stdin);
  const options: Record<string, unknown> = { cwd: ctx.cwd, env: environment(ctx) };
  if (stdin.length > 0) options['stdin'] = stdinBytes(ctx);
  const reply = ipc.send({ f: 'process.spawnSync', command: binary, args, options });
  if (reply.error) return { stdout: '', stderr: `${binary}: ${reply.error}\n`, exitCode: 127 };
  const value = reply.value as { stdout?: unknown; stderr?: unknown; status?: number } | undefined;
  return {
    stdout: latin1(toBytes(value?.stdout)),
    stderr: new TextDecoder().decode(toBytes(value?.stderr)),
    exitCode: value?.status ?? 0,
    stdoutKind: 'bytes',
  };
};

export const externalCommand = (name: string, binary = `/bin/${name}`): Command => ({
  name,
  trusted: true,
  async execute(args, ctx) {
    if (ctx.terminal && spawnAsync) return runAttached(binary, args, ctx);
    return runBuffered(binary, args, ctx);
  },
});
