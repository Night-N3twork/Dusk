import { bootRepl, snapshotFromUrl, snapshotToUrl } from '@nightnetwork/dusk';

export const shareProject = async (): Promise<string> => {
  const repl = await bootRepl(() => {}, { skipPidZero: true });
  try {
    const archive = await repl.exportSnapshot({ root: '/home/user/project', exclude: ['/home/user/project/node_modules'] });
    return snapshotToUrl(archive);
  } finally {
    await repl.dispose();
  }
};

export const openSharedProject = async (): Promise<string[]> => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  const archive = snapshotFromUrl(location.href);
  return archive ? repl.importSnapshot(archive, { root: '/home/user/project' }) : [];
};

export const mountLocalFolder = async (): Promise<void> => {
  const picker = (window as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  if (!picker) throw new Error('This browser cannot open local folders');
  const repl = await bootRepl(() => {}, { skipPidZero: true });
  repl.mount('/mnt/local', await picker());
  const listing = await repl.processManager.spawnSync('/bin/dsh', ['-c', 'ls -la /mnt/local'], { cwd: '/' });
  console.log(new TextDecoder().decode(listing.stdout));
};
