export interface BufferInit {
  lengthBuffer: SharedArrayBuffer;
  valueBuffer: SharedArrayBuffer;
  js: string;
}

export interface WaitMessage { type: 'wait'; }
export interface EvalMessage { type: 'eval'; js: string; }
export interface DoneMessage { type: 'done'; ret?: unknown; }
export interface ReadyMessage { type: 'ready'; }

export interface FuncMessage {
  f: string;
  [key: string]: unknown;
}

export type WorldToHost =
  | WaitMessage
  | DoneMessage
  | ReadyMessage
  | FuncMessage;

export type HostToWorld =
  | EvalMessage
  | { value?: unknown; ptr?: number };

// Per-IPC-message ceiling. Sized to fit typical fs.readFile and command
// responses while keeping RAM cost reasonable (this SAB is allocated once
// per engine and pinned for the engine's lifetime).
//
// Trade-off notes:
//   - 10MB → wastes RAM idle; only helps for huge single-shot reads.
//   - 2MB  → too small for a `cat` of a moderate-sized log file.
//   - 4MB  → fits ~1MB of raw binary (bytes encode as JSON int arrays,
//            ~4x bloat) and multi-hundred-KB of text.
// Callers that need bigger payloads must chunk via fd-based read/write,
// which streams through this same SAB in slices.
export const SERIAL_RES_SIZE = 1024 * 1024 * 4;

/**
 * Byte payload convention.
 *
 * The SAB envelope is UTF-8 JSON (TextEncoder.encode(JSON.stringify(msg)))
 * with a SERIAL_RES_SIZE ceiling (see above). There is no transferable /
 * structured-clone path
 * (the engine receives messages as text via /comm + readline).
 *
 * To carry raw bytes, a func argument or return slot named `data` (or any
 * slot documented as `$bytes`) is encoded as a JSON array of unsigned 8-bit
 * integers:
 *
 *   { f: 'fs.writeFileBytes', path: '/x', data: [0x89, 0x50, ...] }
 *   { value: { bytes: [0x89, ...], bytesRead: 4 } }
 *
 * Encode with Array.from(uint8); decode with Uint8Array.from(numArr).
 *
 * Per-call hard cap: bytes + JSON overhead must fit in SERIAL_RES_SIZE.
 * Callers that need larger payloads must chunk via the fd read/write API.
 */
