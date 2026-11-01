import { main } from './main';

// Reserve the exit slot so the engine entry wrapper doesn't auto-exit(0)
// while dsh's async work is still pending. See buildEntry() in
// process-manager.ts.
type ProcRec = { _exitCode?: number; _exitReserved?: boolean; __mainPromise?: Promise<number> };
const g = globalThis as Record<string, unknown>;
if (!g.__process) g.__process = {};
const procRec = g.__process as ProcRec;
procRec._exitReserved = true;
procRec.__mainPromise = main();
procRec.__mainPromise.catch((error: unknown) => {
  const proc = g['process'] as { stderr?: { write(text: string): unknown }; exit?: (code: number) => void } | undefined;
  proc?.stderr?.write(`dsh: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  proc?.exit?.(70);
});
