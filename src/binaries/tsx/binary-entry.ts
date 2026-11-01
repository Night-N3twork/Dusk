import { main } from './main';

type ProcRec = { _exitReserved?: boolean; __mainPromise?: Promise<number> };
const g = globalThis as Record<string, unknown>;
if (!g.__process) g.__process = {};
const procRec = g.__process as ProcRec;
procRec._exitReserved = true;
procRec.__mainPromise = main();
