export interface Completion {
  start: number;
  candidates: string[];
}

export interface LineEditorIo {
  write(text: string): void;
  columns(): number;
}

export type Completer = (line: string, cursor: number) => Completion;

export class History {
  private entries: string[] = [];

  constructor(
    private readonly storage?: { load(): string | undefined; save(text: string): void },
    private readonly limit = 1000,
  ) {
    const saved = storage?.load();
    if (saved) this.entries = saved.split('\n').filter((line) => line.length > 0).slice(-limit);
  }

  get size(): number {
    return this.entries.length;
  }

  at(index: number): string | undefined {
    return this.entries[index];
  }

  list(): readonly string[] {
    return this.entries;
  }

  add(line: string): void {
    if (!line.trim() || line.startsWith(' ')) return;
    if (this.entries[this.entries.length - 1] === line) return;
    this.entries.push(line);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.persist();
  }

  clear(): void {
    this.entries = [];
    this.persist();
  }

  private persist(): void {
    try {
      this.storage?.save(this.entries.length > 0 ? this.entries.join('\n') + '\n' : '');
    } catch { }
  }
}

const commonPrefix = (values: readonly string[]): string => {
  if (values.length === 0) return '';
  let prefix = values[0]!;
  for (const value of values) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
};

const columnize = (items: readonly string[], width: number): string => {
  const longest = Math.max(...items.map((item) => item.length)) + 2;
  const perRow = Math.max(1, Math.floor(width / longest));
  const rows = Math.ceil(items.length / perRow);
  let out = '';
  for (let row = 0; row < rows; row++) {
    let line = '';
    for (let col = 0; col < perRow; col++) {
      const item = items[col * rows + row];
      if (item !== undefined) line += item.padEnd(longest);
    }
    out += line.trimEnd() + '\r\n';
  }
  return out;
};

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[A-Za-z0-9_]/.test(char);

export class KeyReader {
  private pending = '';

  constructor(private readonly read: (timeoutMs?: number) => Promise<string | null | undefined>) { }

  async next(groupPrintable = false, timeoutMs?: number): Promise<string | null | undefined> {
    while (this.pending.length === 0) {
      const chunk = await this.read(timeoutMs);
      if (chunk === null) return null;
      if (chunk === undefined) {
        if (timeoutMs !== undefined) return undefined;
        continue;
      }
      this.pending += chunk;
    }
    const first = this.pending[0]!;
    if (first !== '\x1b') {
      let end = first.codePointAt(0)! > 0xffff ? 2 : 1;
      if (groupPrintable && first >= ' ' && first !== '\x7f') {
        while (end < this.pending.length && this.pending[end]! >= ' ' && this.pending[end] !== '\x7f' && this.pending[end] !== '\x1b') end++;
      }
      const key = this.pending.slice(0, end);
      this.pending = this.pending.slice(end);
      return key;
    }
    if (this.pending.length === 1) {
      const more = await this.read(40);
      if (typeof more !== 'string' || (more[0] !== '[' && more[0] !== 'O')) {
        this.pending = typeof more === 'string' ? more : '';
        return '\x1b';
      }
      this.pending += more;
    }
    const match = /^\x1b(?:\[[0-9;?]*[A-Za-z~]|O[A-Za-z]|.)/s.exec(this.pending);
    const key = match ? match[0] : '\x1b';
    this.pending = this.pending.slice(key.length);
    return key;
  }
}

export class LineEditor {
  constructor(
    private readonly io: LineEditorIo,
    private readonly history: History,
    private readonly complete: Completer,
    private readonly keys: KeyReader,
  ) { }

  async readLine(prompt: string): Promise<string | null> {
    let line = '';
    let cursor = 0;
    let historyIndex = this.history.size;
    let draft = '';
    let lastWasTab = false;
    let search: { query: string; match: number } | undefined;

    const render = (): void => {
      if (search) {
        const found = search.match >= 0 ? this.history.at(search.match) ?? '' : '';
        this.io.write(`\r(reverse-i-search)\`${search.query}': ${found}\x1b[K`);
        return;
      }
      const back = line.length - cursor;
      this.io.write(`\r${prompt}${line}\x1b[K${back > 0 ? `\x1b[${back}D` : ''}`);
    };

    const findBackward = (query: string, from: number): number => {
      for (let i = Math.min(from, this.history.size - 1); i >= 0; i--) {
        if (this.history.at(i)!.includes(query)) return i;
      }
      return -1;
    };

    const insert = (text: string): void => {
      line = line.slice(0, cursor) + text + line.slice(cursor);
      cursor += text.length;
    };

    const recall = (index: number): void => {
      if (historyIndex === this.history.size) draft = line;
      historyIndex = index;
      line = index === this.history.size ? draft : this.history.at(index) ?? '';
      cursor = line.length;
    };

    const tab = (): void => {
      const { start, candidates } = this.complete(line, cursor);
      if (candidates.length === 0) {
        this.io.write('\x07');
        return;
      }
      const word = line.slice(start, cursor);
      if (candidates.length === 1) {
        const only = candidates[0]!;
        const finished = only.endsWith('/') ? only : only + ' ';
        line = line.slice(0, start) + finished + line.slice(cursor);
        cursor = start + finished.length;
        return;
      }
      const prefix = commonPrefix(candidates);
      if (prefix.length > word.length) {
        line = line.slice(0, start) + prefix + line.slice(cursor);
        cursor = start + prefix.length;
        return;
      }
      if (!lastWasTab) {
        this.io.write('\x07');
        return;
      }
      const shown = candidates.map((candidate) => {
        const trimmed = candidate.endsWith('/') ? candidate.slice(0, -1) : candidate;
        const slash = trimmed.lastIndexOf('/');
        return slash === -1 ? candidate : candidate.slice(slash + 1);
      });
      this.io.write('\r\n' + columnize(shown, this.io.columns()));
    };

    this.io.write(prompt);
    while (true) {
      const input = await this.keys.next(true);
      if (input === undefined) continue;
      if (input === null) {
        if (line.length === 0) return null;
        this.io.write('\r\n');
        return line;
      }
      const key = input;
      const tabbed = key === '\t';

      if (search) {
        if (key === '\x12') {
          search.match = findBackward(search.query, search.match - 1);
        } else if (key === '\x7f' || key === '\x08') {
          search.query = search.query.slice(0, -1);
          search.match = findBackward(search.query, this.history.size - 1);
        } else if (key.length === 1 && key >= ' ') {
          search.query += key;
          search.match = findBackward(search.query, search.match >= 0 ? search.match : this.history.size - 1);
        } else {
          if (key === '\x07' || key === '\x03') {
            search = undefined;
          } else {
            if (search.match >= 0) {
              historyIndex = search.match;
              line = this.history.at(search.match) ?? line;
              cursor = line.length;
            }
            search = undefined;
            if (key === '\r' || key === '\n') {
              render();
              this.io.write('\r\n');
              return line;
            }
          }
        }
        render();
        lastWasTab = false;
        continue;
      }

      switch (key) {
        case '\r':
        case '\n':
          this.io.write('\r\n');
          return line;
        case '\x03':
          this.io.write('^C\r\n');
          return '';
        case '\x04':
          if (line.length === 0) {
            this.io.write('\r\n');
            return null;
          }
          if (cursor < line.length) line = line.slice(0, cursor) + line.slice(cursor + 1);
          break;
        case '\x7f':
        case '\x08':
          if (cursor > 0) {
            line = line.slice(0, cursor - 1) + line.slice(cursor);
            cursor--;
          }
          break;
        case '\x1b[3~':
          if (cursor < line.length) line = line.slice(0, cursor) + line.slice(cursor + 1);
          break;
        case '\x1b[D':
        case '\x02':
          if (cursor > 0) cursor--;
          break;
        case '\x1b[C':
        case '\x06':
          if (cursor < line.length) cursor++;
          break;
        case '\x1b[H':
        case '\x1bOH':
        case '\x1b[1~':
        case '\x01':
          cursor = 0;
          break;
        case '\x1b[F':
        case '\x1bOF':
        case '\x1b[4~':
        case '\x05':
          cursor = line.length;
          break;
        case '\x1b[A':
        case '\x10':
          if (historyIndex > 0) recall(historyIndex - 1);
          break;
        case '\x1b[B':
        case '\x0e':
          if (historyIndex < this.history.size) recall(historyIndex + 1);
          break;
        case '\x0b':
          line = line.slice(0, cursor);
          break;
        case '\x15':
          line = line.slice(cursor);
          cursor = 0;
          break;
        case '\x17': {
          let start = cursor;
          while (start > 0 && line[start - 1] === ' ') start--;
          while (start > 0 && line[start - 1] !== ' ') start--;
          line = line.slice(0, start) + line.slice(cursor);
          cursor = start;
          break;
        }
        case '\x1bb':
        case '\x1b[1;5D':
          while (cursor > 0 && !isWordChar(line[cursor - 1])) cursor--;
          while (cursor > 0 && isWordChar(line[cursor - 1])) cursor--;
          break;
        case '\x1bf':
        case '\x1b[1;5C':
          while (cursor < line.length && !isWordChar(line[cursor])) cursor++;
          while (cursor < line.length && isWordChar(line[cursor])) cursor++;
          break;
        case '\x0c':
          this.io.write('\x1b[H\x1b[2J');
          break;
        case '\x12':
          search = { query: '', match: -1 };
          break;
        case '\t':
          tab();
          break;
        default:
          if (key.startsWith('\x1b')) break;
          insert([...key].filter((char) => char >= ' ').join(''));
      }
      lastWasTab = tabbed;
      render();
    }
  }
}
