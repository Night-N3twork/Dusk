import type { BackgroundJobRequest, JobControl } from '../../vendor/just-bash/interpreter/types';
import type { ExecResult } from '../../vendor/just-bash/types';

type Ipc = { send: (m: unknown) => { value?: unknown; error?: string } };

interface ChildStream {
  on(event: 'data' | 'end', cb: (data?: Uint8Array) => void): void;
}

interface Child {
  pid: number;
  stdin: { write(data: Uint8Array): boolean; end(): void };
  stdout: ChildStream;
  stderr: ChildStream;
  on(event: 'exit', cb: (code: number) => void): unknown;
}

type Spawn = (command: string, args: string[], options: Record<string, unknown>) => Child;

export interface JobIo {
  stdout(data: Uint8Array | string): void;
  stderr(data: Uint8Array | string): void;
  readInput(): Uint8Array | null;
}

type JobState = 'Running' | 'Stopped' | 'Done';

const SIGNALS: Record<string, number> = {
  HUP: 1, INT: 2, QUIT: 3, KILL: 9, USR1: 10, USR2: 12, PIPE: 13, ALRM: 14, TERM: 15, CONT: 18, STOP: 19, TSTP: 20,
};

const defer = globalThis.setTimeout.bind(globalThis);

const loadSpawn = (): Spawn | undefined => {
  try {
    const load = (globalThis as { require?: (id: string) => unknown }).require;
    const childProcess = load?.('child_process') as { spawn?: Spawn } | undefined;
    return childProcess?.spawn;
  } catch {
    return undefined;
  }
};

const ipc = (): Ipc | undefined => (globalThis as { ipc?: Ipc }).ipc;

const signalProcess = (pid: number, signal: string): boolean => {
  const reply = ipc()?.send({ f: 'process.kill', pid, signal });
  return reply !== undefined && !reply.error;
};

const signalNumber = (name: string): number | undefined => {
  if (/^\d+$/.test(name)) return Number(name);
  return SIGNALS[name.toUpperCase().replace(/^SIG/, '')];
};

const signalName = (signo: number): string => {
  for (const [name, value] of Object.entries(SIGNALS)) if (value === signo) return `SIG${name}`;
  return `SIG${signo}`;
};

interface Job {
  id: number;
  pid: number;
  command: string;
  state: JobState;
  exitCode: number;
  signal?: number;
  child: Child;
  done: Promise<void>;
  held: Array<{ fd: 1 | 2; data: Uint8Array }>;
  stopped?: () => void;
}

export class PauseGate {
  private paused = false;
  private waiters: Array<() => void> = [];

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  readonly wait = (): Promise<void> | void => {
    if (!this.paused) return undefined;
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  };
}

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string, exitCode = 1): ExecResult => ({ stdout: '', stderr, exitCode });

export class JobManager implements JobControl {
  private readonly table = new Map<number, Job>();
  private order: number[] = [];
  private readonly spawn = loadSpawn();
  private foregroundJob: Job | undefined;

  constructor(private readonly io: JobIo, private readonly interactive: boolean) { }

  background(request: BackgroundJobRequest): number {
    if (!this.spawn) throw new Error('background jobs need child_process support');
    const child = this.spawn('/bin/dsh', ['-c', request.source], { cwd: request.cwd, env: request.env });
    ipc()?.send({ f: 'process.setpgid', pid: child.pid, pgid: child.pid });
    let finish!: () => void;
    const job: Job = {
      id: this.nextId(),
      pid: child.pid,
      command: request.source.trim(),
      state: 'Running',
      exitCode: 0,
      child,
      done: new Promise<void>((resolve) => { finish = resolve; }),
      held: [],
    };
    const forward = (fd: 1 | 2) => (data?: Uint8Array): void => {
      if (!data || data.length === 0) return;
      if (job.state === 'Stopped') job.held.push({ fd, data });
      else if (fd === 1) this.io.stdout(data);
      else this.io.stderr(data);
    };
    child.stdout.on('data', forward(1));
    child.stderr.on('data', forward(2));
    child.on('exit', (code) => {
      job.exitCode = code;
      if (code > 128) job.signal = code - 128;
      job.state = 'Done';
      this.flush(job);
      finish();
    });
    this.table.set(job.id, job);
    this.touch(job);
    if (this.interactive) this.io.stderr(`[${job.id}] ${job.pid}\n`);
    return job.pid;
  }

  async wait(args: string[]): Promise<number> {
    if (args.length === 0) {
      for (const job of [...this.table.values()]) {
        if (job.state === 'Running') await job.done;
        if (job.state === 'Done') this.forget(job);
      }
      return 0;
    }
    let status = 0;
    for (const spec of args) {
      const job = this.find(spec);
      if (!job) {
        this.io.stderr(`wait: ${spec}: no such job\n`);
        status = 127;
        continue;
      }
      if (job.state !== 'Done') await job.done;
      status = job.exitCode;
      this.forget(job);
    }
    return status;
  }

  builtin(name: string, args: string[]): Promise<ExecResult> | undefined {
    switch (name) {
      case 'jobs': return Promise.resolve(this.jobsCommand(args));
      case 'fg': return this.fgCommand(args);
      case 'bg': return Promise.resolve(this.bgCommand(args));
      case 'kill': return Promise.resolve(this.killCommand(args));
      case 'disown': return Promise.resolve(this.disownCommand(args));
      default: return undefined;
    }
  }

  forwardSignal(signal: 'SIGINT' | 'SIGTSTP' | 'SIGQUIT'): boolean {
    const job = this.foregroundJob;
    if (!job) return false;
    if (signal === 'SIGTSTP') this.stop(job);
    else signalProcess(job.pid, signal);
    return true;
  }

  notifications(): string {
    let out = '';
    for (const job of [...this.table.values()]) {
      if (job.state !== 'Done') continue;
      out += this.describe(job) + '\n';
      this.forget(job);
    }
    return out;
  }

  hasJobs(): boolean {
    return this.table.size > 0;
  }

  private nextId(): number {
    let id = 1;
    for (const existing of this.table.keys()) id = Math.max(id, existing + 1);
    return id;
  }

  private touch(job: Job): void {
    this.order = this.order.filter((id) => id !== job.id);
    this.order.push(job.id);
  }

  private forget(job: Job): void {
    this.table.delete(job.id);
    this.order = this.order.filter((id) => id !== job.id);
  }

  private flush(job: Job): void {
    const held = job.held;
    job.held = [];
    for (const { fd, data } of held) {
      if (fd === 1) this.io.stdout(data);
      else this.io.stderr(data);
    }
  }

  private stop(job: Job): void {
    if (job.state !== 'Running') return;
    signalProcess(job.pid, 'SIGTSTP');
    job.state = 'Stopped';
    this.touch(job);
    this.io.stderr(`\n${this.describe(job)}\n`);
    job.stopped?.();
  }

  private resume(job: Job): void {
    if (job.state !== 'Stopped') return;
    job.state = 'Running';
    signalProcess(job.pid, 'SIGCONT');
    this.flush(job);
  }

  private marker(job: Job): string {
    const last = this.order[this.order.length - 1];
    const previous = this.order[this.order.length - 2];
    return job.id === last ? '+' : job.id === previous ? '-' : ' ';
  }

  private describe(job: Job, withPid = false): string {
    let status: string;
    if (job.state !== 'Done') status = job.state;
    else if (job.signal === SIGNALS['INT']) status = 'Interrupt';
    else if (job.signal === SIGNALS['KILL']) status = 'Killed';
    else if (job.signal === SIGNALS['TERM']) status = 'Terminated';
    else if (job.signal !== undefined) status = signalName(job.signal).slice(3);
    else status = job.exitCode === 0 ? 'Done' : `Exit ${job.exitCode}`;
    const pid = withPid ? `${job.pid} ` : '';
    const suffix = job.state === 'Running' ? ' &' : '';
    return `[${job.id}]${this.marker(job)}  ${pid}${status.padEnd(24)}${job.command}${suffix}`;
  }

  private find(spec: string | undefined): Job | undefined {
    if (spec === undefined || spec === '%' || spec === '%%' || spec === '%+') {
      const id = this.order[this.order.length - 1];
      return id === undefined ? undefined : this.table.get(id);
    }
    if (spec === '%-') {
      const id = this.order[this.order.length - 2];
      return id === undefined ? undefined : this.table.get(id);
    }
    if (/^%\d+$/.test(spec)) return this.table.get(Number(spec.slice(1)));
    if (/^\d+$/.test(spec)) {
      const pid = Number(spec);
      for (const job of this.table.values()) if (job.pid === pid) return job;
      return undefined;
    }
    if (spec.startsWith('%?')) {
      const needle = spec.slice(2);
      for (const job of this.table.values()) if (job.command.includes(needle)) return job;
      return undefined;
    }
    if (spec.startsWith('%')) {
      const prefix = spec.slice(1);
      for (const job of this.table.values()) if (job.command.startsWith(prefix)) return job;
    }
    return undefined;
  }

  private jobsCommand(args: string[]): ExecResult {
    const withPid = args.includes('-l');
    const pidsOnly = args.includes('-p');
    const runningOnly = args.includes('-r');
    const stoppedOnly = args.includes('-s');
    const specs = args.filter((arg) => !arg.startsWith('-'));
    const selected = specs.length > 0
      ? specs.map((spec) => this.find(spec)).filter((job): job is Job => job !== undefined)
      : [...this.table.values()].sort((a, b) => a.id - b.id);
    let out = '';
    for (const job of selected) {
      if (runningOnly && job.state !== 'Running') continue;
      if (stoppedOnly && job.state !== 'Stopped') continue;
      out += pidsOnly ? `${job.pid}\n` : `${this.describe(job, withPid)}\n`;
      if (job.state === 'Done') this.forget(job);
    }
    return ok(out);
  }

  private async fgCommand(args: string[]): Promise<ExecResult> {
    const spec = args[0];
    const job = this.find(spec);
    if (!job) return fail(`fg: ${spec ?? 'current'}: no such job\n`);
    this.io.stdout(`${job.command}\n`);
    this.touch(job);
    this.resume(job);
    this.foregroundJob = job;
    let attached = true;
    const pump = (): void => {
      if (!attached) return;
      const input = this.io.readInput();
      if (input === null) {
        job.child.stdin.end();
        return;
      }
      if (input.length > 0) job.child.stdin.write(input);
      defer(pump, input.length > 0 ? 0 : 20);
    };
    pump();
    try {
      const stopped = new Promise<'stopped'>((resolve) => { job.stopped = () => resolve('stopped'); });
      const outcome = await Promise.race([job.done.then(() => 'done' as const), stopped]);
      if (outcome === 'stopped') return { stdout: '', stderr: '', exitCode: 128 + SIGNALS['TSTP']! };
      this.forget(job);
      return { stdout: '', stderr: '', exitCode: job.exitCode };
    } finally {
      attached = false;
      delete job.stopped;
      this.foregroundJob = undefined;
    }
  }

  private bgCommand(args: string[]): ExecResult {
    const specs = args.length > 0 ? args : [undefined];
    let out = '';
    for (const spec of specs) {
      const job = this.find(spec);
      if (!job) return fail(`bg: ${spec ?? 'current'}: no such job\n`);
      if (job.state === 'Running') return fail(`bg: job ${job.id} already in background\n`);
      this.touch(job);
      this.resume(job);
      out += `[${job.id}]${this.marker(job)} ${job.command} &\n`;
    }
    return ok(out);
  }

  private disownCommand(args: string[]): ExecResult {
    const targets = args.includes('-a') ? [...this.table.values()] : [this.find(args[0])];
    for (const job of targets) {
      if (!job) return fail(`disown: ${args[0] ?? 'current'}: no such job\n`);
      this.forget(job);
    }
    return ok();
  }

  private killCommand(args: string[]): ExecResult {
    let signo = SIGNALS['TERM']!;
    const targets: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '-l' || arg === '-L') {
        const names = Object.entries(SIGNALS).sort((a, b) => a[1] - b[1]).map(([name, value]) => `${value}) SIG${name}`);
        return ok(names.join('\n') + '\n');
      }
      if (targets.length === 0 && (arg === '-s' || arg === '-n')) {
        const value = signalNumber(args[++i] ?? '');
        if (value === undefined) return fail(`kill: ${args[i] ?? ''}: invalid signal specification\n`);
        signo = value;
      } else if (arg === '--') {
        targets.push(...args.slice(i + 1));
        break;
      } else if (targets.length === 0 && /^-\w+$/.test(arg)) {
        const value = signalNumber(arg.slice(1));
        if (value === undefined) return fail(`kill: ${arg.slice(1)}: invalid signal specification\n`);
        signo = value;
      } else {
        targets.push(arg);
      }
    }
    if (targets.length === 0) return fail('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n', 2);
    let stderr = '';
    for (const target of targets) {
      const job = target.startsWith('%')
        ? this.find(target)
        : [...this.table.values()].find((candidate) => String(candidate.pid) === target);
      if (!job && target.startsWith('%')) {
        stderr += `kill: ${target}: no such job\n`;
        continue;
      }
      if (job) {
        if (signo === SIGNALS['STOP'] || signo === SIGNALS['TSTP']) this.stop(job);
        else if (signo === SIGNALS['CONT']) this.resume(job);
        else signalProcess(job.pid, signalName(signo));
        continue;
      }
      if (!/^-?\d+$/.test(target)) {
        stderr += `kill: ${target}: arguments must be process or job IDs\n`;
        continue;
      }
      if (!signalProcess(Number(target), signalName(signo))) stderr += `kill: (${target}) - No such process\n`;
    }
    return stderr ? fail(stderr) : ok();
  }
}
