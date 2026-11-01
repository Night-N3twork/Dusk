import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';
import type { FSBackend } from '../src/host/fs-backend';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

test('git init, add, commit, status, diff, log, branch, merge, reset and stash', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  const sh = async (script: string) => {
    const r = await repl.processManager.spawnSync('/bin/dsh', ['-c', script], { cwd: '/work', env: { PATH: '/bin', HOME: '/home/user' } });
    return { status: r.status, out: decode(r.stdout), err: decode(r.stderr) };
  };
  try {
    await fs.mkdir('/work', { recursive: true });
    expect((await sh('git init')).out).toBe('Initialized empty Git repository in /work/.git/\n');
    expect((await sh('git commit -m nope')).err).toContain('Please tell me who you are');
    await sh('git config --global user.name "Dusk Tester" && git config --global user.email tester@example.com');
    expect((await sh('git config user.name')).out).toBe('Dusk Tester\n');

    await fs.writeFile('/work/readme.md', 'hello\n');
    await fs.mkdir('/work/src');
    await fs.writeFile('/work/src/app.js', 'console.log(1);\n');
    expect((await sh('git status --short')).out).toBe('?? readme.md\n?? src/app.js\n');
    await sh('git add .');
    expect((await sh('git status -s')).out).toBe('A  readme.md\nA  src/app.js\n');
    const first = await sh('git commit -m "initial commit"');
    expect(first.out).toMatch(/^\[main \(root-commit\) [0-9a-f]{7}\] initial commit\n 2 files changed\n$/);
    expect((await sh('git status')).out).toContain('nothing to commit, working tree clean');

    await fs.writeFile('/work/readme.md', 'hello\nworld\n');
    const diff = await sh('git diff');
    expect(diff.out).toContain('diff --git a/readme.md b/readme.md');
    expect(diff.out).toContain('@@ -1 +1,2 @@\n hello\n+world\n');
    expect((await sh('git status --short')).out).toBe(' M readme.md\n');
    await sh('git commit -am "add world"');
    const log = await sh('git log --oneline');
    expect(log.out.split('\n').filter(Boolean).map((line) => line.slice(8))).toEqual(['add world', 'initial commit']);
    expect((await sh('git log -1')).out).toMatch(/^commit [0-9a-f]{40}\nAuthor: Dusk Tester <tester@example\.com>\nDate:   .+\n\n    add world\n\n$/);
    expect((await sh('git show HEAD~1 | head -1')).out).toMatch(/^commit [0-9a-f]{40}\n$/);

    await sh('git switch -c feature');
    await fs.writeFile('/work/src/app.js', 'console.log(2);\n');
    await sh('git commit -am "feature change"');
    expect((await sh('git branch')).out).toBe('* feature\n  main\n');
    await sh('git checkout main');
    expect(await fs.readFile('/work/src/app.js')).toBe('console.log(1);\n');
    const merged = await sh('git merge feature');
    expect(merged.out).toBe('Fast-forward\n');
    expect(await fs.readFile('/work/src/app.js')).toBe('console.log(2);\n');

    await sh('git tag v1.0');
    expect((await sh('git tag')).out).toBe('v1.0\n');
    await fs.writeFile('/work/readme.md', 'scratch\n');
    await sh('git add readme.md');
    expect((await sh('git diff --cached --name-only')).out).toBe('readme.md\n');
    expect((await sh('git diff --cached | grep "^+scratch"')).out).toBe('+scratch\n');
    await sh('git restore --staged readme.md');
    expect((await sh('git status -s')).out).toBe(' M readme.md\n');
    await sh('git checkout -- readme.md');
    expect(await fs.readFile('/work/readme.md')).toBe('hello\nworld\n');

    await fs.writeFile('/work/readme.md', 'stashed edit\n');
    const stashed = await sh('git stash');
    expect(stashed.err).toBe('');
    expect(await fs.readFile('/work/readme.md')).toBe('hello\nworld\n');
    await sh('git stash pop');
    expect(await fs.readFile('/work/readme.md')).toBe('stashed edit\n');
    await sh('git checkout -- readme.md');

    await sh('git reset --hard HEAD~1');
    expect(await fs.readFile('/work/src/app.js')).toBe('console.log(1);\n');
    expect((await sh('git rev-parse --abbrev-ref HEAD')).out).toBe('main\n');

    expect((await sh('git push')).status).not.toBe(0);
    expect((await sh('git frobnicate')).err).toContain("'frobnicate' is not a git command");
    expect((await sh('cd / && git status')).err).toContain('not a git repository');
  } finally {
    await repl.dispose();
  }
}, 120_000);
