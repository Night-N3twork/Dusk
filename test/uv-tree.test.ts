import { expect, test } from 'vitest';
import { createMemoryBackend } from '../src/host/fs-backend';
import { applyTree, collectTree, signTree, TreeTooLargeError } from '../src/host/uv-tree';

const seed = async (files: Record<string, string>) => {
  const fs = createMemoryBackend();
  for (const [path, text] of Object.entries(files)) {
    await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(path, text);
  }
  return fs;
};

test('collects a tree as one buffer plus offsets, skipping node_modules and .git', async () => {
  const fs = await seed({ '/p/a.txt': 'aa', '/p/sub/b.txt': 'bbb', '/p/node_modules/x.js': 'x', '/p/.git/HEAD': 'h' });
  const tree = await collectTree(fs, '/p');
  expect(tree.entries.map((entry) => entry.path)).toEqual(['a.txt', 'sub/b.txt']);
  expect(new TextDecoder().decode(tree.bytes)).toBe('aabbb');
});

test('refuses a tree over the size limit before reading it', async () => {
  const fs = await seed({ '/p/big.bin': 'x'.repeat(100) });
  await expect(collectTree(fs, '/p', { maxBytes: 10 })).rejects.toBeInstanceOf(TreeTooLargeError);
});

test('a signature changes with content and survives a no-op', async () => {
  const fs = await seed({ '/p/a.txt': 'a' });
  const before = await signTree(fs, '/p');
  expect(await signTree(fs, '/p')).toBe(before);
  await fs.writeFile('/p/a.txt', 'changed');
  expect(await signTree(fs, '/p')).not.toBe(before);
});

test('applying writes only what changed and removes what vanished', async () => {
  const fs = await seed({ '/p/keep.txt': 'same', '/p/edit.txt': 'old', '/p/gone/x.txt': 'x', '/p/node_modules/untouched.js': 'u' });
  const sent = await collectTree(fs, '/p');

  const encoder = new TextEncoder();
  const keep = encoder.encode('same');
  const edit = encoder.encode('new');
  const added = encoder.encode('fresh');
  const bytes = new Uint8Array([...keep, ...edit, ...added]);
  const report = await applyTree(fs, '/p', {
    entries: [
      { kind: 'file', path: 'keep.txt', offset: 0, length: keep.length },
      { kind: 'file', path: 'edit.txt', offset: keep.length, length: edit.length },
      { kind: 'file', path: 'new/added.txt', offset: keep.length + edit.length, length: added.length },
    ],
    bytes,
  }, sent.digests);

  expect(report).toMatchObject({ written: 2, removed: 1 });
  expect(await fs.readFile('/p/edit.txt')).toBe('new');
  expect(await fs.readFile('/p/new/added.txt')).toBe('fresh');
  expect(await fs.exists('/p/gone/x.txt')).toBe(false);
  expect(await fs.exists('/p/gone')).toBe(false);
  // Never sent, so never deleted.
  expect(await fs.readFile('/p/node_modules/untouched.js')).toBe('u');
});

test('refuses an entry that climbs out of the root', async () => {
  const fs = await seed({ '/p/a.txt': 'a' });
  await expect(applyTree(fs, '/p', {
    entries: [{ kind: 'file', path: '../escape.txt', offset: 0, length: 0 }],
    bytes: new Uint8Array(0),
  }, new Map())).rejects.toThrow('does not name a place inside /p');
  expect(await fs.exists('/escape.txt')).toBe(false);
});
