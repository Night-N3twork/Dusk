// node:vm — minimal sandbox via eval. NOT a security boundary.
//
// runInThisContext: eval in the current realm.
// runInNewContext: copy props from sandbox onto a wrapper object, run code
//   accessing them via `with`, then copy back. This is a leaky approximation,
//   sufficient for template engines and config evaluators.

export interface RunOptions {
  filename?: string;
  lineOffset?: number;
  columnOffset?: number;
  displayErrors?: boolean;
  timeout?: number;
  breakOnSigint?: boolean;
}

const evalInThisRealm = (code: string): unknown => {
  // Indirect eval to run in the global scope.
  return (0, eval)(code);
};

export class Script {
  readonly code: string;
  readonly filename: string;

  constructor(code: string, opts?: RunOptions) {
    this.code = code;
    this.filename = opts?.filename ?? '<vm>';
  }

  runInThisContext(_opts?: RunOptions): unknown {
    return evalInThisRealm(this.code);
  }

  runInContext(context: object, opts?: RunOptions): unknown {
    return runInContext(this.code, context, opts);
  }

  runInNewContext(sandbox?: object, opts?: RunOptions): unknown {
    return runInNewContext(this.code, sandbox, opts);
  }

  createCachedData(): Uint8Array { return new Uint8Array(0); }
  cachedDataRejected = false;
}

const CONTEXT_MARK = Symbol.for('node-vm.context');

export const createContext = (sandbox?: object, _opts?: unknown): object => {
  const obj = sandbox ?? {};
  (obj as Record<symbol, unknown>)[CONTEXT_MARK] = true;
  return obj;
};

export const isContext = (v: unknown): boolean => {
  return v !== null && typeof v === 'object' && (v as Record<symbol, unknown>)[CONTEXT_MARK] === true;
};

export const runInThisContext = (code: string, _opts?: RunOptions): unknown => {
  return evalInThisRealm(code);
};

const runWithSandbox = (code: string, sandbox: Record<string, unknown>): unknown => {
  // Build `with(__sandbox__) { ... }` wrapper. Strict mode disallows `with`,
  // so we run as a Function body in non-strict mode.
  const fn = new Function('__sandbox__', `with(__sandbox__) { return (${code}); }`);
  return fn(sandbox);
};

export const runInNewContext = (code: string, sandbox?: object, opts?: RunOptions): unknown => {
  const s = (sandbox as Record<string, unknown>) ?? {};
  return runWithSandbox(code, s);
};

export const runInContext = (code: string, context: object, opts?: RunOptions): unknown => {
  return runInNewContext(code, context, opts);
};

export const compileFunction = (
  code: string,
  params: string[] = [],
  _opts?: { filename?: string; parsingContext?: object; contextExtensions?: object[] },
): Function => {
  return new Function(...params, code);
};

export const measureMemory = async (_opts?: unknown): Promise<{ total: { jsMemoryEstimate: number; jsMemoryRange: [number, number] } }> => ({
  total: { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] },
});

export class Module {
  source: string;
  identifier: string;
  status: 'unlinked' | 'linking' | 'linked' | 'evaluating' | 'evaluated' | 'errored' = 'unlinked';
  context: object | undefined;
  constructor(opts: { source: string; identifier?: string; context?: object }) {
    this.source = opts.source;
    this.identifier = opts.identifier ?? '<module>';
    this.context = opts.context;
  }
  async link(_linker: Function): Promise<void> { this.status = 'linked'; }
  async evaluate(_opts?: RunOptions): Promise<void> { this.status = 'evaluated'; }
}

export const constants = Object.freeze({
  USE_MAIN_CONTEXT_DEFAULT_LOADER: 0,
  DONT_CONTEXTIFY: 0,
});

export const nodeVm = {
  Script,
  Module,
  createContext,
  isContext,
  runInThisContext,
  runInContext,
  runInNewContext,
  compileFunction,
  measureMemory,
  constants,
};
