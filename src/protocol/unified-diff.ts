export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
  oldNoNewline: boolean;
  newNoNewline: boolean;
}

export interface FilePatch {
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
}

export interface HunkResult {
  index: number;
  applied: boolean;
  offset: number;
}

export interface ApplyResult {
  text: string;
  hunks: HunkResult[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const headerPath = (line: string): string => {
  const raw = line.slice(4).split('\t')[0]!.trim();
  return raw.startsWith('"') && raw.endsWith('"') ? JSON.parse(raw) as string : raw;
};

export const parsePatch = (text: string): FilePatch[] => {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const patches: FilePatch[] = [];
  let current: FilePatch | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '');
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      current = { oldPath: headerPath(line), newPath: headerPath(lines[i + 1]!.replace(/\r$/, '')), hunks: [] };
      patches.push(current);
      i++;
      continue;
    }
    const match = HUNK_HEADER.exec(line);
    if (!match || !current) continue;
    const hunk: Hunk = {
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
      lines: [],
      oldNoNewline: false,
      newNoNewline: false,
    };
    let oldSeen = 0;
    let newSeen = 0;
    while (i + 1 < lines.length && (oldSeen < hunk.oldLines || newSeen < hunk.newLines || lines[i + 1]!.startsWith('\\'))) {
      const body = lines[++i]!.replace(/\r$/, '');
      if (body.startsWith('\\')) {
        const previous = hunk.lines[hunk.lines.length - 1];
        if (previous?.startsWith('-')) hunk.oldNoNewline = true;
        else if (previous?.startsWith('+')) hunk.newNoNewline = true;
        else {
          hunk.oldNoNewline = true;
          hunk.newNoNewline = true;
        }
        continue;
      }
      const marker = body === '' ? ' ' : body[0];
      if (marker !== ' ' && marker !== '-' && marker !== '+') {
        i--;
        break;
      }
      hunk.lines.push(body === '' ? ' ' : body);
      if (marker !== '+') oldSeen++;
      if (marker !== '-') newSeen++;
    }
    current.hunks.push(hunk);
  }
  return patches;
};

export const reverseHunk = (hunk: Hunk): Hunk => ({
  oldStart: hunk.newStart,
  oldLines: hunk.newLines,
  newStart: hunk.oldStart,
  newLines: hunk.oldLines,
  lines: hunk.lines.map((line) => (line[0] === '+' ? '-' + line.slice(1) : line[0] === '-' ? '+' + line.slice(1) : line)),
  oldNoNewline: hunk.newNoNewline,
  newNoNewline: hunk.oldNoNewline,
});

const matchesAt = (source: string[], expected: string[], at: number): boolean => {
  if (at < 0 || at + expected.length > source.length) return false;
  for (let i = 0; i < expected.length; i++) if (source[at + i] !== expected[i]) return false;
  return true;
};

export const applyHunks = (original: string, hunks: Hunk[]): ApplyResult => {
  const endsWithNewline = original.length === 0 || original.endsWith('\n');
  const source = original.length === 0 ? [] : (endsWithNewline ? original.slice(0, -1) : original).split('\n');
  let trailingNewline = endsWithNewline;
  const results: HunkResult[] = [];
  let shift = 0;
  let floor = 0;
  hunks.forEach((hunk, index) => {
    const expected = hunk.lines.filter((line) => line[0] !== '+').map((line) => line.slice(1));
    const replacement = hunk.lines.filter((line) => line[0] !== '-').map((line) => line.slice(1));
    const guess = Math.max(0, (hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1) + shift);
    let found = -1;
    for (let distance = 0; distance <= source.length; distance++) {
      if (guess - distance >= floor && matchesAt(source, expected, guess - distance)) { found = guess - distance; break; }
      if (distance > 0 && matchesAt(source, expected, guess + distance)) { found = guess + distance; break; }
      if (guess - distance < floor && guess + distance > source.length) break;
    }
    if (found === -1) {
      results.push({ index: index + 1, applied: false, offset: 0 });
      return;
    }
    const atEnd = found + expected.length === source.length;
    source.splice(found, expected.length, ...replacement);
    if (atEnd) trailingNewline = !hunk.newNoNewline;
    results.push({ index: index + 1, applied: true, offset: found - guess });
    shift += replacement.length - expected.length + (found - guess);
    floor = found + replacement.length;
  });
  const text = source.length === 0 ? '' : source.join('\n') + (trailingNewline ? '\n' : '');
  return { text, hunks: results };
};

export const stripPath = (path: string, strip: number | undefined): string => {
  if (strip === undefined) return path.split('/').pop() ?? path;
  const parts = path.split('/').filter((part, i) => part !== '' || i === 0);
  return parts.slice(strip).join('/');
};

type Edit = { kind: ' ' | '-' | '+'; text: string };

const diffLines = (a: string[], b: string[]): Edit[] => {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  search: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) break search;
    }
  }
  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const state = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && state[offset + k - 1]! < state[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : state[offset + prevK]!;
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      edits.push({ kind: ' ', text: a[x]! });
    }
    if (d > 0) {
      if (x === prevX) edits.push({ kind: '+', text: b[prevY]! });
      else edits.push({ kind: '-', text: a[prevX]! });
    }
    x = prevX;
    y = prevY;
  }
  return edits.reverse();
};

const splitLines = (text: string): { lines: string[]; noNewline: boolean } => {
  if (text === '') return { lines: [], noNewline: false };
  const noNewline = !text.endsWith('\n');
  return { lines: (noNewline ? text : text.slice(0, -1)).split('\n'), noNewline };
};

export const createUnifiedHunks = (oldText: string, newText: string, context = 3): string => {
  const keys = (text: string): string[] => {
    const { lines, noNewline } = splitLines(text);
    if (noNewline) lines[lines.length - 1] += '\0';
    return lines;
  };
  const edits = diffLines(keys(oldText), keys(newText));
  const changes = edits.map((edit, index) => (edit.kind === ' ' ? -1 : index)).filter((index) => index >= 0);
  if (changes.length === 0) return '';
  const groups: Array<[number, number]> = [];
  for (const index of changes) {
    const last = groups[groups.length - 1];
    if (last && index - last[1] <= context * 2 + 1) last[1] = index;
    else groups.push([index, index]);
  }
  let out = '';
  for (const [first, last] of groups) {
    const start = Math.max(0, first - context);
    const end = Math.min(edits.length - 1, last + context);
    let oldLine = 1;
    let newLine = 1;
    for (let i = 0; i < start; i++) {
      if (edits[i]!.kind !== '+') oldLine++;
      if (edits[i]!.kind !== '-') newLine++;
    }
    let oldCount = 0;
    let newCount = 0;
    let body = '';
    for (let i = start; i <= end; i++) {
      const edit = edits[i]!;
      const missingNewline = edit.text.endsWith('\0');
      body += `${edit.kind}${missingNewline ? edit.text.slice(0, -1) : edit.text}\n`;
      if (missingNewline) body += '\\ No newline at end of file\n';
      if (edit.kind !== '+') oldCount++;
      if (edit.kind !== '-') newCount++;
    }
    const range = (line: number, count: number): string => (count === 1 ? `${line}` : `${count === 0 ? line - 1 : line},${count}`);
    out += `@@ -${range(oldLine, oldCount)} +${range(newLine, newCount)} @@\n${body}`;
  }
  return out;
};
