// In-host socket registry for node:net loopback.
//
// When in-engine code calls `net.createServer(...).listen(port)` the server
// is registered here. When code calls `net.createConnection({host, port})`
// pointing at a host:port that has a registered listener IN THE SAME HOST,
// the connection is paired in-process — no external transport involved.
//
// This unblocks `http.createServer().listen()` + `http.request()` round-trips
// within a single DuskJS instance, which is what most test scenarios need.
// Real outbound TCP is deferred (needs libcurl raw-TCP mode).

export interface RegisteredServer {
  id: number;
  host: string;
  port: number;
  enginePid: number;
  // Called when a new client connection wants to attach.
  // Returns the server-side stream pair.
  onConnection: (clientSocketId: number) => void;
}

export interface SocketPair {
  // host -> client (data flowing toward the connector)
  pushToClient: (chunk: Uint8Array) => void;
  closeClient: () => void;
  // server -> client error
  errorClient: (msg: string) => void;
}

export interface SocketRegistry {
  registerServer(host: string, port: number, enginePid: number, onConn: (clientSocketId: number) => void): RegisteredServer;
  unregisterServer(id: number): void;
  findServer(host: string, port: number): RegisteredServer | undefined;
  hasHost(host: string): boolean;
  allocateSocketId(): number;
  // Per-socket pair channels
  setPair(socketId: number, pair: SocketPair): void;
  getPair(socketId: number): SocketPair | undefined;
  removePair(socketId: number): void;
}

export const createSocketRegistry = (): SocketRegistry => {
  const ephemeralStart = 49_152;
  const ephemeralEnd = 65_535;
  let nextServerId = 1;
  let nextSocketId = 1;
  let nextEphemeralPort = ephemeralStart;
  const servers = new Map<string, RegisteredServer>();
  const pairs = new Map<number, SocketPair>();

  const keyOf = (host: string, port: number): string => `${host}:${port}`;

  return {
    registerServer(host, port, enginePid, onConn) {
      if (port === 0) {
        const candidateCount = ephemeralEnd - ephemeralStart + 1;
        for (let i = 0; i < candidateCount; i++) {
          const candidate = nextEphemeralPort;
          nextEphemeralPort = candidate === ephemeralEnd ? ephemeralStart : candidate + 1;
          if (!servers.has(keyOf(host, candidate))) {
            port = candidate;
            break;
          }
        }
        if (port === 0) {
          const error = new Error(`EADDRINUSE: no ephemeral ports available for ${host}`);
          (error as Error & { code?: string }).code = 'EADDRINUSE';
          throw error;
        }
      }
      if (servers.has(keyOf(host, port))) {
        const error = new Error(`EADDRINUSE: address already in use ${host}:${port}`);
        (error as Error & { code?: string }).code = 'EADDRINUSE';
        throw error;
      }
      const id = nextServerId++;
      const server = { id, host, port, enginePid, onConnection: onConn };
      servers.set(keyOf(host, port), server);
      return server;
    },
    unregisterServer(id) {
      for (const [k, v] of servers) if (v.id === id) servers.delete(k);
    },
    findServer(host, port) {
      const direct = servers.get(keyOf(host, port));
      if (direct) return direct;
      // Allow 127.0.0.1 ↔ localhost ↔ 0.0.0.0 aliasing
      if (host === '127.0.0.1' || host === 'localhost') {
        const loopback = servers.get(keyOf('0.0.0.0', port)) ?? servers.get(keyOf('localhost', port)) ?? servers.get(keyOf('127.0.0.1', port));
        if (loopback) return loopback;
        let match: RegisteredServer | undefined;
        for (const server of servers.values()) {
          if (server.port !== port) continue;
          if (match) return undefined;
          match = server;
        }
        return match;
      }
      return undefined;
    },
    hasHost(host) {
      const lower = host.toLowerCase();
      for (const server of servers.values()) if (server.host.toLowerCase() === lower) return true;
      return false;
    },
    allocateSocketId() {
      return nextSocketId++;
    },
    setPair(socketId, pair) { pairs.set(socketId, pair); },
    getPair(socketId) { return pairs.get(socketId); },
    removePair(socketId) { pairs.delete(socketId); },
  };
};
