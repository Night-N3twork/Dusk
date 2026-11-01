import type { FuncTable } from './engine-instance';

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'NS' | 'PTR' | 'SOA' | 'SRV' | 'TXT' | 'CAA';

export interface DnsAnswer {
  type: DnsRecordType;
  data: string;
  ttl: number;
}

export interface DnsResolver {
  query(name: string, type: DnsRecordType): Promise<DnsAnswer[]>;
}

export interface DnsAddress {
  address: string;
  family: 4 | 6;
}

const TYPE_CODES: Record<number, DnsRecordType> = {
  1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 12: 'PTR', 15: 'MX', 16: 'TXT', 28: 'AAAA', 33: 'SRV', 257: 'CAA',
};

const RECORD_TYPES = new Set<string>(Object.values(TYPE_CODES));

export class DnsError extends Error {
  constructor(readonly code: string, readonly syscall: string, readonly hostname: string) {
    super(`${code}: ${syscall} ${code} ${hostname}`);
  }
}

export const ipFamily = (input: string): 0 | 4 | 6 => {
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(input)) return 4;
  if (input.includes(':') && /^[0-9a-fA-F:.]+(%[\w.]+)?$/.test(input)) {
    const parts = input.split('%')[0]!.split('::');
    if (parts.length <= 2) return 6;
  }
  return 0;
};

export const createDohResolver = (
  endpoint = 'https://cloudflare-dns.com/dns-query',
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): DnsResolver => ({
  async query(name, type) {
    const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}name=${encodeURIComponent(name)}&type=${type}`;
    let response: Response;
    try {
      response = await fetchImpl(url, { headers: { accept: 'application/dns-json' } });
    } catch {
      throw new DnsError('ECONNREFUSED', 'query', name);
    }
    if (!response.ok) throw new DnsError('ESERVFAIL', 'query', name);
    const body = await response.json() as { Status?: number; Answer?: Array<{ type: number; data: string; TTL?: number }> };
    if (body.Status === 3) throw new DnsError('ENOTFOUND', 'query', name);
    if (body.Status !== undefined && body.Status !== 0) throw new DnsError('ESERVFAIL', 'query', name);
    const answers: DnsAnswer[] = [];
    for (const answer of body.Answer ?? []) {
      const answerType = TYPE_CODES[answer.type];
      if (answerType === type) answers.push({ type: answerType, data: answer.data, ttl: answer.TTL ?? 0 });
    }
    return answers;
  },
});

const stripDot = (name: string): string => (name.endsWith('.') && name.length > 1 ? name.slice(0, -1) : name);

const parseTxt = (data: string): string[] => {
  const chunks: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(data)) !== null) chunks.push(match[1]!.replace(/\\(.)/g, '$1'));
  return chunks.length > 0 ? chunks : [data];
};

export const formatDnsAnswer = (type: DnsRecordType, data: string): unknown => {
  switch (type) {
    case 'A':
    case 'AAAA':
      return data;
    case 'CNAME':
    case 'NS':
    case 'PTR':
      return stripDot(data);
    case 'MX': {
      const [priority, exchange] = data.split(/\s+/);
      return { priority: Number(priority), exchange: stripDot(exchange ?? '') };
    }
    case 'SRV': {
      const [priority, weight, port, name] = data.split(/\s+/);
      return { priority: Number(priority), weight: Number(weight), port: Number(port), name: stripDot(name ?? '') };
    }
    case 'TXT':
      return parseTxt(data);
    case 'SOA': {
      const [nsname, hostmaster, serial, refresh, retry, expire, minttl] = data.split(/\s+/);
      return {
        nsname: stripDot(nsname ?? ''), hostmaster: stripDot(hostmaster ?? ''),
        serial: Number(serial), refresh: Number(refresh), retry: Number(retry), expire: Number(expire), minttl: Number(minttl),
      };
    }
    case 'CAA': {
      const match = /^(\d+)\s+(\S+)\s+"?(.*?)"?$/.exec(data);
      if (!match) return { critical: 0, issue: data };
      return { critical: Number(match[1]), [match[2]!]: match[3] };
    }
  }
};

export const reverseName = (ip: string): string => {
  if (ipFamily(ip) === 4) return `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
  const [head = '', tail = ''] = ip.split('%')[0]!.split('::');
  const expand = (part: string): string[] => (part ? part.split(':') : []);
  const left = expand(head);
  const right = expand(tail);
  const groups = [...left, ...new Array(8 - left.length - right.length).fill('0'), ...right];
  return `${groups.map((group) => group.padStart(4, '0')).join('').split('').reverse().join('.')}.ip6.arpa`;
};

export interface DnsHostOptions {
  resolver?: DnsResolver;
  isLocalHost?: (hostname: string) => boolean;
}

const LOCALHOST = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

export const lookupHost = async (hostname: string, family: 0 | 4 | 6, options: DnsHostOptions): Promise<DnsAddress[]> => {
  const literal = ipFamily(hostname);
  if (literal !== 0) {
    if (family !== 0 && family !== literal) throw new DnsError('ENOTFOUND', 'getaddrinfo', hostname);
    return [{ address: hostname, family: literal }];
  }
  const lower = hostname.toLowerCase();
  if (LOCALHOST.has(lower) || lower.endsWith('.localhost') || options.isLocalHost?.(lower)) {
    if (family === 6) return [{ address: '::1', family: 6 }];
    if (family === 4) return [{ address: '127.0.0.1', family: 4 }];
    return [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }];
  }
  if (!options.resolver) throw new DnsError('ENOTFOUND', 'getaddrinfo', hostname);
  const results: DnsAddress[] = [];
  const types: Array<'A' | 'AAAA'> = family === 4 ? ['A'] : family === 6 ? ['AAAA'] : ['A', 'AAAA'];
  const settled = await Promise.allSettled(types.map((type) => options.resolver!.query(lower, type)));
  let failure: unknown;
  for (const outcome of settled) {
    if (outcome.status === 'rejected') { failure = outcome.reason; continue; }
    for (const answer of outcome.value) results.push({ address: answer.data, family: answer.type === 'AAAA' ? 6 : 4 });
  }
  if (results.length === 0) {
    if (failure instanceof DnsError && failure.code !== 'ENOTFOUND') throw new DnsError(failure.code, 'getaddrinfo', hostname);
    throw new DnsError('ENOTFOUND', 'getaddrinfo', hostname);
  }
  return results;
};

const errorPayload = (e: unknown, syscall: string, hostname: string): { error: string } => {
  if (e instanceof DnsError) return { error: `${e.code}: ${syscall} ${e.code} ${hostname}` };
  return { error: `ESERVFAIL: ${syscall} ESERVFAIL ${hostname}` };
};

export const createDnsFuncs = (options: DnsHostOptions): FuncTable => ({
  'dns.lookup': (m, send) => {
    const hostname = String(m['hostname'] ?? '');
    const requested = Number(m['family'] ?? 0);
    const family = (requested === 4 || requested === 6 ? requested : 0) as 0 | 4 | 6;
    void lookupHost(hostname, family, options).then(
      (records) => send({ value: records }),
      (e) => send(errorPayload(e, 'getaddrinfo', hostname)),
    );
  },
  'dns.resolve': (m, send) => {
    const hostname = String(m['hostname'] ?? '');
    const rrtype = String(m['rrtype'] ?? 'A').toUpperCase();
    const ttl = Boolean(m['ttl']);
    if (!RECORD_TYPES.has(rrtype)) {
      send({ error: `ERR_INVALID_ARG_VALUE: unsupported rrtype ${rrtype}` });
      return;
    }
    const type = rrtype as DnsRecordType;
    if ((type === 'A' || type === 'AAAA') && (LOCALHOST.has(hostname.toLowerCase()) || ipFamily(hostname) !== 0)) {
      void lookupHost(hostname, type === 'A' ? 4 : 6, options).then(
        (records) => send({ value: records.map((r) => (ttl ? { address: r.address, ttl: 0 } : r.address)) }),
        (e) => send(errorPayload(e, type === 'A' ? 'queryA' : 'queryAaaa', hostname)),
      );
      return;
    }
    if (!options.resolver) {
      send(errorPayload(new DnsError('ENOTFOUND', 'query', hostname), `query${type[0]}${type.slice(1).toLowerCase()}`, hostname));
      return;
    }
    void options.resolver.query(type === 'PTR' && ipFamily(hostname) !== 0 ? reverseName(hostname) : hostname, type).then(
      (answers) => {
        if (answers.length === 0) {
          send(errorPayload(new DnsError('ENODATA', 'query', hostname), `query${type[0]}${type.slice(1).toLowerCase()}`, hostname));
          return;
        }
        send({
          value: answers.map((answer) => (ttl && (type === 'A' || type === 'AAAA')
            ? { address: answer.data, ttl: answer.ttl }
            : formatDnsAnswer(type, answer.data))),
        });
      },
      (e) => send(errorPayload(e, `query${type[0]}${type.slice(1).toLowerCase()}`, hostname)),
    );
  },
});
