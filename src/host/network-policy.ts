export interface NetworkTarget {
  protocol: string;
  host: string;
  port: number;
}

export type NetworkPolicy = (target: NetworkTarget) => boolean;

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 };

export const targetFromUrl = (url: string): NetworkTarget => {
  const parsed = new URL(url);
  const port = parsed.port ? Number(parsed.port) : DEFAULT_PORTS[parsed.protocol] ?? 0;
  return { protocol: parsed.protocol, host: parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port };
};

interface Rule {
  protocol?: string;
  host: string;
  port?: number;
}

const parseRule = (entry: string): Rule => {
  let rest = entry.trim().toLowerCase();
  let protocol: string | undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(rest);
  if (scheme) {
    protocol = scheme[1] + ':';
    rest = rest.slice(scheme[0].length);
  }
  rest = rest.replace(/\/.*$/, '');
  let port: number | undefined;
  const bracketed = /^\[([^\]]+)\](?::(\d+|\*))?$/.exec(rest);
  if (bracketed) {
    if (bracketed[2] && bracketed[2] !== '*') port = Number(bracketed[2]);
    return { ...(protocol ? { protocol } : {}), host: bracketed[1]!, ...(port !== undefined ? { port } : {}) };
  }
  const colon = rest.lastIndexOf(':');
  if (colon !== -1 && rest.indexOf(':') === colon) {
    const portText = rest.slice(colon + 1);
    if (portText !== '*') port = Number(portText);
    rest = rest.slice(0, colon);
  }
  return { ...(protocol ? { protocol } : {}), host: rest, ...(port !== undefined ? { port } : {}) };
};

const hostMatches = (pattern: string, host: string): boolean => {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return pattern === host;
};

export const createAllowList = (entries: readonly string[]): NetworkPolicy => {
  const rules = entries.map(parseRule);
  return (target) => rules.some((rule) =>
    hostMatches(rule.host, target.host.toLowerCase())
    && (rule.port === undefined || rule.port === target.port)
    && (rule.protocol === undefined || rule.protocol === target.protocol));
};

export const toNetworkPolicy = (allow: NetworkPolicy | readonly string[] | undefined): NetworkPolicy | undefined => {
  if (allow === undefined) return undefined;
  return typeof allow === 'function' ? allow : createAllowList(allow);
};

export class NetworkPolicyError extends Error {
  readonly code = 'ERR_DUSK_NETWORK_BLOCKED';

  constructor(target: NetworkTarget) {
    super(`ERR_DUSK_NETWORK_BLOCKED: network policy blocked ${target.protocol}//${target.host}${target.port ? ':' + target.port : ''}`);
  }
}

export const assertAllowed = (policy: NetworkPolicy | undefined, target: NetworkTarget): void => {
  if (policy && !policy(target)) throw new NetworkPolicyError(target);
};

export const assertUrlAllowed = (policy: NetworkPolicy | undefined, url: string): void => {
  if (!policy) return;
  let target: NetworkTarget;
  try { target = targetFromUrl(url); } catch { throw new NetworkPolicyError({ protocol: 'invalid:', host: url, port: 0 }); }
  assertAllowed(policy, target);
};
