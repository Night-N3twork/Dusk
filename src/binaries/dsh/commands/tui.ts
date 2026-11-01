import type { TerminalAccess } from '../../../vendor/just-bash/types';

export const CSI = '\x1b[';
export const ALT_SCREEN_ON = '\x1b[?1049h';
export const ALT_SCREEN_OFF = '\x1b[?1049l';
export const HIDE_CURSOR = '\x1b[?25l';
export const SHOW_CURSOR = '\x1b[?25h';
export const CLEAR_LINE = '\x1b[K';
export const RESET = '\x1b[0m';

export const moveTo = (row: number, col: number): string => `${CSI}${row + 1};${col + 1}H`;
export const inverse = (text: string): string => `${CSI}7m${text}${CSI}27m`;

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/y;

export const expandTabs = (line: string, tabSize = 8): string => {
  if (!line.includes('\t')) return line;
  let out = '';
  for (const char of line) {
    if (char === '\t') out += ' '.repeat(tabSize - (out.length % tabSize));
    else out += char;
  }
  return out;
};

export const displayColumn = (line: string, index: number, tabSize = 8): number => {
  let column = 0;
  for (let i = 0; i < index && i < line.length; i++) {
    column = line[i] === '\t' ? column + tabSize - (column % tabSize) : column + 1;
  }
  return column;
};

export const visibleControl = (text: string): string =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (char) => (char === '\x7f' ? '^?' : '^' + String.fromCharCode(char.charCodeAt(0) + 64)));

export const wrapAnsi = (line: string, width: number): string[] => {
  if (width <= 0) return [line];
  const rows: string[] = [];
  let current = '';
  let visible = 0;
  let i = 0;
  while (i < line.length) {
    ANSI.lastIndex = i;
    const escape = ANSI.exec(line);
    if (escape) {
      current += escape[0];
      i += escape[0].length;
      continue;
    }
    if (visible === width) {
      rows.push(current);
      current = '';
      visible = 0;
    }
    const code = line.codePointAt(i)!;
    const char = String.fromCodePoint(code);
    current += char;
    visible++;
    i += char.length;
  }
  rows.push(current);
  return rows;
};

export const fit = (text: string, width: number): string => {
  const chars = [...text];
  return chars.length > width ? chars.slice(0, width).join('') : text;
};

export const promptLine = async (terminal: TerminalAccess, label: string, initial = ''): Promise<string | null> => {
  let value = initial;
  const row = terminal.rows() - 1;
  const draw = (): void => terminal.write(`${moveTo(row, 0)}${label}${value}${CLEAR_LINE}`);
  draw();
  while (true) {
    const key = await terminal.readKey();
    if (key === null || key === '\x1b' || key === '\x03' || key === '\x07') return null;
    if (key === '\r' || key === '\n') return value;
    if (key === '\x7f' || key === '\x08') {
      if (value.length === 0) return null;
      value = [...value].slice(0, -1).join('');
    } else if (key === '\x15') {
      value = '';
    } else if (!key.startsWith('\x1b') && key >= ' ') {
      value += key;
    }
    draw();
  }
};

export const toRegExp = (pattern: string, ignoreCase: boolean): RegExp => {
  const flags = ignoreCase ? 'gi' : 'g';
  try {
    return new RegExp(pattern, flags);
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }
};
