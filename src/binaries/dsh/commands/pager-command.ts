import type { Command, CommandContext, ExecResult, TerminalAccess } from '../../../vendor/just-bash/types';
import { decodeBytesToUtf8 } from '../../../vendor/just-bash/encoding';
import {
  ALT_SCREEN_OFF, ALT_SCREEN_ON, CLEAR_LINE, HIDE_CURSOR, RESET, SHOW_CURSOR, expandTabs, fit, inverse, moveTo, promptLine,
  toRegExp, visibleControl, wrapAnsi,
} from './tui';
import { errorMessage, textResult } from './command-io';

interface PagerOptions {
  lineNumbers: boolean;
  chop: boolean;
  ignoreCase: boolean;
  quitIfOneScreen: boolean;
  rawControl: boolean;
  noAltScreen: boolean;
  quitAtEnd: boolean;
  files: string[];
}

interface DisplayRow {
  text: string;
  line: number;
  first: boolean;
}

const HELP = `
                   SUMMARY OF LESS COMMANDS

  q  :q  Q           Exit.
  SPACE  f  ^F  ^V   Forward one window.
  b  ^B  ESC-v       Backward one window.
  j  e  ^N  ENTER    Forward one line.
  k  y  ^P           Backward one line.
  d  ^D              Forward one half-window.
  u  ^U              Backward one half-window.
  g  <  HOME         Go to first line.
  G  >  END          Go to last line.
  /pattern           Search forward.
  ?pattern           Search backward.
  n                  Repeat previous search.
  N                  Repeat previous search in reverse direction.
  -N                 Toggle line numbers.
  -S                 Toggle line chopping.
  h  H               Display this help.

                     Press q to return.
`;

const parseOptions = (name: string, args: string[]): PagerOptions => {
  const options: PagerOptions = {
    lineNumbers: false,
    chop: false,
    ignoreCase: false,
    quitIfOneScreen: false,
    rawControl: false,
    noAltScreen: false,
    quitAtEnd: name === 'more',
    files: [],
  };
  for (const arg of args) {
    if (arg === '--') continue;
    if (arg.startsWith('--')) {
      if (arg === '--LINE-NUMBERS') options.lineNumbers = true;
      else if (arg === '--chop-long-lines') options.chop = true;
      else if (arg === '--ignore-case') options.ignoreCase = true;
      else if (arg === '--quit-if-one-screen') options.quitIfOneScreen = true;
      else if (arg === '--RAW-CONTROL-CHARS' || arg === '--raw-control-chars') options.rawControl = true;
      else if (arg === '--no-init') options.noAltScreen = true;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (const flag of arg.slice(1)) {
        if (flag === 'N') options.lineNumbers = true;
        else if (flag === 'S') options.chop = true;
        else if (flag === 'i' || flag === 'I') options.ignoreCase = true;
        else if (flag === 'F') options.quitIfOneScreen = true;
        else if (flag === 'R' || flag === 'r') options.rawControl = true;
        else if (flag === 'X') options.noAltScreen = true;
        else if (flag === 'E') options.quitAtEnd = true;
      }
      continue;
    }
    options.files.push(arg);
  }
  return options;
};

const loadContent = async (ctx: CommandContext, options: PagerOptions, name: string): Promise<{ text: string; errors: string; title: string }> => {
  if (options.files.length === 0) return { text: decodeBytesToUtf8(ctx.stdin), errors: '', title: '' };
  const parts: string[] = [];
  let errors = '';
  for (const file of options.files) {
    try {
      const content = await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, file));
      parts.push(options.files.length > 1 ? `::::::::::::::\n${file}\n::::::::::::::\n${content}` : content);
    } catch (error) {
      errors += `${name}: ${file}: ${errorMessage(error)}\n`;
    }
  }
  return { text: parts.join(''), errors, title: options.files.length === 1 ? options.files[0]! : '' };
};

const page = async (terminal: TerminalAccess, text: string, title: string, options: PagerOptions): Promise<void> => {
  const lines = text.replace(/\n$/, '').split('\n');
  let regex: RegExp | undefined;
  let lastDirection: 1 | -1 = 1;
  let top = 0;
  let message = '';
  let helpMode = false;
  let showTitle = true;

  const build = (source: string[]): DisplayRow[] => {
    const width = Math.max(1, terminal.columns() - (options.lineNumbers ? 8 : 0));
    const rows: DisplayRow[] = [];
    source.forEach((raw, index) => {
      const line = options.rawControl ? expandTabs(raw) : visibleControl(expandTabs(raw));
      const pieces = options.chop ? [line] : wrapAnsi(line, width);
      pieces.forEach((piece, i) => rows.push({ text: options.chop ? fit(piece, width) : piece, line: index, first: i === 0 }));
    });
    return rows;
  };

  const height = (): number => Math.max(1, terminal.rows() - 1);
  let rows = build(lines);
  const maxTop = (): number => Math.max(0, rows.length - height());
  const clamp = (): void => { top = Math.min(Math.max(0, top), maxTop()); };

  const highlight = (text: string): string => {
    if (!regex) return text;
    regex.lastIndex = 0;
    return text.replace(regex, (match) => (match ? inverse(match) : match));
  };

  const render = (): void => {
    const visible = helpMode ? build(HELP.split('\n')) : rows;
    const start = helpMode ? 0 : top;
    let frame = HIDE_CURSOR + moveTo(0, 0);
    for (let r = 0; r < height(); r++) {
      const row = visible[start + r];
      const prefix = row && options.lineNumbers && !helpMode ? (row.first ? String(row.line + 1).padStart(7) + ' ' : ' '.repeat(8)) : '';
      frame += (row ? prefix + highlight(row.text) : '~') + `${RESET}${CLEAR_LINE}\r\n`;
    }
    const atEnd = top >= maxTop();
    let status: string;
    if (message) status = message;
    else if (helpMode) status = 'HELP -- Press q when done';
    else if (options.quitAtEnd) status = `--More--(${rows.length === 0 ? 100 : Math.min(100, Math.round(((top + height()) / rows.length) * 100))}%)`;
    else if (atEnd) status = '(END)';
    else if (showTitle && title) status = title;
    else status = ':';
    frame += moveTo(height(), 0) + inverse(fit(status, terminal.columns())) + CLEAR_LINE + SHOW_CURSOR;
    terminal.write(frame);
    message = '';
  };

  const search = (direction: 1 | -1, from: number): void => {
    if (!regex) {
      message = 'No previous regular expression';
      return;
    }
    for (let i = from; i >= 0 && i < rows.length; i += direction) {
      regex.lastIndex = 0;
      if (regex.test(rows[i]!.text)) {
        top = i;
        clamp();
        return;
      }
    }
    message = 'Pattern not found';
  };

  if (options.quitIfOneScreen && rows.length <= height()) {
    terminal.write(text.endsWith('\n') || text === '' ? text : text + '\n');
    return;
  }

  terminal.setRaw(true);
  if (!options.noAltScreen) terminal.write(ALT_SCREEN_ON);
  try {
    render();
    while (true) {
      const key = await terminal.readKey();
      if (key === null) break;
      showTitle = false;
      if (helpMode) {
        if (key === 'q' || key === 'Q' || key === '\x1b') helpMode = false;
        render();
        continue;
      }
      const half = Math.max(1, Math.floor(height() / 2));
      switch (key) {
        case 'q': case 'Q': case '\x03':
          return;
        case ' ': case 'f': case '\x06': case '\x16': case '\x1b[6~':
          if (options.quitAtEnd && top >= maxTop()) return;
          top += height();
          break;
        case 'b': case '\x02': case '\x1bv': case '\x1b[5~':
          top -= height();
          break;
        case 'j': case 'e': case '\x0e': case '\x05': case '\r': case '\n': case '\x1b[B':
          if (options.quitAtEnd && top >= maxTop()) return;
          top += 1;
          break;
        case 'k': case 'y': case '\x10': case '\x19': case '\x0b': case '\x1b[A':
          top -= 1;
          break;
        case 'd': case '\x04':
          top += half;
          break;
        case 'u': case '\x15':
          top -= half;
          break;
        case 'g': case '<': case '\x1b[H': case '\x1b[1~': case '\x1bOH':
          top = 0;
          break;
        case 'G': case '>': case '\x1b[F': case '\x1b[4~': case '\x1bOF':
          top = maxTop();
          break;
        case 'h': case 'H':
          helpMode = true;
          break;
        case 'n':
          search(lastDirection, top + lastDirection);
          break;
        case 'N':
          search(lastDirection === 1 ? -1 : 1, top - lastDirection);
          break;
        case '/': case '?': {
          const direction: 1 | -1 = key === '/' ? 1 : -1;
          const pattern = await promptLine(terminal, key);
          if (pattern !== null && pattern !== '') {
            regex = toRegExp(pattern, options.ignoreCase);
            lastDirection = direction;
            search(direction, direction === 1 ? top + 1 : top - 1);
          } else if (pattern === '' && regex) {
            lastDirection = direction;
            search(direction, top + direction);
          }
          break;
        }
        case ':': {
          const command = await promptLine(terminal, ':');
          if (command === 'q' || command === 'Q') return;
          break;
        }
        case '-': {
          const toggle = await terminal.readKey();
          if (toggle === 'N') options.lineNumbers = !options.lineNumbers;
          else if (toggle === 'S') options.chop = !options.chop;
          else if (toggle === 'i') options.ignoreCase = !options.ignoreCase;
          rows = build(lines);
          break;
        }
        default:
          break;
      }
      clamp();
      render();
    }
  } finally {
    terminal.write(options.noAltScreen ? `${moveTo(terminal.rows() - 1, 0)}${CLEAR_LINE}` : ALT_SCREEN_OFF);
    terminal.setRaw(false);
  }
};

const run = async (name: string, args: string[], ctx: CommandContext): Promise<ExecResult> => {
  const options = parseOptions(name, args);
  const { text, errors, title } = await loadContent(ctx, options, name);
  if (!ctx.terminal) return textResult(text, errors, errors ? 1 : 0);
  await page(ctx.terminal, text, title, options);
  return textResult('', errors, errors ? 1 : 0);
};

export const lessCommand: Command = { name: 'less', execute: (args, ctx) => run('less', args, ctx) };
export const moreCommand: Command = { name: 'more', execute: (args, ctx) => run('more', args, ctx) };
