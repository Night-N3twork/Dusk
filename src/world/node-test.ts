import { nodeAssert } from './node-assert';

type TestFn = (t: TestContext, done?: (error?: unknown) => void) => unknown;
type HookFn = (t?: TestContext) => unknown;

interface TestOptions {
  skip?: boolean | string;
  todo?: boolean | string;
  only?: boolean;
  timeout?: number;
  concurrency?: number | boolean;
}

interface Node {
  name: string;
  fn: TestFn | undefined;
  options: TestOptions;
  suite: boolean;
  children: Node[];
  before: HookFn[];
  after: HookFn[];
  beforeEach: HookFn[];
  afterEach: HookFn[];
  parent: Node | undefined;
}

interface Totals { tests: number; suites: number; pass: number; fail: number; skipped: number; todo: number; cancelled: number }

const write = (text: string): void => {
  const proc = (globalThis as Record<string, unknown>)['process'] as { stdout?: { write(s: string): unknown } } | undefined;
  if (proc?.stdout) proc.stdout.write(text);
  else console.log(text.replace(/\n$/, ''));
};

const makeNode = (name: string, fn: TestFn | undefined, options: TestOptions, suite: boolean, parent: Node | undefined): Node => ({
  name, fn, options, suite, children: [], before: [], after: [], beforeEach: [], afterEach: [], parent,
});

const root = makeNode('<root>', undefined, {}, true, undefined);
let current: Node = root;
let scheduled = false;
let running = false;
let onlyMode = false;
const totals: Totals = { tests: 0, suites: 0, pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0 };
const started = Date.now();

const lifecycle = (): { retain(): () => void } | undefined =>
  ((globalThis as Record<string, unknown>)['__process'] as { __duskLifecycle?: { retain(): () => void } } | undefined)?.__duskLifecycle;

const parseArgs = (args: unknown[]): { name: string; options: TestOptions; fn: TestFn | undefined } => {
  let name = '<anonymous>';
  let options: TestOptions = {};
  let fn: TestFn | undefined;
  for (const arg of args) {
    if (typeof arg === 'string') name = arg;
    else if (typeof arg === 'function') { fn = arg as TestFn; if (name === '<anonymous>' && arg.name) name = arg.name; }
    else if (arg && typeof arg === 'object') options = arg as TestOptions;
  }
  return { name, options, fn };
};

const indent = (depth: number): string => '    '.repeat(depth);

const yamlBlock = (depth: number, error: unknown, duration: number): string => {
  const pad = indent(depth) + '  ';
  let out = `${pad}---\n${pad}duration_ms: ${duration.toFixed(3)}\n`;
  if (error !== undefined) {
    const err = error as { message?: string; code?: string; stack?: string; name?: string };
    out += `${pad}failureType: 'testCodeFailure'\n`;
    out += `${pad}error: ${JSON.stringify(err?.message ?? String(error))}\n`;
    if (err?.code) out += `${pad}code: '${err.code}'\n`;
    if (err?.stack) out += `${pad}stack: |-\n${err.stack.split('\n').map((line) => `${pad}  ${line}`).join('\n')}\n`;
  }
  return `${out}${pad}...\n`;
};

const withTimeout = async (promise: Promise<unknown>, timeout: number | undefined): Promise<void> => {
  if (timeout === undefined || !Number.isFinite(timeout) || timeout <= 0) { await promise; return; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`test timed out after ${timeout}ms`);
          (error as Error & { code?: string }).code = 'ERR_TEST_FAILURE';
          reject(error);
        }, timeout);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const hooksFor = (node: Node, kind: 'beforeEach' | 'afterEach'): HookFn[] => {
  const chain: Node[] = [];
  for (let n: Node | undefined = node.parent; n; n = n.parent) chain.unshift(n);
  const hooks = chain.flatMap((n) => n[kind]);
  return kind === 'afterEach' ? hooks.reverse() : hooks;
};

const hasOnly = (node: Node): boolean => node.options.only === true || node.children.some(hasOnly);

class TestContext {
  readonly name: string;
  readonly signal: AbortSignal;
  readonly assert = nodeAssert;
  readonly mock: MockTracker;
  private readonly diagnostics: string[] = [];
  private skipReason: string | undefined;
  private todoReason: string | undefined;
  readonly node: Node;

  constructor(node: Node, signal: AbortSignal) {
    this.node = node;
    this.name = node.name;
    this.signal = signal;
    this.mock = new MockTracker();
  }

  get fullName(): string {
    const names: string[] = [];
    for (let n: Node | undefined = this.node; n && n !== root; n = n.parent) names.unshift(n.name);
    return names.join(' > ');
  }

  diagnostic(message: string): void { this.diagnostics.push(message); }
  skip(message?: string): void { this.skipReason = message ?? ''; }
  todo(message?: string): void { this.todoReason = message ?? ''; }
  plan(_count: number): void { }
  runOnly(_enabled: boolean): void { }
  before(fn: HookFn): void { this.node.before.push(fn); }
  after(fn: HookFn): void { this.node.after.push(fn); }
  beforeEach(fn: HookFn): void { this.node.beforeEach.push(fn); }
  afterEach(fn: HookFn): void { this.node.afterEach.push(fn); }

  test(...args: unknown[]): Promise<void> {
    const { name, options, fn } = parseArgs(args);
    const child = makeNode(name, fn, options, false, this.node);
    this.node.children.push(child);
    return Promise.resolve();
  }

  _state(): { diagnostics: string[]; skip: string | undefined; todo: string | undefined } {
    return { diagnostics: this.diagnostics, skip: this.skipReason, todo: this.todoReason };
  }
}

const runNode = async (node: Node, depth: number, index: number): Promise<boolean> => {
  const label = `${index} - ${node.name}`;
  const skipOption = node.options.skip;
  const todoOption = node.options.todo;
  const filteredOut = onlyMode && !hasOnly(node) && !(node.parent && node.parent.options.only);
  if (skipOption || filteredOut) {
    totals.skipped++;
    if (!node.suite) totals.tests++;
    write(`${indent(depth)}ok ${label} # SKIP${typeof skipOption === 'string' ? ` ${skipOption}` : ''}\n`);
    return true;
  }
  if (!node.fn && !node.suite) {
    totals.todo++;
    totals.tests++;
    write(`${indent(depth)}ok ${label} # TODO\n`);
    return true;
  }
  const controller = new AbortController();
  const context = new TestContext(node, controller.signal);
  const start = Date.now();
  let error: unknown;
  try {
    if (node.suite) {
      if (node.fn) {
        const previous = current;
        current = node;
        try { await node.fn(context); } finally { current = previous; }
      }
    } else {
      for (const hook of hooksFor(node, 'beforeEach')) await hook(context);
      const fn = node.fn!;
      const result = fn.length >= 2
        ? new Promise<void>((resolve, reject) => {
          const maybe = fn(context, (e?: unknown) => (e ? reject(e) : resolve()));
          if (maybe && typeof (maybe as Promise<unknown>).then === 'function') reject(new Error('passed a callback but also returned a Promise'));
        })
        : Promise.resolve(fn(context));
      await withTimeout(result, node.options.timeout);
      for (const hook of hooksFor(node, 'afterEach')) await hook(context);
    }
    if (node.children.length > 0) {
      for (const hook of node.before) await hook(context);
      write(`${indent(depth + 1)}# Subtest: ${node.name}\n`);
      let childIndex = 0;
      let allPassed = true;
      for (const child of node.children) {
        if (!(await runNode(child, depth + 1, ++childIndex))) allPassed = false;
      }
      write(`${indent(depth + 1)}1..${node.children.length}\n`);
      for (const hook of node.after) await hook(context);
      if (!allPassed && error === undefined) {
        error = new Error('subtests failed');
        (error as Error & { code?: string }).code = 'ERR_TEST_FAILURE';
      }
    }
  } catch (e) {
    error = e;
  } finally {
    controller.abort();
    context.mock.restoreAll();
  }
  const state = context._state();
  const duration = Date.now() - start;
  if (node.suite) totals.suites++;
  else totals.tests++;
  for (const line of state.diagnostics) write(`${indent(depth)}# ${line}\n`);
  if (state.skip !== undefined) {
    totals.skipped++;
    write(`${indent(depth)}ok ${label} # SKIP${state.skip ? ` ${state.skip}` : ''}\n`);
    return true;
  }
  if (todoOption || state.todo !== undefined) {
    totals.todo++;
    write(`${indent(depth)}${error === undefined ? 'ok' : 'not ok'} ${label} # TODO\n${yamlBlock(depth, error, duration)}`);
    return true;
  }
  if (error === undefined) {
    if (!node.suite) totals.pass++;
    write(`${indent(depth)}ok ${label}\n${yamlBlock(depth, undefined, duration)}`);
    return true;
  }
  if (!node.suite) totals.fail++;
  write(`${indent(depth)}not ok ${label}\n${yamlBlock(depth, error, duration)}`);
  return false;
};

const runAll = async (): Promise<void> => {
  const release = lifecycle()?.retain();
  running = true;
  try {
    await Promise.resolve();
    onlyMode = hasOnly(root);
    write('TAP version 13\n');
    const context = new TestContext(root, new AbortController().signal);
    for (const hook of root.before) await hook(context);
    let index = 0;
    while (index < root.children.length) {
      const node = root.children[index]!;
      index++;
      await runNode(node, 0, index);
    }
    for (const hook of root.after) await hook(context);
    write(`1..${root.children.length}\n`);
    write(`# tests ${totals.tests}\n# suites ${totals.suites}\n# pass ${totals.pass}\n# fail ${totals.fail}\n# cancelled ${totals.cancelled}\n# skipped ${totals.skipped}\n# todo ${totals.todo}\n# duration_ms ${(Date.now() - started).toFixed(3)}\n`);
    const proc = (globalThis as Record<string, unknown>)['process'] as { exitCode?: number } | undefined;
    if (totals.fail > 0 && proc) proc.exitCode = 1;
  } finally {
    running = false;
    release?.();
  }
};

const schedule = (): void => {
  if (scheduled) return;
  scheduled = true;
  void Promise.resolve().then(runAll);
};

const register = (suite: boolean, args: unknown[], extra: TestOptions = {}): Promise<void> => {
  const { name, options, fn } = parseArgs(args);
  const parent = current;
  const node = makeNode(name, fn, { ...options, ...extra }, suite, parent);
  parent.children.push(node);
  if (parent === root) schedule();
  return Promise.resolve();
};

type Registrar = ((...args: unknown[]) => Promise<void>) & {
  skip: (...args: unknown[]) => Promise<void>;
  todo: (...args: unknown[]) => Promise<void>;
  only: (...args: unknown[]) => Promise<void>;
};

const registrar = (suite: boolean): Registrar => Object.assign(
  (...args: unknown[]) => register(suite, args),
  {
    skip: (...args: unknown[]) => register(suite, args, { skip: true }),
    todo: (...args: unknown[]) => register(suite, args, { todo: true }),
    only: (...args: unknown[]) => register(suite, args, { only: true }),
  },
);

export const test = registrar(false);
export const it = test;
export const describe = registrar(true);
export const suite = describe;

export const before = (fn: HookFn): void => { current.before.push(fn); };
export const after = (fn: HookFn): void => { current.after.push(fn); };
export const beforeEach = (fn: HookFn): void => { current.beforeEach.push(fn); };
export const afterEach = (fn: HookFn): void => { current.afterEach.push(fn); };

interface MockCall { arguments: unknown[]; result?: unknown; error?: unknown; this: unknown; target?: unknown; stack: Error }

interface MockControl {
  calls: MockCall[];
  callCount(): number;
  mockImplementation(fn: (...args: unknown[]) => unknown): void;
  mockImplementationOnce(fn: (...args: unknown[]) => unknown, onCall?: number): void;
  resetCalls(): void;
  restore(): void;
}

class MockTracker {
  private restorers: Array<() => void> = [];

  fn<T extends (...args: unknown[]) => unknown>(original?: T, implementation?: T, options: { times?: number } = {}): T & { mock: MockControl } {
    let impl: ((...args: unknown[]) => unknown) | undefined = implementation ?? original;
    const once = new Map<number, (...args: unknown[]) => unknown>();
    const calls: MockCall[] = [];
    let remaining = options.times ?? Infinity;
    const mocked = function (this: unknown, ...args: unknown[]): unknown {
      const index = calls.length;
      const call: MockCall = { arguments: args, this: this, stack: new Error() };
      calls.push(call);
      const active = once.get(index) ?? (remaining-- > 0 ? impl : original);
      once.delete(index);
      try {
        const result = active ? (new.target ? Reflect.construct(active as (...a: unknown[]) => unknown, args) : active.apply(this, args)) : undefined;
        call.result = result;
        return result;
      } catch (error) {
        call.error = error;
        throw error;
      }
    } as unknown as T & { mock: MockControl };
    const control: MockControl = {
      calls,
      callCount: () => calls.length,
      mockImplementation: (fn) => { impl = fn; },
      mockImplementationOnce: (fn, onCall) => { once.set(onCall ?? calls.length, fn); },
      resetCalls: () => { calls.length = 0; },
      restore: () => { impl = original; },
    };
    Object.defineProperty(mocked, 'mock', { value: control, enumerable: false });
    return mocked;
  }

  method<T extends object>(object: T, methodName: keyof T, implementation?: (...args: unknown[]) => unknown, options: { getter?: boolean; setter?: boolean } = {}): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(object, methodName) ?? { value: object[methodName], writable: true, configurable: true, enumerable: false };
    const kind = options.getter ? 'get' : options.setter ? 'set' : 'value';
    const original = descriptor[kind] as ((...args: unknown[]) => unknown) | undefined;
    const mocked = this.fn(original, implementation ?? original);
    Object.defineProperty(object, methodName, { ...descriptor, [kind]: mocked });
    const restore = (): void => { Object.defineProperty(object, methodName, descriptor); };
    (mocked.mock as MockControl).restore = restore;
    this.restorers.push(restore);
    return mocked;
  }

  getter<T extends object>(object: T, name: keyof T, implementation?: (...args: unknown[]) => unknown): unknown {
    return this.method(object, name, implementation, { getter: true });
  }

  setter<T extends object>(object: T, name: keyof T, implementation?: (...args: unknown[]) => unknown): unknown {
    return this.method(object, name, implementation, { setter: true });
  }

  reset(): void { this.restoreAll(); }

  restoreAll(): void {
    for (const restore of this.restorers.splice(0).reverse()) restore();
  }
}

export const mock = new MockTracker();

export const run = (): never => {
  const error = new Error('node:test run() is not supported in Dusk; execute test files directly with node');
  (error as Error & { code?: string }).code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
  throw error;
};

export const nodeTest = Object.assign(test, {
  test,
  it,
  describe,
  suite,
  before,
  after,
  beforeEach,
  afterEach,
  mock,
  run,
  default: test,
});
