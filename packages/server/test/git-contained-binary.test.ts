/**
 * `git-contained.ts`, review round 2: which git a contained call runs (H1)
 * and how it finds the repository (M1).
 *
 * H1: the binary comes from a fixed list of root-owned paths, never from
 * `xcrun`, whose per-user cache a lead can write. A forged candidate the
 * owner can write, listed first, is passed over. M1: the repository is
 * found with one open of `.git` per level, and no folder is listed.
 * Fixtures synthetic, temp dirs only.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardSocketRoots, boardSocketRootsPath } from '../src/board-socket-roots.ts';
import {
  GIT_CANDIDATES,
  containedGit,
  pickGit,
  repoInsideRoot,
  setGitCandidatesForTest,
} from '../src/git-contained.ts';
import { boundFiles } from '../src/slow-fs.ts';
import * as treeFs from '../src/tree-fs.ts';

const DARWIN = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const top = realpathSync(mkdtempSync(join(tmpdir(), 'git-contained-bin-')));
const roots = new BoardSocketRoots(boardSocketRootsPath(join(top, 'data')), undefined, undefined, {
  home: join(top, 'home'),
  uid: 4242,
  realpath: (p) => realpathSync.native(p),
});
const remove = boundFiles.guards.add(roots);
afterAll(() => {
  remove();
  rmSync(top, { recursive: true, force: true });
});
afterEach(() => setGitCandidatesForTest(null));

/** A git-shaped script the owner can write, as a forged cache entry would name. */
function forged(): { git: string; prefix: string; marker: string } {
  const prefix = join(top, 'forged', 'usr');
  const marker = join(top, 'forged-ran');
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  const git = join(prefix, 'bin', 'git');
  writeFileSync(git, `#!/bin/sh\necho ran > "${marker}"\n`);
  chmodSync(git, 0o755);
  return { git, prefix, marker };
}

const realGit = pickGit(GIT_CANDIDATES);

describe('the git a contained call runs', () => {
  it('passes over a git the owner can write, and over one reached through a link', () => {
    const f = forged();
    expect(pickGit([f])).toBeNull();
    const linked = join(top, 'linked-usr');
    if (realGit) {
      symlinkSync(realGit.prefix, linked);
      expect(pickGit([{ git: join(linked, 'bin', 'git'), prefix: linked }])).toBeNull();
      // Positive control: the root-owned one is picked after the forged one.
      expect(pickGit([f, realGit])).toEqual(realGit);
    }
  });

  it.skipIf(!DARWIN || !realGit)(
    'runs root-owned git when a forged one is listed first',
    async () => {
      const f = forged();
      const root = join(top, 'harborlight');
      mkdirSync(root);
      writeFileSync(join(root, 'plan.md'), '# plan\n');
      spawnSync('git', ['-C', root, 'init', '-q'], { env: { PATH: '/usr/bin:/bin' } });
      spawnSync('git', ['-C', root, 'add', '.'], { env: { PATH: '/usr/bin:/bin' } });
      expect(roots.set('w-bin', [root]).ok).toBe(true);
      setGitCandidatesForTest([f, ...GIT_CANDIDATES]);
      const got = await containedGit(root, ['ls-files', '-z']);
      expect(got?.ok).toBe(true);
      expect(got?.stdout.split('\0')).toContain('plan.md');
      expect(existsSync(f.marker)).toBe(false);
      // With only the forged one listed, nothing runs: "cannot tell".
      setGitCandidatesForTest([f]);
      const refused = await containedGit(root, ['ls-files', '-z']);
      expect(refused?.ok).toBe(false);
      expect(existsSync(f.marker)).toBe(false);
    },
  );
});

describe('finding the repository inside a root', () => {
  it('opens .git once per level and lists no folder', () => {
    const root = join(top, 'riverbend');
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(deep, { recursive: true });
    for (let i = 0; i < 200; i++) writeFileSync(join(root, `f${i}`), '');
    expect(roots.set('w-find', [root]).ok).toBe(true);
    const spy = spyOn(treeFs, 'listTreeSync');
    try {
      // Positive control: the spy sees a direct call.
      treeFs.listTreeSync({ root, abs: root }, { maxEntries: 10_000, enter: () => false });
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      expect(repoInsideRoot({ root, abs: deep })).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('answers no for a .git link, and for a .git file naming a folder outside', () => {
    const root = join(top, 'saltmarsh');
    const outside = join(top, 'saltmarsh-outside');
    mkdirSync(join(root, 'sub'), { recursive: true });
    mkdirSync(outside);
    expect(roots.set('w-link', [root]).ok).toBe(true);
    symlinkSync(outside, join(root, 'sub', '.git'));
    expect(repoInsideRoot({ root, abs: join(root, 'sub') })).toBe(false);
    writeFileSync(join(root, '.git'), `gitdir: ${outside}\n`);
    expect(repoInsideRoot({ root, abs: root })).toBe(false);
    writeFileSync(join(root, '.git'), 'gitdir: inner/.git\n');
    expect(repoInsideRoot({ root, abs: root })).toBe(true);
  });
});

describe('the subcommands a contained call runs', () => {
  it('refuses one outside the list, and a global option first', async () => {
    const root = join(top, 'harborlight-sub');
    mkdirSync(join(root, '.git'), { recursive: true });
    expect(roots.set('w-sub', [root]).ok).toBe(true);
    for (const args of [
      ['blame', 'x'],
      ['--no-pager', 'diff'],
      ['grep', '--textconv', 'x'],
    ]) {
      const got = await containedGit(root, args);
      expect(got).toEqual({ ok: false, stdout: '', stderr: 'not a contained subcommand' });
    }
  });
});
