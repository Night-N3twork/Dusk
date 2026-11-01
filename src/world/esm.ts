import { nodeFs } from './node-fs';
import { nodePath } from './node-path';
import { nodeChildProcess } from './node-child-process';
import { nodeEvents } from './node-events';
import { nodeBuffer } from './node-buffer';
import { nodeProcess } from './node-process';
import { nodeOs } from './node-os';
import { nodeUtil, types } from './node-util';
import { nodeCrypto } from './node-crypto';
import { nodeUrl } from './node-url';
import { nodeQuerystring } from './node-querystring';
import { nodeStringDecoder } from './node-string-decoder';
import { nodeAssert } from './node-assert';
import { nodeTimers, nodeTimersPromises } from './node-timers';
import { nodeAsyncHooks } from './node-async-hooks';
import { nodeStream, nodeStreamPromises } from './node-stream';
import { nodeDns } from './node-dns';
import { nodeNet } from './node-net';
import { nodeTls } from './node-tls';
import { nodeHttp, nodeHttps } from './node-http';
import { nodeZlib } from './node-zlib';
import { nodeConsole } from './node-console';
import { nodePerfHooks } from './node-perf-hooks';
import { nodeTty } from './node-tty';
import { nodeVm } from './node-vm';
import { nodeReadline } from './node-readline';
import { nodeRepl } from './node-repl';
import { nodeCluster } from './node-cluster';
import { nodeWorkerThreads } from './node-worker-threads';
import { nodeModule } from './node-module';
import { nodeDiagnosticsChannel } from './node-diagnostics-channel';
import { nodeV8 } from './node-v8';
import { nodeHttp2 } from './node-http2';
import { nodeDgram } from './node-dgram';
import { nodeSqlite } from './node-sqlite';
import { nodeTest } from './node-test';
import { errnoTable, signalTable, fsConstants, osConstants, priorityConstants, dlopenConstants } from './node-constants';
import { createSystemLoader } from './system-loader';

export const installESM = (): void => {
  const builtinNs = (mod: Record<string, unknown>): Record<string, unknown> => ({ ...mod, default: mod.default ?? mod });
  const nodeConstantsModule = Object.freeze({
    ...errnoTable,
    ...signalTable,
    ...fsConstants,
    ...osConstants,
    ...priorityConstants,
    ...dlopenConstants,
  });
  const builtins: Record<string, Record<string, unknown>> = {
    'node:fs': builtinNs(nodeFs as unknown as Record<string, unknown>),
    'fs': builtinNs(nodeFs as unknown as Record<string, unknown>),
    'node:path': builtinNs(nodePath as unknown as Record<string, unknown>),
    'path': builtinNs(nodePath as unknown as Record<string, unknown>),
    'node:child_process': builtinNs(nodeChildProcess),
    'child_process': builtinNs(nodeChildProcess),
    'node:events': builtinNs(nodeEvents as unknown as Record<string, unknown>),
    'events': builtinNs(nodeEvents as unknown as Record<string, unknown>),
    'node:buffer': builtinNs(nodeBuffer as unknown as Record<string, unknown>),
    'buffer': builtinNs(nodeBuffer as unknown as Record<string, unknown>),
    'node:process': builtinNs(nodeProcess as unknown as Record<string, unknown>),
    'process': builtinNs(nodeProcess as unknown as Record<string, unknown>),
    'node:os': builtinNs(nodeOs as unknown as Record<string, unknown>),
    'os': builtinNs(nodeOs as unknown as Record<string, unknown>),
    'node:util': builtinNs(nodeUtil as unknown as Record<string, unknown>),
    'util': builtinNs(nodeUtil as unknown as Record<string, unknown>),
    'node:crypto': builtinNs(nodeCrypto as unknown as Record<string, unknown>),
    'crypto': builtinNs(nodeCrypto as unknown as Record<string, unknown>),
    'node:url': builtinNs(nodeUrl as unknown as Record<string, unknown>),
    'url': builtinNs(nodeUrl as unknown as Record<string, unknown>),
    'node:querystring': builtinNs(nodeQuerystring as unknown as Record<string, unknown>),
    'querystring': builtinNs(nodeQuerystring as unknown as Record<string, unknown>),
    'node:string_decoder': builtinNs(nodeStringDecoder as unknown as Record<string, unknown>),
    'string_decoder': builtinNs(nodeStringDecoder as unknown as Record<string, unknown>),
    'node:assert': builtinNs(nodeAssert as unknown as Record<string, unknown>),
    'assert': builtinNs(nodeAssert as unknown as Record<string, unknown>),
    'node:assert/strict': builtinNs((nodeAssert as unknown as { strict: Record<string, unknown> }).strict),
    'assert/strict': builtinNs((nodeAssert as unknown as { strict: Record<string, unknown> }).strict),
    'node:timers': builtinNs(nodeTimers as unknown as Record<string, unknown>),
    'timers': builtinNs(nodeTimers as unknown as Record<string, unknown>),
    'node:timers/promises': builtinNs(nodeTimersPromises as unknown as Record<string, unknown>),
    'timers/promises': builtinNs(nodeTimersPromises as unknown as Record<string, unknown>),
    'node:async_hooks': builtinNs(nodeAsyncHooks as unknown as Record<string, unknown>),
    'async_hooks': builtinNs(nodeAsyncHooks as unknown as Record<string, unknown>),
    'node:stream': builtinNs(nodeStream as unknown as Record<string, unknown>),
    'stream': builtinNs(nodeStream as unknown as Record<string, unknown>),
    'node:stream/promises': builtinNs(nodeStreamPromises),
    'stream/promises': builtinNs(nodeStreamPromises),
    'node:dns': builtinNs(nodeDns as unknown as Record<string, unknown>),
    'dns': builtinNs(nodeDns as unknown as Record<string, unknown>),
    'node:net': builtinNs(nodeNet as unknown as Record<string, unknown>),
    'net': builtinNs(nodeNet as unknown as Record<string, unknown>),
    'node:tls': builtinNs(nodeTls),
    'tls': builtinNs(nodeTls),
    'node:http': builtinNs(nodeHttp as unknown as Record<string, unknown>),
    'http': builtinNs(nodeHttp as unknown as Record<string, unknown>),
    'node:https': builtinNs(nodeHttps as unknown as Record<string, unknown>),
    'https': builtinNs(nodeHttps as unknown as Record<string, unknown>),
    'node:zlib': builtinNs(nodeZlib as unknown as Record<string, unknown>),
    'zlib': builtinNs(nodeZlib as unknown as Record<string, unknown>),
    'node:console': builtinNs(nodeConsole as unknown as Record<string, unknown>),
    'console': builtinNs(nodeConsole as unknown as Record<string, unknown>),
    'node:perf_hooks': builtinNs(nodePerfHooks as unknown as Record<string, unknown>),
    'perf_hooks': builtinNs(nodePerfHooks as unknown as Record<string, unknown>),
    'node:tty': builtinNs(nodeTty as unknown as Record<string, unknown>),
    'tty': builtinNs(nodeTty as unknown as Record<string, unknown>),
    'node:vm': builtinNs(nodeVm as unknown as Record<string, unknown>),
    'vm': builtinNs(nodeVm as unknown as Record<string, unknown>),
    'node:readline': builtinNs(nodeReadline as unknown as Record<string, unknown>),
    'readline': builtinNs(nodeReadline as unknown as Record<string, unknown>),
    'node:repl': builtinNs(nodeRepl as unknown as Record<string, unknown>),
    'repl': builtinNs(nodeRepl as unknown as Record<string, unknown>),
    'node:cluster': builtinNs(nodeCluster as unknown as Record<string, unknown>),
    'cluster': builtinNs(nodeCluster as unknown as Record<string, unknown>),
    'node:worker_threads': builtinNs(nodeWorkerThreads as unknown as Record<string, unknown>),
    'worker_threads': builtinNs(nodeWorkerThreads as unknown as Record<string, unknown>),
    'node:module': builtinNs(nodeModule),
    'module': builtinNs(nodeModule),
    'node:diagnostics_channel': builtinNs(nodeDiagnosticsChannel),
    'diagnostics_channel': builtinNs(nodeDiagnosticsChannel),
    'node:v8': builtinNs(nodeV8),
    'v8': builtinNs(nodeV8),
    'node:http2': builtinNs(nodeHttp2),
    'http2': builtinNs(nodeHttp2),
    'node:dgram': builtinNs(nodeDgram),
    'dgram': builtinNs(nodeDgram),
    'node:sqlite': builtinNs(nodeSqlite),
    'node:test': builtinNs(nodeTest as unknown as Record<string, unknown>),
    'node:util/types': builtinNs(types),
    'util/types': builtinNs(types),
    'node:constants': builtinNs(nodeConstantsModule),
    'constants': builtinNs(nodeConstantsModule),
    'node:fs/promises': builtinNs((nodeFs as { promises: Record<string, unknown> }).promises),
    'fs/promises': builtinNs((nodeFs as { promises: Record<string, unknown> }).promises),
  };

  const loader = createSystemLoader(builtins);
  (globalThis as Record<string, unknown>)['__import__'] = (request: string): Promise<Record<string, unknown>> =>
    loader.import(request, '/');
};
