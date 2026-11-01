export interface DuskRepl {
  feed(line: string): Promise<void>;
}

export interface ReplEngine {
  run(js: string): Promise<void>;
}

// Names that must never be shadowed by a REPL binding. The generated code
// itself reads `globalThis`, so a guest `const globalThis = ...` in the same
// block would put the prefix inside its own temporal dead zone.
const RESERVED = new Set(['globalThis']);

// The binding table has to be reachable from guest code, but it must not be
// observable as a plain global property (`globalThis.__duskReplBindings`).
// A well-known symbol key satisfies both constraints.
const STORE = 'globalThis[globalThis.Symbol.for("dusk.repl.bindings")]';
const STORE_INIT = STORE + ' ??= globalThis.Object.create(null)';

const hasTopLevelSemicolon = (src: string): boolean => {
  const t = src.replace(/;\s*$/, '');
  let depth = 0;
  let inStr: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) return true;
  }
  return false;
};

const isExpression = (src: string): boolean => {
  const t = src.trim();
  if (/^\s*(const|let|var|function|class|if|for|while|switch|return|throw|try|do|import|export)\b/.test(t)) return false;
  if (/^\s*\{/.test(t)) return false;
  if (hasTopLevelSemicolon(t)) return false;
  return true;
};

const splitLeadingInit = (rhs: string): { init: string; rest: string } => {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = 0; i < rhs.length; i++) {
    const c = rhs[i]!;
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) return { init: rhs.slice(0, i), rest: rhs.slice(i + 1) };
  }
  return { init: rhs, rest: '' };
};

interface Declaration {
  kind: string;
  name: string;
  decl: string;
  rest: string;
  multi: boolean;
}

const persistDeclaration = (src: string): Declaration | null => {
  const m = /^\s*(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+?);?\s*$/.exec(src);
  if (!m) return null;
  const kind = m[1]!;
  const name = m[2]!;
  const { init, rest } = splitLeadingInit(m[3]!);
  const decl =
    kind === 'const'
      ? STORE_INIT + ';\n' +
        '(function (__duskReplInit) { globalThis.Object.defineProperty(' + STORE + ', "' + name + '", {' +
        ' get: function () { return __duskReplInit; },' +
        ' set: function () { throw new globalThis.TypeError("Assignment to constant variable."); },' +
        ' enumerable: true, configurable: false }); })((' + init + '\n));'
      : STORE_INIT + ';\n' + STORE + '.' + name + ' = (' + init + '\n);';
  const trimmedRest = rest.trim();
  return { kind, name, decl, rest: trimmedRest, multi: hasTopLevelSemicolon(trimmedRest) };
};

export const startRepl = (runner: ReplEngine, write: (text: string) => void): DuskRepl => {
  // Declared-name bookkeeping lives on the host so a redeclaration can be
  // rejected *before* the new initializer is ever emitted, matching the
  // pre-evaluation SyntaxError of a real script.
  const lexical = new Set<string>();
  const vars = new Set<string>();

  return {
    feed: async (line: string): Promise<void> => {
      const trimmed = line.trim();
      if (!trimmed) return;

      const expression = isExpression(trimmed);
      const persisted = expression ? null : persistDeclaration(trimmed);

      if (persisted !== null) {
        const { kind, name } = persisted;
        const clash =
          RESERVED.has(name) || lexical.has(name) || (kind !== 'var' && vars.has(name));
        if (clash) {
          await runner.run(
            'globalThis.console.error("SyntaxError: Identifier \'' + name +
              '\' has already been declared");',
          );
          return;
        }
      }

      const body = expression
        ? 'globalThis.__replResult = (' + trimmed.replace(/;\s*$/, '') + '\n);'
        : persisted !== null
          ? persisted.rest === ''
            ? persisted.decl + '\nglobalThis.__replResult = undefined;'
            : persisted.multi
              ? persisted.decl + '\n' + persisted.rest + '\nglobalThis.__replResult = undefined;'
              : persisted.decl + '\nglobalThis.__replResult = (' + persisted.rest + '\n);'
          : trimmed + '\nglobalThis.__replResult = undefined;';

      const code =
        'try {' +
        'with (' + STORE_INIT + ') {' +
        body +
        '}' +
        '{' +
        ' const __duskReplValue = await globalThis.Promise.resolve(globalThis.__replResult);' +
        ' globalThis.console.log(typeof __duskReplValue === "undefined" ? "undefined" : globalThis.String(__duskReplValue));' +
        '}' +
        ' } catch (e) { globalThis.console.error(globalThis.String(e)); }';

      await runner.run(code);

      if (persisted !== null) {
        if (persisted.kind === 'var') vars.add(persisted.name);
        else lexical.add(persisted.name);
      }

      void write;
    },
  };
};
