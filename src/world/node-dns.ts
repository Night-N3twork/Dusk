declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

type DnsCallback<T> = (err: (Error & { code?: string }) | null, value?: T) => void;

interface LookupAddress { address: string; family: number }
interface LookupOptions { family?: number | string; all?: boolean; hints?: number; verbatim?: boolean; order?: string }

const ERROR_CODES = [
  'NODATA', 'FORMERR', 'SERVFAIL', 'NOTFOUND', 'NOTIMP', 'REFUSED', 'BADQUERY', 'BADNAME', 'BADFAMILY',
  'BADRESP', 'CONNREFUSED', 'TIMEOUT', 'EOF', 'FILE', 'NOMEM', 'DESTRUCTION', 'BADSTR', 'BADFLAGS',
  'NONAME', 'BADHINTS', 'NOTINITIALIZED', 'LOADIPHLPAPI', 'ADDRGETNETWORKPARAMS', 'CANCELLED',
] as const;

const dnsError = (raw: string, syscall: string, hostname: string): Error & { code?: string } => {
  const match = /^([A-Z_]+):/.exec(raw);
  const head = match ? match[1]! : 'ESERVFAIL';
  const code = head.startsWith('E') ? head : 'E' + head;
  if (code.startsWith('ERR_')) {
    const error = new TypeError(raw.slice(raw.indexOf(':') + 1).trim()) as TypeError & { code?: string };
    error.code = code;
    return error;
  }
  const normalized = code === 'ENOTFOUND' || code === 'ENODATA' || code === 'ESERVFAIL' || code === 'ECONNREFUSED' || code === 'ETIMEOUT' ? code : 'ESERVFAIL';
  const error = new Error(`${syscall} ${normalized} ${hostname}`) as Error & Record<string, unknown>;
  error['code'] = normalized;
  error['errno'] = undefined;
  error['syscall'] = syscall;
  error['hostname'] = hostname;
  return error;
};

const call = (f: string, extra: Record<string, unknown>, syscall: string, hostname: string): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) throw dnsError(r.error, syscall, hostname);
  return r.value;
};

const later = (fn: () => void): void => { Promise.resolve().then(fn); };

const familyOf = (family: number | string | undefined): 0 | 4 | 6 => {
  if (family === 4 || family === 'IPv4') return 4;
  if (family === 6 || family === 'IPv6') return 6;
  if (family === undefined || family === 0 || family === null) return 0;
  const error = new TypeError(`The property 'options.family' must be one of: 0, 4, 6. Received ${String(family)}`) as TypeError & { code?: string };
  error.code = 'ERR_INVALID_ARG_VALUE';
  throw error;
};

let resultOrder: 'verbatim' | 'ipv4first' | 'ipv6first' = 'verbatim';

const lookupSync = (hostname: string, options: LookupOptions): LookupAddress[] => {
  const family = familyOf(options.family);
  const records = call('dns.lookup', { hostname, family }, 'getaddrinfo', hostname) as LookupAddress[];
  const order = options.order ?? (options.verbatim === false ? 'ipv4first' : resultOrder);
  if (order === 'ipv4first') return [...records].sort((a, b) => a.family - b.family);
  if (order === 'ipv6first') return [...records].sort((a, b) => b.family - a.family);
  return records;
};

export function lookup(hostname: string, options: LookupOptions | number | DnsCallback<string>, callback?: (...args: unknown[]) => void): void {
  let opts: LookupOptions = {};
  let cb = callback;
  if (typeof options === 'function') cb = options as (...args: unknown[]) => void;
  else if (typeof options === 'number') opts = { family: options };
  else if (options && typeof options === 'object') opts = options;
  if (typeof cb !== 'function') {
    const error = new TypeError('The "callback" argument must be of type function') as TypeError & { code?: string };
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
  }
  const done = cb;
  if (!hostname) {
    later(() => (opts.all ? done(null, []) : done(null, null, opts.family === 6 ? 6 : 4)));
    return;
  }
  let records: LookupAddress[];
  try { records = lookupSync(hostname, opts); }
  catch (e) { later(() => done(e)); return; }
  if (opts.all) later(() => done(null, records));
  else later(() => done(null, records[0]!.address, records[0]!.family));
}

export const lookupService = (address: string, port: number, callback: (err: Error | null, hostname?: string, service?: string) => void): void => {
  later(() => {
    if (address === '127.0.0.1' || address === '::1') callback(null, 'localhost', String(port));
    else callback(dnsError('ENOTFOUND:', 'getnameinfo', address));
  });
};

const resolveSync = (hostname: string, rrtype: string, ttl = false): unknown[] => {
  const syscall = 'query' + rrtype.charAt(0) + rrtype.slice(1).toLowerCase();
  return call('dns.resolve', { hostname, rrtype, ttl }, syscall, hostname) as unknown[];
};

const resolver = (rrtype: string) => (hostname: string, optionsOrCb: unknown, maybeCb?: DnsCallback<unknown[]>): void => {
  const cb = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb) as DnsCallback<unknown[]>;
  const ttl = typeof optionsOrCb === 'object' && optionsOrCb !== null && Boolean((optionsOrCb as { ttl?: boolean }).ttl);
  let value: unknown[];
  try { value = resolveSync(hostname, rrtype, ttl); }
  catch (e) { later(() => cb(e as Error)); return; }
  later(() => cb(null, value));
};

export const resolve4 = resolver('A');
export const resolve6 = resolver('AAAA');
export const resolveCname = resolver('CNAME');
export const resolveMx = resolver('MX');
export const resolveNs = resolver('NS');
export const resolvePtr = resolver('PTR');
export const resolveSoa = (hostname: string, cb: DnsCallback<unknown>): void => {
  resolver('SOA')(hostname, (err: Error | null, records?: unknown[]) => cb(err as Error & { code?: string } | null, records?.[0]));
};
export const resolveSrv = resolver('SRV');
export const resolveTxt = resolver('TXT');
export const resolveCaa = resolver('CAA');

export const resolveAny = (hostname: string, cb: DnsCallback<unknown[]>): void => {
  const out: unknown[] = [];
  for (const type of ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SRV', 'SOA', 'CAA']) {
    try {
      for (const value of resolveSync(hostname, type)) {
        if (type === 'TXT') out.push({ type, entries: value });
        else if (typeof value === 'string') out.push(type === 'A' || type === 'AAAA' ? { type, address: value, ttl: 0 } : { type, value });
        else out.push({ type, ...(value as object) });
      }
    } catch { }
  }
  later(() => (out.length > 0 ? cb(null, out) : cb(dnsError('ENODATA:', 'queryAny', hostname))));
};

export const resolve = (hostname: string, rrtypeOrCb: unknown, maybeCb?: DnsCallback<unknown>): void => {
  const rrtype = typeof rrtypeOrCb === 'string' ? rrtypeOrCb.toUpperCase() : 'A';
  const cb = (typeof rrtypeOrCb === 'function' ? rrtypeOrCb : maybeCb) as DnsCallback<unknown>;
  if (typeof cb !== 'function') throw new TypeError('callback required');
  if (rrtype === 'ANY') { resolveAny(hostname, cb as DnsCallback<unknown[]>); return; }
  if (rrtype === 'SOA') { resolveSoa(hostname, cb); return; }
  resolver(rrtype)(hostname, cb);
};

export const reverse = (ip: string, cb: DnsCallback<string[]>): void => {
  if (ip === '127.0.0.1' || ip === '::1') { later(() => cb(null, ['localhost'])); return; }
  resolver('PTR')(ip, cb as DnsCallback<unknown[]>);
};

let servers: string[] = ['1.1.1.1'];
export const setServers = (list: string[]): void => { servers = [...list]; };
export const getServers = (): string[] => [...servers];
export const setDefaultResultOrder = (order: 'verbatim' | 'ipv4first' | 'ipv6first'): void => { resultOrder = order; };
export const getDefaultResultOrder = (): string => resultOrder;

const promisify = <T>(fn: (...args: any[]) => void) => (...args: unknown[]): Promise<T> =>
  new Promise<T>((resolvePromise, reject) => fn(...args, (err: Error | null, value: T) => (err ? reject(err) : resolvePromise(value))));

class Resolver {
  private list: string[] = getServers();
  cancel(): void { }
  setServers(list: string[]): void { this.list = [...list]; }
  getServers(): string[] { return [...this.list]; }
  setLocalAddress(): void { }
  resolve = resolve;
  resolve4 = resolve4;
  resolve6 = resolve6;
  resolveAny = resolveAny;
  resolveCaa = resolveCaa;
  resolveCname = resolveCname;
  resolveMx = resolveMx;
  resolveNs = resolveNs;
  resolvePtr = resolvePtr;
  resolveSoa = resolveSoa;
  resolveSrv = resolveSrv;
  resolveTxt = resolveTxt;
  reverse = reverse;
}

class PromiseResolver {
  private inner = new Resolver();
  cancel(): void { }
  setServers(list: string[]): void { this.inner.setServers(list); }
  getServers(): string[] { return this.inner.getServers(); }
  setLocalAddress(): void { }
  resolve = (hostname: string, rrtype?: string) => promisify<unknown>(resolve)(hostname, rrtype ?? 'A');
  resolve4 = (hostname: string, options?: { ttl?: boolean }) => promisify<unknown[]>(resolve4)(hostname, options ?? {});
  resolve6 = (hostname: string, options?: { ttl?: boolean }) => promisify<unknown[]>(resolve6)(hostname, options ?? {});
  resolveAny = promisify<unknown[]>(resolveAny);
  resolveCaa = (hostname: string) => promisify<unknown[]>(resolveCaa)(hostname, {});
  resolveCname = (hostname: string) => promisify<unknown[]>(resolveCname)(hostname, {});
  resolveMx = (hostname: string) => promisify<unknown[]>(resolveMx)(hostname, {});
  resolveNs = (hostname: string) => promisify<unknown[]>(resolveNs)(hostname, {});
  resolvePtr = (hostname: string) => promisify<unknown[]>(resolvePtr)(hostname, {});
  resolveSoa = promisify<unknown>(resolveSoa);
  resolveSrv = (hostname: string) => promisify<unknown[]>(resolveSrv)(hostname, {});
  resolveTxt = (hostname: string) => promisify<unknown[]>(resolveTxt)(hostname, {});
  reverse = promisify<string[]>(reverse);
}

const defaultPromiseResolver = new PromiseResolver();

const promises = {
  lookup: (hostname: string, options?: LookupOptions | number): Promise<LookupAddress | LookupAddress[]> =>
    new Promise((resolvePromise, reject) => {
      const opts: LookupOptions = typeof options === 'number' ? { family: options } : (options ?? {});
      lookup(hostname, opts, (err: unknown, address: unknown, family: unknown) => {
        if (err) reject(err);
        else resolvePromise(opts.all ? address as LookupAddress[] : { address: address as string, family: family as number });
      });
    }),
  lookupService: (address: string, port: number): Promise<{ hostname: string; service: string }> =>
    new Promise((resolvePromise, reject) => {
      lookupService(address, port, (err, hostname, service) => (err ? reject(err) : resolvePromise({ hostname: hostname!, service: service! })));
    }),
  resolve: defaultPromiseResolver.resolve,
  resolve4: defaultPromiseResolver.resolve4,
  resolve6: defaultPromiseResolver.resolve6,
  resolveAny: defaultPromiseResolver.resolveAny,
  resolveCaa: defaultPromiseResolver.resolveCaa,
  resolveCname: defaultPromiseResolver.resolveCname,
  resolveMx: defaultPromiseResolver.resolveMx,
  resolveNs: defaultPromiseResolver.resolveNs,
  resolvePtr: defaultPromiseResolver.resolvePtr,
  resolveSoa: defaultPromiseResolver.resolveSoa,
  resolveSrv: defaultPromiseResolver.resolveSrv,
  resolveTxt: defaultPromiseResolver.resolveTxt,
  reverse: defaultPromiseResolver.reverse,
  setServers,
  getServers,
  setDefaultResultOrder,
  getDefaultResultOrder,
  Resolver: PromiseResolver,
};

const constants: Record<string, string | number> = { ADDRCONFIG: 1024, V4MAPPED: 2048, ALL: 256 };
for (const code of ERROR_CODES) constants[code] = 'E' + code;

export const nodeDns = {
  lookup,
  lookupService,
  resolve,
  resolve4,
  resolve6,
  resolveAny,
  resolveCaa,
  resolveCname,
  resolveMx,
  resolveNs,
  resolvePtr,
  resolveSoa,
  resolveSrv,
  resolveTxt,
  reverse,
  setServers,
  getServers,
  setDefaultResultOrder,
  getDefaultResultOrder,
  Resolver,
  promises,
  ...constants,
};
