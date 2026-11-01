import { bootRepl } from '@nightnetwork/dusk';

interface TerminalLike {
  write(data: Uint8Array | string): void;
  onData(listener: (data: string) => void): void;
  onResize(listener: (size: { cols: number; rows: number }) => void): void;
  readonly cols: number;
  readonly rows: number;
}

export const attachShell = async (terminal: TerminalLike): Promise<() => Promise<void>> => {
  const repl = await bootRepl(() => {}, { skipPidZero: true });
  const shell = await repl.processManager.spawn('/bin/dsh', [], {
    cwd: '/home/user',
    env: { HOME: '/home/user', PATH: '/bin', TERM: 'xterm-256color', USER: 'user' },
    pty: { cols: terminal.cols, rows: terminal.rows },
  });
  const encoder = new TextEncoder();
  shell.master?.onMasterData((bytes) => terminal.write(bytes));
  terminal.onData((data) => { void shell.stdin.write(encoder.encode(data)); });
  terminal.onResize(({ cols, rows }) => repl.processManager.resizePty(shell.pid, cols, rows));
  return () => repl.dispose();
};
