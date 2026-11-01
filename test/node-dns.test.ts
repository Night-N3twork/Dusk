import { test, expect } from 'vitest';
import { bootRepl, type DnsResolver } from '../src/index';
import { createDohResolver, lookupHost, reverseName, formatDnsAnswer } from '../src/host/dns';

const fakeResolver: DnsResolver = {
  async query(name, type) {
    if (name !== 'example.test') return [];
    if (type === 'A') return [{ type, data: '93.184.216.34', ttl: 60 }];
    if (type === 'AAAA') return [{ type, data: '2606:2800:220:1:248:1893:25c8:1946', ttl: 60 }];
    if (type === 'MX') return [{ type, data: '10 mail.example.test.', ttl: 60 }];
    if (type === 'TXT') return [{ type, data: '"v=spf1" "-all"', ttl: 60 }];
    return [];
  },
};

test('lookupHost answers literals and localhost without a resolver', async () => {
  expect(await lookupHost('10.0.0.1', 0, {})).toEqual([{ address: '10.0.0.1', family: 4 }]);
  expect(await lookupHost('::1', 0, {})).toEqual([{ address: '::1', family: 6 }]);
  expect(await lookupHost('localhost', 4, {})).toEqual([{ address: '127.0.0.1', family: 4 }]);
  await expect(lookupHost('example.com', 0, {})).rejects.toMatchObject({ code: 'ENOTFOUND' });
});

test('lookupHost treats hosts with in-runtime listeners as loopback', async () => {
  expect(await lookupHost('dusk.local', 4, { isLocalHost: (h) => h === 'dusk.local' })).toEqual([{ address: '127.0.0.1', family: 4 }]);
});

test('DNS answer formatting and reverse names follow node:dns shapes', () => {
  expect(formatDnsAnswer('MX', '10 mail.example.com.')).toEqual({ priority: 10, exchange: 'mail.example.com' });
  expect(formatDnsAnswer('TXT', '"a b" "c"')).toEqual(['a b', 'c']);
  expect(formatDnsAnswer('SRV', '1 2 443 svc.example.com.')).toEqual({ priority: 1, weight: 2, port: 443, name: 'svc.example.com' });
  expect(reverseName('1.2.3.4')).toBe('4.3.2.1.in-addr.arpa');
  expect(reverseName('::1')).toBe('1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.ip6.arpa');
});

test('createDohResolver parses dns-json answers and maps NXDOMAIN', async () => {
  const calls: string[] = [];
  const resolver = createDohResolver('https://doh.test/dns-query', async (input) => {
    calls.push(String(input));
    if (String(input).includes('missing')) return new Response(JSON.stringify({ Status: 3 }), { status: 200 });
    return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 5, data: 'alias.', TTL: 1 }, { type: 1, data: '1.2.3.4', TTL: 30 }] }), { status: 200 });
  });
  expect(await resolver.query('host.test', 'A')).toEqual([{ type: 'A', data: '1.2.3.4', ttl: 30 }]);
  expect(calls[0]).toBe('https://doh.test/dns-query?name=host.test&type=A');
  await expect(resolver.query('missing.test', 'A')).rejects.toMatchObject({ code: 'ENOTFOUND' });
});

test('node:dns lookup reports ENOTFOUND instead of echoing the hostname', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const dns = require('node:dns'); " +
    "dns.lookup('example.invalid', (err, address) => { process.stdout.write('D:' + (err && err.code) + '|' + (err && err.syscall) + '|' + String(address) + ':END'); });"
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  repl.engine.terminate();
  expect(out.join('')).toContain('D:ENOTFOUND|getaddrinfo|undefined:END');
}, 60_000);

test('node:dns uses the configured resolver for lookup and resolve*', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), {
    fs: 'memory',
    net: { tcpProvider: { open: async () => { throw new Error('unused'); } } as never, dns: fakeResolver },
  });
  await repl.feed(
    "const dns = require('node:dns'); (async () => { " +
    "const all = await dns.promises.lookup('example.test', { all: true }); " +
    "const v4 = await dns.promises.lookup('example.test', 4); " +
    "const mx = await dns.promises.resolveMx('example.test'); " +
    "const txt = await dns.promises.resolveTxt('example.test'); " +
    "process.stdout.write('R:' + all.length + '|' + v4.address + '|' + mx[0].exchange + '|' + JSON.stringify(txt) + ':END'); })();"
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  repl.engine.terminate();
  expect(out.join('')).toContain('R:2|93.184.216.34|mail.example.test|[["v=spf1","-all"]]:END');
}, 60_000);
