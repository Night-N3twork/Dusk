export const escape = (s: string): string => {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
};

export const unescape = (s: string): string => {
  try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch { return s; }
};

export const stringify = (
  obj: Record<string, unknown> | null | undefined,
  sep = '&',
  eq = '=',
  options?: { encodeURIComponent?: (s: string) => string },
): string => {
  if (!obj || typeof obj !== 'object') return '';
  const enc = options?.encodeURIComponent ?? escape;
  const parts: string[] = [];
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const k = enc(key);
    if (Array.isArray(value)) {
      for (const v of value) parts.push(k + eq + enc(stringifyPrimitive(v)));
    } else {
      parts.push(k + eq + enc(stringifyPrimitive(value)));
    }
  }
  return parts.join(sep);
};

const stringifyPrimitive = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' && isFinite(v)) return String(v);
  return '';
};

export const parse = (
  s: string,
  sep = '&',
  eq = '=',
  options?: { maxKeys?: number; decodeURIComponent?: (s: string) => string },
): Record<string, string | string[]> => {
  const out: Record<string, string | string[]> = Object.create(null);
  if (typeof s !== 'string' || s.length === 0) return out;
  const dec = options?.decodeURIComponent ?? unescape;
  const max = options?.maxKeys ?? 1000;
  const parts = s.split(sep);
  for (let i = 0; i < parts.length && i < max; i++) {
    const p = parts[i]!;
    if (!p) continue;
    const eqIdx = p.indexOf(eq);
    let k: string, v: string;
    if (eqIdx < 0) { k = dec(p); v = ''; }
    else { k = dec(p.slice(0, eqIdx)); v = dec(p.slice(eqIdx + 1)); }
    const existing = out[k];
    if (existing === undefined) out[k] = v;
    else if (Array.isArray(existing)) existing.push(v);
    else out[k] = [existing, v];
  }
  return out;
};

export const decode = parse;
export const encode = stringify;

export const nodeQuerystring = {
  escape,
  unescape,
  stringify,
  parse,
  decode,
  encode,
};
