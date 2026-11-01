import type { Completer } from './line-editor';

export interface CompletionSource {
  cwd(): string;
  env(): Record<string, string>;
  commands(): string[];
  readdir(path: string): string[];
  isDirectory(path: string): boolean;
}

const BUILTINS = [
  'alias', 'bg', 'break', 'builtin', 'cd', 'command', 'continue', 'declare', 'dirs', 'disown', 'echo', 'eval', 'exec',
  'exit', 'export', 'false', 'fg', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local', 'popd',
  'printf', 'pushd', 'pwd', 'read', 'readonly', 'return', 'set', 'shift', 'shopt', 'source', 'test', 'trap', 'true',
  'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait',
];

const KEYWORDS = ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select', 'time'];

const SEPARATORS = new Set([' ', '\t', '|', ';', '&', '<', '>', '(', ')', '=', '`']);

const escapeWord = (text: string): string => text.replace(/([ \t'"\\$`!&;|()<>*?[\]{}#])/g, '\\$1');

const unescapeWord = (text: string): string => text.replace(/\\(.)/g, '$1').replace(/^['"]|['"]$/g, '');

const joinPath = (dir: string, name: string): string => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);

const wordStart = (line: string, cursor: number): number => {
  let start = cursor;
  while (start > 0) {
    const char = line[start - 1]!;
    if (SEPARATORS.has(char) && line[start - 2] !== '\\') break;
    start--;
  }
  return start;
};

const inCommandPosition = (before: string): boolean => {
  const trimmed = before.trimEnd();
  if (trimmed === '') return true;
  if (/(\|\||&&|[|;&(`]|\$\()$/.test(trimmed)) return true;
  return /(^|[\s;|&(])(sudo|time|nohup|exec|command|then|do|else|xargs)$/.test(trimmed);
};

export const createCompleter = (source: CompletionSource): Completer => (line, cursor) => {
  const start = wordStart(line, cursor);
  const raw = line.slice(start, cursor);

  if (raw.startsWith('$')) {
    const braced = raw.startsWith('${');
    const prefix = raw.slice(braced ? 2 : 1);
    const names = Object.keys(source.env()).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.startsWith(prefix)).sort();
    return { start, candidates: names.map((name) => (braced ? `\${${name}}` : `$${name}`)) };
  }

  const word = unescapeWord(raw);
  if (inCommandPosition(line.slice(0, start)) && !word.includes('/')) {
    const names = new Set<string>();
    for (const name of [...BUILTINS, ...KEYWORDS, ...source.commands()]) if (name.startsWith(word)) names.add(name);
    for (const dir of (source.env()['PATH'] ?? '/bin').split(':')) {
      if (!dir) continue;
      let entries: string[] = [];
      try { entries = source.readdir(dir); } catch { }
      for (const name of entries) if (name.startsWith(word)) names.add(name);
    }
    return { start, candidates: [...names].sort().map(escapeWord) };
  }

  const home = source.env()['HOME'] ?? '/';
  const expanded = word === '~' ? home + '/' : word.startsWith('~/') ? home + word.slice(1) : word;
  const slash = expanded.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : expanded.slice(0, slash + 1);
  const base = slash === -1 ? expanded : expanded.slice(slash + 1);
  const dirPath = dirPart === '' ? source.cwd() : dirPart.startsWith('/') ? dirPart : joinPath(source.cwd(), dirPart);
  let entries: string[];
  try {
    entries = source.readdir(dirPath);
  } catch {
    return { start, candidates: [] };
  }
  const shownDir = word === '~' ? '~/' : word.startsWith('~/') ? '~/' + dirPart.slice(home.length + 1) : dirPart;
  const candidates = entries
    .filter((name) => name.startsWith(base) && (base.startsWith('.') || !name.startsWith('.')))
    .sort()
    .map((name) => {
      let directory = false;
      try { directory = source.isDirectory(joinPath(dirPath, name)); } catch { }
      return escapeWord(shownDir + name) + (directory ? '/' : '');
    });
  return { start, candidates };
};
