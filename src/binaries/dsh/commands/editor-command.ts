import type { Command, CommandContext, ExecResult, TerminalAccess } from '../../../vendor/just-bash/types';
import {
  ALT_SCREEN_OFF, ALT_SCREEN_ON, CLEAR_LINE, HIDE_CURSOR, RESET, SHOW_CURSOR, displayColumn, expandTabs, fit, inverse,
  moveTo, promptLine, toRegExp, visibleControl,
} from './tui';
import { errorMessage, textResult } from './command-io';

interface Snapshot {
  lines: string[];
  line: number;
  col: number;
}

class TextBuffer {
  lines: string[];
  line = 0;
  col = 0;
  dirty = false;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastGroup = '';

  constructor(text: string, public path: string | undefined) {
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    this.lines = text === '' ? [''] : body.split('\n');
  }

  get current(): string {
    return this.lines[this.line] ?? '';
  }

  set current(value: string) {
    this.lines[this.line] = value;
  }

  text(): string {
    return this.lines.join('\n') + '\n';
  }

  checkpoint(group = ''): void {
    if (group && group === this.lastGroup) return;
    this.lastGroup = group;
    this.undoStack.push({ lines: [...this.lines], line: this.line, col: this.col });
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack = [];
  }

  endGroup(): void {
    this.lastGroup = '';
  }

  undo(): boolean {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return false;
    this.redoStack.push({ lines: [...this.lines], line: this.line, col: this.col });
    this.restore(snapshot);
    return true;
  }

  redo(): boolean {
    const snapshot = this.redoStack.pop();
    if (!snapshot) return false;
    this.undoStack.push({ lines: [...this.lines], line: this.line, col: this.col });
    this.restore(snapshot);
    return true;
  }

  private restore(snapshot: Snapshot): void {
    this.lines = snapshot.lines;
    this.line = snapshot.line;
    this.col = snapshot.col;
    this.dirty = true;
    this.lastGroup = '';
  }

  clampCursor(allowEnd = true): void {
    this.line = Math.min(Math.max(0, this.line), this.lines.length - 1);
    const max = allowEnd ? this.current.length : Math.max(0, this.current.length - 1);
    this.col = Math.min(Math.max(0, this.col), max);
  }

  insert(text: string): void {
    const parts = text.split('\n');
    const before = this.current.slice(0, this.col);
    const after = this.current.slice(this.col);
    if (parts.length === 1) {
      this.current = before + text + after;
      this.col += text.length;
    } else {
      const last = parts[parts.length - 1]!;
      this.lines.splice(this.line, 1, before + parts[0], ...parts.slice(1, -1), last + after);
      this.line += parts.length - 1;
      this.col = last.length;
    }
    this.dirty = true;
  }

  backspace(): void {
    if (this.col > 0) {
      this.current = this.current.slice(0, this.col - 1) + this.current.slice(this.col);
      this.col--;
    } else if (this.line > 0) {
      const removed = this.lines.splice(this.line, 1)[0]!;
      this.line--;
      this.col = this.current.length;
      this.current += removed;
    } else {
      return;
    }
    this.dirty = true;
  }

  deleteForward(): void {
    if (this.col < this.current.length) {
      this.current = this.current.slice(0, this.col) + this.current.slice(this.col + 1);
    } else if (this.line < this.lines.length - 1) {
      this.current += this.lines.splice(this.line + 1, 1)[0]!;
    } else {
      return;
    }
    this.dirty = true;
  }

  removeLines(start: number, count: number): string[] {
    const removed = this.lines.splice(start, count);
    if (this.lines.length === 0) this.lines.push('');
    this.line = Math.min(start, this.lines.length - 1);
    this.dirty = true;
    return removed;
  }

  find(regex: RegExp, direction: 1 | -1, fromLine: number, fromCol: number): { line: number; col: number } | undefined {
    const total = this.lines.length;
    for (let step = 0; step <= total; step++) {
      const index = ((fromLine + direction * step) % total + total) % total;
      const text = this.lines[index]!;
      regex.lastIndex = 0;
      const matches = [...text.matchAll(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g'))];
      const candidates = matches.map((match) => match.index ?? 0).filter((col) => {
        if (step !== 0) return true;
        return direction === 1 ? col > fromCol : col < fromCol;
      });
      if (step === total && candidates.length === 0) break;
      if (candidates.length > 0) return { line: index, col: direction === 1 ? candidates[0]! : candidates[candidates.length - 1]! };
    }
    return undefined;
  }
}

const isWord = (char: string | undefined): boolean => char !== undefined && /\w/.test(char);
const isBlank = (char: string | undefined): boolean => char === undefined || /\s/.test(char);

const loadBuffer = async (ctx: CommandContext, file: string | undefined): Promise<{ buffer: TextBuffer; message: string }> => {
  if (!file) return { buffer: new TextBuffer('', undefined), message: '' };
  const path = ctx.fs.resolvePath(ctx.cwd, file);
  if (!await ctx.fs.exists(path)) return { buffer: new TextBuffer('', path), message: `[ New File ]` };
  const text = await ctx.fs.readFile(path);
  const buffer = new TextBuffer(text, path);
  return { buffer, message: `[ Read ${buffer.lines.length} line${buffer.lines.length === 1 ? '' : 's'} ]` };
};

const save = async (ctx: CommandContext, buffer: TextBuffer, target: string): Promise<string> => {
  const path = ctx.fs.resolvePath(ctx.cwd, target);
  await ctx.fs.writeFile(path, buffer.text());
  buffer.path = path;
  buffer.dirty = false;
  return `[ Wrote ${buffer.lines.length} line${buffer.lines.length === 1 ? '' : 's'} ]`;
};

interface View {
  top: number;
  left: number;
}

const renderLines = (buffer: TextBuffer, view: View, height: number, width: number, gutter: number, filler: string): string => {
  const textWidth = Math.max(1, width - gutter);
  const cursorColumn = displayColumn(buffer.current, buffer.col);
  if (buffer.line < view.top) view.top = buffer.line;
  if (buffer.line >= view.top + height) view.top = buffer.line - height + 1;
  if (cursorColumn < view.left) view.left = cursorColumn;
  if (cursorColumn >= view.left + textWidth) view.left = cursorColumn - textWidth + 1;
  let frame = '';
  for (let r = 0; r < height; r++) {
    const index = view.top + r;
    const line = buffer.lines[index];
    if (line === undefined) {
      frame += filler + CLEAR_LINE + '\r\n';
      continue;
    }
    const number = gutter > 0 ? String(index + 1).padStart(gutter - 1) + ' ' : '';
    const visible = visibleControl(expandTabs(line)).slice(view.left);
    frame += number + fit(visible, textWidth) + RESET + CLEAR_LINE + '\r\n';
  }
  return frame;
};

const cursorPosition = (buffer: TextBuffer, view: View, gutter: number, rowOffset: number): string =>
  moveTo(buffer.line - view.top + rowOffset, gutter + displayColumn(buffer.current, buffer.col) - view.left);

const NANO_SHORTCUTS = [
  [['^G', 'Help'], ['^O', 'Write Out'], ['^W', 'Where Is'], ['^K', 'Cut'], ['^C', 'Location'], ['M-U', 'Undo']],
  [['^X', 'Exit'], ['^S', 'Save'], ['^\\', 'Replace'], ['^U', 'Paste'], ['^_', 'Go To Line'], ['M-E', 'Redo']],
];

const NANO_HELP = `Dusk nano help

  ^G  show this help          ^X  exit (asks to save changes)
  ^O  write the buffer        ^S  save to the current file
  ^W  search forward          ^\\  search and replace
  ^K  cut the current line    ^U  paste the cut lines
  ^C  show cursor position    ^_  go to a line number
  ^A  start of line           ^E  end of line
  ^Y  page up                 ^V  page down
  M-U undo                    M-E redo

Press any key to return to the buffer.`;

const runNano = async (ctx: CommandContext, terminal: TerminalAccess, file: string | undefined, startLine: number): Promise<ExecResult> => {
  const { buffer, message: loaded } = await loadBuffer(ctx, file);
  buffer.line = startLine;
  buffer.clampCursor();
  const view: View = { top: 0, left: 0 };
  let message = loaded;
  let cut: string[] = [];
  let cutting = false;
  let lastSearch = '';
  let desiredColumn = -1;

  const height = (): number => Math.max(1, terminal.rows() - 4);

  const render = (): void => {
    const width = terminal.columns();
    const name = buffer.path ? buffer.path.slice(buffer.path.lastIndexOf('/') + 1) : 'New Buffer';
    const title = `  Dusk nano  ${name}${buffer.dirty ? '  Modified' : ''}`;
    let frame = HIDE_CURSOR + moveTo(0, 0) + inverse(fit(title.padEnd(width), width)) + '\r\n';
    frame += renderLines(buffer, view, height(), width, 0, '');
    frame += moveTo(terminal.rows() - 3, 0) + (message ? inverse(fit(message, width)) : '') + CLEAR_LINE;
    NANO_SHORTCUTS.forEach((row, i) => {
      const cell = Math.max(10, Math.floor(width / row.length));
      const text = row.map(([key, label]) => inverse(key!) + ' ' + label!.padEnd(cell - key!.length - 1)).join('');
      frame += moveTo(terminal.rows() - 2 + i, 0) + text + RESET + CLEAR_LINE;
    });
    frame += cursorPosition(buffer, view, 0, 1) + SHOW_CURSOR;
    terminal.write(frame);
    message = '';
  };

  const writeOut = async (): Promise<boolean> => {
    const name = await promptLine(terminal, 'File Name to Write: ', buffer.path ? buffer.path : '');
    if (name === null || name === '') {
      message = 'Cancelled';
      return false;
    }
    try {
      message = await save(ctx, buffer, name);
      return true;
    } catch (error) {
      message = `Error writing ${name}: ${errorMessage(error)}`;
      return false;
    }
  };

  const moveVertical = (delta: number): void => {
    if (desiredColumn < 0) desiredColumn = displayColumn(buffer.current, buffer.col);
    buffer.line = Math.min(Math.max(0, buffer.line + delta), buffer.lines.length - 1);
    let col = 0;
    while (col < buffer.current.length && displayColumn(buffer.current, col + 1) <= desiredColumn) col++;
    buffer.col = col;
  };

  terminal.setRaw(true);
  terminal.write(ALT_SCREEN_ON);
  try {
    render();
    while (true) {
      const key = await terminal.readKey();
      if (key === null) break;
      const vertical = ['\x1b[A', '\x1b[B', '\x10', '\x0e', '\x19', '\x16', '\x1b[5~', '\x1b[6~'].includes(key);
      if (!vertical) desiredColumn = -1;
      const typing = !key.startsWith('\x1b') && key >= ' ' && key !== '\x7f';
      const deleting = key === '\x7f' || key === '\x08' || key === '\x1b[3~' || key === '\x04';
      if (!typing && !deleting) buffer.endGroup();
      if (key !== '\x0b') cutting = false;
      switch (key) {
        case '\x18': {
          if (buffer.dirty) {
            terminal.write(moveTo(terminal.rows() - 3, 0) + inverse('Save modified buffer?  (Y)es, (N)o, ^C cancel') + CLEAR_LINE);
            const answer = await terminal.readKey();
            if (answer === 'y' || answer === 'Y') {
              if (!await writeOut()) break;
              return textResult('');
            }
            if (answer === 'n' || answer === 'N') return textResult('');
            message = 'Cancelled';
            break;
          }
          return textResult('');
        }
        case '\x0f':
          await writeOut();
          break;
        case '\x13':
          if (buffer.path) {
            try { message = await save(ctx, buffer, buffer.path); } catch (error) { message = `Error writing: ${errorMessage(error)}`; }
          } else {
            await writeOut();
          }
          break;
        case '\x07':
          terminal.write(moveTo(0, 0) + '\x1b[2J' + NANO_HELP.replace(/\n/g, '\r\n'));
          await terminal.readKey();
          break;
        case '\x17': {
          const pattern = await promptLine(terminal, `Search${lastSearch ? ` [${lastSearch}]` : ''}: `);
          if (pattern === null) { message = 'Cancelled'; break; }
          if (pattern) lastSearch = pattern;
          if (!lastSearch) break;
          const found = buffer.find(toRegExp(lastSearch, true), 1, buffer.line, buffer.col);
          if (found) { buffer.line = found.line; buffer.col = found.col; } else message = `"${lastSearch}" not found`;
          break;
        }
        case '\x1c': {
          const pattern = await promptLine(terminal, 'Search (to replace): ');
          if (!pattern) { message = 'Cancelled'; break; }
          const replacement = await promptLine(terminal, 'Replace with: ');
          if (replacement === null) { message = 'Cancelled'; break; }
          buffer.checkpoint();
          const regex = toRegExp(pattern, false);
          let count = 0;
          buffer.lines = buffer.lines.map((line) => line.replace(regex, () => { count++; return replacement; }));
          if (count > 0) buffer.dirty = true;
          buffer.clampCursor();
          message = `Replaced ${count} occurrence${count === 1 ? '' : 's'}`;
          break;
        }
        case '\x03': {
          const total = buffer.lines.length;
          message = `line ${buffer.line + 1}/${total} (${Math.round(((buffer.line + 1) / total) * 100)}%), col ${buffer.col + 1}/${buffer.current.length + 1}`;
          break;
        }
        case '\x1f': {
          const answer = await promptLine(terminal, 'Enter line number, column number: ');
          if (!answer) { message = 'Cancelled'; break; }
          const [lineText, colText] = answer.split(/[ ,]+/);
          buffer.line = (Number(lineText) || 1) - 1;
          buffer.col = (Number(colText) || 1) - 1;
          buffer.clampCursor();
          break;
        }
        case '\x0b': {
          buffer.checkpoint();
          if (!cutting) cut = [];
          cut.push(...buffer.removeLines(buffer.line, 1));
          buffer.col = 0;
          cutting = true;
          break;
        }
        case '\x15':
          if (cut.length === 0) break;
          buffer.checkpoint();
          buffer.lines.splice(buffer.line, 0, ...cut);
          buffer.line += cut.length;
          buffer.col = 0;
          buffer.dirty = true;
          buffer.clampCursor();
          break;
        case '\x1bu':
          if (!buffer.undo()) message = 'Nothing to undo';
          buffer.clampCursor();
          break;
        case '\x1be':
          if (!buffer.redo()) message = 'Nothing to redo';
          buffer.clampCursor();
          break;
        case '\r': case '\n': {
          buffer.checkpoint('newline');
          const indent = /^[ \t]*/.exec(buffer.current)![0].slice(0, buffer.col);
          buffer.insert('\n' + indent);
          buffer.endGroup();
          break;
        }
        case '\x7f': case '\x08':
          buffer.checkpoint('delete');
          buffer.backspace();
          break;
        case '\x1b[3~': case '\x04':
          buffer.checkpoint('delete');
          buffer.deleteForward();
          break;
        case '\x1b[D': case '\x02':
          if (buffer.col > 0) buffer.col--;
          else if (buffer.line > 0) { buffer.line--; buffer.col = buffer.current.length; }
          break;
        case '\x1b[C': case '\x06':
          if (buffer.col < buffer.current.length) buffer.col++;
          else if (buffer.line < buffer.lines.length - 1) { buffer.line++; buffer.col = 0; }
          break;
        case '\x1b[A': case '\x10': moveVertical(-1); break;
        case '\x1b[B': case '\x0e': moveVertical(1); break;
        case '\x1b[5~': case '\x19': moveVertical(-height()); break;
        case '\x1b[6~': case '\x16': moveVertical(height()); break;
        case '\x1b[H': case '\x1bOH': case '\x1b[1~': case '\x01': buffer.col = 0; break;
        case '\x1b[F': case '\x1bOF': case '\x1b[4~': case '\x05': buffer.col = buffer.current.length; break;
        case '\t':
          buffer.checkpoint('type');
          buffer.insert('\t');
          break;
        default:
          if (key.startsWith('\x1b') || key < ' ') break;
          buffer.checkpoint('type');
          buffer.insert(key);
          if (key.includes(' ')) buffer.endGroup();
      }
      render();
    }
    return textResult('');
  } finally {
    terminal.write(ALT_SCREEN_OFF);
    terminal.setRaw(false);
  }
};

type ViMode = 'normal' | 'insert';

const wordForward = (buffer: TextBuffer): void => {
  let { line, col } = buffer;
  let text = buffer.lines[line]!;
  const startWord = isWord(text[col]);
  if (!isBlank(text[col])) while (col < text.length && !isBlank(text[col]) && isWord(text[col]) === startWord) col++;
  while (true) {
    while (col < text.length && isBlank(text[col])) col++;
    if (col < text.length || line >= buffer.lines.length - 1) break;
    line++;
    col = 0;
    text = buffer.lines[line]!;
    if (text.length === 0) break;
  }
  buffer.line = line;
  buffer.col = Math.min(col, Math.max(0, text.length - 1));
};

const wordBackward = (buffer: TextBuffer): void => {
  let { line, col } = buffer;
  let text = buffer.lines[line]!;
  col--;
  while (true) {
    while (col >= 0 && isBlank(text[col])) col--;
    if (col >= 0 || line === 0) break;
    line--;
    text = buffer.lines[line]!;
    col = text.length - 1;
  }
  if (col < 0) col = 0;
  const kind = isWord(text[col]);
  while (col > 0 && !isBlank(text[col - 1]) && isWord(text[col - 1]) === kind) col--;
  buffer.line = line;
  buffer.col = col;
};

const wordEnd = (buffer: TextBuffer): void => {
  let { line, col } = buffer;
  let text = buffer.lines[line]!;
  col++;
  while (true) {
    while (col < text.length && isBlank(text[col])) col++;
    if (col < text.length || line >= buffer.lines.length - 1) break;
    line++;
    text = buffer.lines[line]!;
    col = 0;
  }
  const kind = isWord(text[col]);
  while (col < text.length - 1 && !isBlank(text[col + 1]) && isWord(text[col + 1]) === kind) col++;
  buffer.line = line;
  buffer.col = Math.min(col, Math.max(0, text.length - 1));
};

const runVi = async (ctx: CommandContext, terminal: TerminalAccess, file: string | undefined, startLine: number): Promise<ExecResult> => {
  const { buffer, message: loaded } = await loadBuffer(ctx, file);
  buffer.line = startLine;
  buffer.clampCursor(false);
  const view: View = { top: 0, left: 0 };
  let mode = 'normal' as ViMode;
  let message = buffer.path ? `"${buffer.path.slice(buffer.path.lastIndexOf('/') + 1)}" ${loaded.replace(/[[\]]/g, '').trim()}` : '';
  let register: { text: string; linewise: boolean } = { text: '', linewise: false };
  let search: { regex: RegExp; direction: 1 | -1 } | undefined;
  let numbers = false;
  let pendingCount = '';

  const height = (): number => Math.max(1, terminal.rows() - 1);
  const gutter = (): number => (numbers ? Math.max(4, String(buffer.lines.length).length + 2) : 0);

  const render = (): void => {
    if (mode === 'normal') buffer.clampCursor(false);
    let frame = HIDE_CURSOR + moveTo(0, 0) + renderLines(buffer, view, height(), terminal.columns(), gutter(), '~');
    const status = message || (mode === 'insert' ? '-- INSERT --' : '');
    frame += moveTo(height(), 0) + fit(status, terminal.columns()) + CLEAR_LINE;
    frame += cursorPosition(buffer, view, gutter(), 0) + SHOW_CURSOR;
    terminal.write(frame);
    message = '';
  };

  const yankLines = (start: number, count: number): void => {
    register = { text: buffer.lines.slice(start, start + count).join('\n'), linewise: true };
  };

  const paste = (after: boolean): void => {
    if (!register.text && !register.linewise) return;
    buffer.checkpoint();
    if (register.linewise) {
      const lines = register.text.split('\n');
      const at = after ? buffer.line + 1 : buffer.line;
      buffer.lines.splice(at, 0, ...lines);
      buffer.line = at;
      buffer.col = 0;
    } else {
      if (after && buffer.current.length > 0) buffer.col++;
      buffer.insert(register.text);
      buffer.col--;
    }
    buffer.dirty = true;
  };

  const runSearch = (direction: 1 | -1): void => {
    if (!search) {
      message = 'E35: No previous regular expression';
      return;
    }
    const found = buffer.find(search.regex, direction, buffer.line, buffer.col);
    if (found) {
      buffer.line = found.line;
      buffer.col = found.col;
    } else {
      message = `E486: Pattern not found: ${search.regex.source}`;
    }
  };

  const ex = async (command: string): Promise<'quit' | undefined> => {
    const trimmed = command.trim();
    if (/^\d+$/.test(trimmed)) {
      buffer.line = Number(trimmed) - 1;
      buffer.col = 0;
      buffer.clampCursor(false);
      return undefined;
    }
    if (trimmed === '$') {
      buffer.line = buffer.lines.length - 1;
      return undefined;
    }
    const substitute = /^(%?)s(.)(.*?)\2(.*?)(?:\2([gi]*))?$/.exec(trimmed);
    if (substitute) {
      const [, all, , pattern, replacement, flags] = substitute;
      const regex = new RegExp(pattern || search?.regex.source || '', (flags?.includes('g') ? 'g' : '') + (flags?.includes('i') ? 'i' : ''));
      buffer.checkpoint();
      let count = 0;
      const apply = (line: string): string => line.replace(regex, (...match) => {
        count++;
        return replacement!.replace(/\\(\d)|&/g, (token, group: string | undefined) => (group !== undefined ? String(match[Number(group)] ?? '') : String(match[0])));
      });
      if (all) buffer.lines = buffer.lines.map(apply);
      else buffer.current = apply(buffer.current);
      if (count > 0) buffer.dirty = true;
      else message = `E486: Pattern not found: ${pattern}`;
      return undefined;
    }
    const match = /^(\w+)(!?)\s*(.*)$/.exec(trimmed);
    if (!match) return undefined;
    const [, name, bang, argument] = match;
    const writeTo = async (target: string): Promise<boolean> => {
      if (!target) {
        message = 'E32: No file name';
        return false;
      }
      try {
        await save(ctx, buffer, target);
        message = `"${target}" ${buffer.lines.length}L written`;
        return true;
      } catch (error) {
        message = `E212: Can't open file for writing: ${errorMessage(error)}`;
        return false;
      }
    };
    switch (name) {
      case 'w':
        await writeTo(argument || buffer.path || '');
        return undefined;
      case 'wq': case 'x': case 'xit':
        if (name !== 'wq' && !buffer.dirty) return 'quit';
        return (await writeTo(argument || buffer.path || '')) ? 'quit' : undefined;
      case 'q': case 'quit':
        if (buffer.dirty && !bang) {
          message = 'E37: No write since last change (add ! to override)';
          return undefined;
        }
        return 'quit';
      case 'set': case 'se':
        if (argument === 'nu' || argument === 'number') numbers = true;
        else if (argument === 'nonu' || argument === 'nonumber') numbers = false;
        return undefined;
      default:
        message = `E492: Not an editor command: ${trimmed}`;
        return undefined;
    }
  };

  const readMotionTarget = async (): Promise<string | null> => terminal.readKey();

  terminal.setRaw(true);
  terminal.write(ALT_SCREEN_ON);
  try {
    render();
    while (true) {
      const key = await terminal.readKey();
      if (key === null) break;
      if (mode === 'insert') {
        switch (key) {
          case '\x1b': case '\x03':
            mode = 'normal';
            buffer.endGroup();
            if (buffer.col > 0) buffer.col--;
            break;
          case '\r': case '\n':
            buffer.checkpoint('insert');
            buffer.insert('\n');
            break;
          case '\x7f': case '\x08':
            buffer.checkpoint('insert');
            buffer.backspace();
            break;
          case '\x1b[3~':
            buffer.checkpoint('insert');
            buffer.deleteForward();
            break;
          case '\x1b[D': if (buffer.col > 0) buffer.col--; break;
          case '\x1b[C': if (buffer.col < buffer.current.length) buffer.col++; break;
          case '\x1b[A': buffer.line = Math.max(0, buffer.line - 1); buffer.clampCursor(); break;
          case '\x1b[B': buffer.line = Math.min(buffer.lines.length - 1, buffer.line + 1); buffer.clampCursor(); break;
          case '\t':
            buffer.checkpoint('insert');
            buffer.insert('\t');
            break;
          default:
            if (key.startsWith('\x1b') || key < ' ') break;
            buffer.checkpoint('insert');
            buffer.insert(key);
        }
        render();
        continue;
      }

      if (/^[1-9]$/.test(key) || (pendingCount && key === '0')) {
        pendingCount += key;
        continue;
      }
      const count = Math.max(1, Number(pendingCount) || 1);
      const explicitCount = pendingCount !== '';
      pendingCount = '';
      const enterInsert = (): void => {
        buffer.endGroup();
        buffer.checkpoint('insert');
        mode = 'insert';
      };

      switch (key) {
        case 'h': case '\x1b[D': case '\x7f': case '\x08': buffer.col = Math.max(0, buffer.col - count); break;
        case 'l': case ' ': case '\x1b[C': buffer.col += count; break;
        case 'j': case '\x1b[B': case '\x0e': case '+': case '\r': case '\n':
          buffer.line = Math.min(buffer.lines.length - 1, buffer.line + count);
          if (key === '+' || key === '\r' || key === '\n') buffer.col = /^\s*/.exec(buffer.current)![0].length;
          break;
        case 'k': case '\x1b[A': case '\x10': case '-':
          buffer.line = Math.max(0, buffer.line - count);
          if (key === '-') buffer.col = /^\s*/.exec(buffer.current)![0].length;
          break;
        case '0': case '\x1b[H': case '\x1b[1~': buffer.col = 0; break;
        case '^': buffer.col = /^\s*/.exec(buffer.current)![0].length; break;
        case '$': case '\x1b[F': case '\x1b[4~': buffer.col = Math.max(0, buffer.current.length - 1); break;
        case 'w': for (let i = 0; i < count; i++) wordForward(buffer); break;
        case 'b': for (let i = 0; i < count; i++) wordBackward(buffer); break;
        case 'e': for (let i = 0; i < count; i++) wordEnd(buffer); break;
        case 'G': buffer.line = explicitCount ? count - 1 : buffer.lines.length - 1; buffer.col = 0; break;
        case 'g': {
          const next = await readMotionTarget();
          if (next === 'g') { buffer.line = explicitCount ? count - 1 : 0; buffer.col = 0; }
          break;
        }
        case '\x06': case '\x1b[6~': buffer.line = Math.min(buffer.lines.length - 1, buffer.line + height() * count); break;
        case '\x02': case '\x1b[5~': buffer.line = Math.max(0, buffer.line - height() * count); break;
        case '\x04': buffer.line = Math.min(buffer.lines.length - 1, buffer.line + Math.floor(height() / 2)); break;
        case '\x15': buffer.line = Math.max(0, buffer.line - Math.floor(height() / 2)); break;
        case 'i': enterInsert(); break;
        case 'I': buffer.col = /^\s*/.exec(buffer.current)![0].length; enterInsert(); break;
        case 'a': if (buffer.current.length > 0) buffer.col++; enterInsert(); break;
        case 'A': buffer.col = buffer.current.length; enterInsert(); break;
        case 'o': case 'O':
          enterInsert();
          buffer.lines.splice(key === 'o' ? buffer.line + 1 : buffer.line, 0, '');
          if (key === 'o') buffer.line++;
          buffer.col = 0;
          buffer.dirty = true;
          break;
        case 'x':
          if (buffer.current.length === 0) break;
          buffer.checkpoint();
          register = { text: buffer.current.slice(buffer.col, buffer.col + count), linewise: false };
          buffer.current = buffer.current.slice(0, buffer.col) + buffer.current.slice(buffer.col + count);
          buffer.dirty = true;
          break;
        case 'X':
          if (buffer.col === 0) break;
          buffer.checkpoint();
          register = { text: buffer.current.slice(Math.max(0, buffer.col - count), buffer.col), linewise: false };
          buffer.current = buffer.current.slice(0, Math.max(0, buffer.col - count)) + buffer.current.slice(buffer.col);
          buffer.col = Math.max(0, buffer.col - count);
          buffer.dirty = true;
          break;
        case 'D': case 'C':
          if (key === 'C') enterInsert();
          else buffer.checkpoint();
          register = { text: buffer.current.slice(buffer.col), linewise: false };
          buffer.current = buffer.current.slice(0, buffer.col);
          buffer.dirty = true;
          break;
        case 'S':
          enterInsert();
          buffer.current = '';
          buffer.col = 0;
          buffer.dirty = true;
          break;
        case 'd': case 'c': case 'y': {
          const motion = await readMotionTarget();
          if (motion === key) {
            const total = Math.min(count, buffer.lines.length - buffer.line);
            yankLines(buffer.line, total);
            if (key === 'y') break;
            if (key === 'c') {
              enterInsert();
              buffer.lines.splice(buffer.line, total, '');
              buffer.col = 0;
              buffer.dirty = true;
            } else {
              buffer.checkpoint();
              buffer.removeLines(buffer.line, total);
              buffer.col = /^\s*/.exec(buffer.current)![0].length;
            }
            break;
          }
          if (motion === 'w' || motion === 'e' || motion === '$') {
            const start = buffer.col;
            const startLine = buffer.line;
            if (motion === '$') buffer.col = buffer.current.length;
            else {
              for (let i = 0; i < count; i++) (motion === 'w' && key !== 'c' ? wordForward : wordEnd)(buffer);
              if (buffer.line !== startLine) { buffer.line = startLine; buffer.col = buffer.current.length; }
              else if (motion === 'e' || key === 'c') buffer.col++;
            }
            const end = buffer.col;
            register = { text: buffer.current.slice(start, end), linewise: false };
            buffer.col = start;
            if (key === 'y') break;
            if (key === 'c') enterInsert();
            else buffer.checkpoint();
            buffer.current = buffer.current.slice(0, start) + buffer.current.slice(end);
            buffer.dirty = true;
          }
          break;
        }
        case 'Y': yankLines(buffer.line, Math.min(count, buffer.lines.length - buffer.line)); break;
        case 'p': paste(true); break;
        case 'P': paste(false); break;
        case 'J':
          if (buffer.line >= buffer.lines.length - 1) break;
          buffer.checkpoint();
          buffer.col = buffer.current.length;
          buffer.current = buffer.current.replace(/\s+$/, '') + ' ' + buffer.lines.splice(buffer.line + 1, 1)[0]!.replace(/^\s+/, '');
          buffer.dirty = true;
          break;
        case 'r': {
          const replacement = await terminal.readKey();
          if (!replacement || replacement.startsWith('\x1b') || replacement.length !== 1 || buffer.current.length === 0) break;
          buffer.checkpoint();
          buffer.current = buffer.current.slice(0, buffer.col) + replacement + buffer.current.slice(buffer.col + 1);
          buffer.dirty = true;
          break;
        }
        case '~': {
          if (buffer.current.length === 0) break;
          buffer.checkpoint();
          const end = Math.min(buffer.current.length, buffer.col + count);
          const toggled = [...buffer.current.slice(buffer.col, end)].map((char) => (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase())).join('');
          buffer.current = buffer.current.slice(0, buffer.col) + toggled + buffer.current.slice(end);
          buffer.col = end;
          buffer.dirty = true;
          break;
        }
        case 'u':
          if (!buffer.undo()) message = 'Already at oldest change';
          break;
        case '\x12':
          if (!buffer.redo()) message = 'Already at newest change';
          break;
        case 'n': runSearch(search?.direction ?? 1); break;
        case 'N': runSearch(search?.direction === 1 ? -1 : 1); break;
        case '/': case '?': {
          const pattern = await promptLine(terminal, key);
          if (pattern === null) break;
          const direction: 1 | -1 = key === '/' ? 1 : -1;
          search = { regex: pattern ? toRegExp(pattern, false) : search?.regex ?? toRegExp('', false), direction };
          runSearch(direction);
          break;
        }
        case ':': {
          const command = await promptLine(terminal, ':');
          if (command !== null && await ex(command) === 'quit') return textResult('');
          break;
        }
        case 'Z': {
          const next = await terminal.readKey();
          if (next === 'Q') return textResult('');
          if (next === 'Z') {
            if (!buffer.dirty) return textResult('');
            if (await ex('x') === 'quit') return textResult('');
          }
          break;
        }
        case '\x07': {
          const name = buffer.path ? `"${buffer.path}"` : '[No Name]';
          message = `${name}${buffer.dirty ? ' [Modified]' : ''} ${buffer.lines.length} lines --${Math.round(((buffer.line + 1) / buffer.lines.length) * 100)}%--`;
          break;
        }
        case '\x1b':
          break;
        default:
          break;
      }
      render();
    }
    return textResult('');
  } finally {
    terminal.write(ALT_SCREEN_OFF);
    terminal.setRaw(false);
  }
};

const run = async (name: string, args: string[], ctx: CommandContext): Promise<ExecResult> => {
  const files = args.filter((arg) => !arg.startsWith('-') && !arg.startsWith('+'));
  const lineArg = args.find((arg) => /^\+\d+$/.test(arg));
  const startLine = lineArg ? Number(lineArg.slice(1)) - 1 : 0;
  if (!ctx.terminal) return textResult('', `${name}: standard output is not a terminal\n`, 1);
  try {
    return name === 'nano'
      ? await runNano(ctx, ctx.terminal, files[0], startLine)
      : await runVi(ctx, ctx.terminal, files[0], startLine);
  } catch (error) {
    return textResult('', `${name}: ${errorMessage(error)}\n`, 1);
  }
};

export const nanoCommand: Command = { name: 'nano', execute: (args, ctx) => run('nano', args, ctx) };
export const viCommand: Command = { name: 'vi', execute: (args, ctx) => run('vi', args, ctx) };
export const vimCommand: Command = { name: 'vim', execute: (args, ctx) => run('vim', args, ctx) };
