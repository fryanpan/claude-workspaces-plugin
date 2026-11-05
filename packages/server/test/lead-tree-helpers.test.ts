/**
 * The helpers a module can reach without importing `node:fs` refuse a file
 * under a walled lead's root themselves (review M4), and the reads that do
 * reach one go through `tree-fs.ts`:
 *
 * - 7: `guards.exists` answers the same for a link to an outside file that
 *   exists and one that does not, so no caller leaks which;
 * - 9: `statStampSync` on a link reports no outside size;
 * - 19: a name git prints is judged raw, before `join` normalises it;
 * - 20: a lead's tree is never given a repository identity, even when it
 *   is a worktree of a repository with an origin (review H1);
 * - 24: every exported checked helper refuses a root's file;
 * - 5: a framed page's file behind a link is not served, and a plain one is
 *   (through contained git, which lists it).
 *
 * Each refusal has a control: the same call on a path no root holds. macOS
 * only where the contained calls are needed. Temp dirs, synthetic names.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardSocketRoots, boardSocketRootsPath } from '../src/board-socket-roots.ts';
import {
  GuardRefused,
  readBytesChecked,
  readChecked,
  readCheckedSync,
  readRangeChecked,
  writeChecked,
  writeCheckedSync,
} from '../src/bound-path-guard.ts';
import { readDocFile } from '../src/doc-file-frame.ts';
import { clearDocFileListings } from '../src/doc-file-listing.ts';
import { docKeyForPath, repoIdentityAt } from '../src/doc-key.ts';
import { findWorktreeRoot, gitCommonDir } from '../src/doc-origin-repo.ts';
import { statStampSync } from '../src/file-stamp.ts';
import { isSafeGitName } from '../src/git-contained.ts';
import { readLine } from '../src/git-hardening.ts';
import { checkMockupSource } from '../src/mockup-capture.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { treeFsMode } from '../src/tree-fs.ts';

const CONTAINED = treeFsMode() === 'contained';
const top = realpathSync(mkdtempSync(join(tmpdir(), 'lead-helpers-')));
const root = join(top, 'harborlight');
const outside = join(top, 'riverbend');
const plain = join(top, 'saltmarsh');
for (const d of [join(root, 'docs'), outside, plain]) mkdirSync(d, { recursive: true });
writeFileSync(join(outside, 'secret.md'), 'riverbend-canary-0c4e\n'.repeat(40));
writeFileSync(join(root, 'docs', 'plan.md'), '# plan\n');
writeFileSync(join(plain, 'plan.md'), '# plan\n');
symlinkSync(join(outside, 'secret.md'), join(root, 'docs', 'to-real.md'));
symlinkSync(join(outside, 'missing.md'), join(root, 'docs', 'to-missing.md'));

const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: top, GIT_CONFIG_NOSYSTEM: '1' },
  });

const roots = new BoardSocketRoots(boardSocketRootsPath(join(top, 'data')), undefined, undefined, {
  home: join(top, 'home'),
  uid: 4242,
  realpath: (p) => realpathSync.native(p),
});
const remove = boundFiles.guards.add(roots);
expect(roots.set('w-harbor', [root]).ok).toBe(true);
afterAll(() => {
  remove();
  rmSync(top, { recursive: true, force: true });
});

describe.skipIf(!CONTAINED)('a lead’s tree, through the helpers', () => {
  it('7: exists answers the same for a link to a real and to a missing outside file', () => {
    const real = boundFiles.guards.exists(join(root, 'docs', 'to-real.md'));
    const missing = boundFiles.guards.exists(join(root, 'docs', 'to-missing.md'));
    expect(real).toBe(missing);
    expect(boundFiles.guards.exists(join(root, 'docs', 'plan.md'))).toBe(true);
    expect(boundFiles.guards.exists(join(root, 'docs', 'nothing.md'))).toBe(false);
  });

  it('9: statStampSync on a link reports no outside size', () => {
    expect(() => statStampSync(join(root, 'docs', 'to-real.md'))).toThrow();
    expect(Number(statStampSync(join(root, 'docs', 'plan.md')).size)).toBe(7);
  });

  it('24: every exported checked helper refuses a root’s file, and reads a plain one', async () => {
    const file = join(root, 'docs', 'plan.md');
    const any = () => true;
    const refusals: Array<() => unknown> = [
      () => readChecked(file, any),
      () => readBytesChecked(file, 1024, any),
      () => readRangeChecked(file, 0, 2, any),
      () => writeChecked(file, '# no\n', any),
    ];
    for (const call of refusals)
      await expect(Promise.resolve().then(call)).rejects.toThrow(GuardRefused);
    expect(() => readCheckedSync(file, any)).toThrow(GuardRefused);
    expect(() => writeCheckedSync(file, '# no\n', 'flush', any)).toThrow(GuardRefused);
    expect(readLine(file, /^(.*)$/m)).toBeNull();
    // The control: the same helpers on a path no root holds.
    expect((await readChecked(join(plain, 'plan.md'), any)).text).toBe('# plan\n');
    expect(readLine(join(plain, 'plan.md'), /^(.*)$/m)).toBe('# plan');
  });
});

describe.skipIf(!CONTAINED)('8: a mock source behind a link', () => {
  it('gets the same reason whether the outside file exists or not', () => {
    const real = checkMockupSource(join(root, 'docs', 'to-real.md'));
    const missing = checkMockupSource(join(root, 'docs', 'to-missing.md'));
    expect(real.ok).toBe(false);
    expect(real).toEqual(missing);
    expect(checkMockupSource(join(root, 'docs', 'plan.md'))).toEqual({ ok: true });
  });
});

describe('19: a name git printed is judged raw', () => {
  it('drops ../, a leading /, an empty or . segment, and a NUL', () => {
    for (const bad of ['../outside.md', '/abs.md', 'a//b.md', 'a/./b.md', 'a/../b.md', '', 'a\0b'])
      expect(isSafeGitName(bad)).toBe(false);
    expect(isSafeGitName('docs/plan.md')).toBe(true);
    expect(isSafeGitName('.github/x.md')).toBe(true);
  });
});

describe.skipIf(!CONTAINED)('20: a lead’s worktree of an owner repository has no identity', () => {
  it('is path-bound under a root, and keyed by origin outside one (the control)', () => {
    const owner = join(top, 'owner-repo');
    mkdirSync(join(owner, 'docs'), { recursive: true });
    writeFileSync(join(owner, 'docs', 'plan.md'), '# plan\n');
    git(owner, 'init', '-q');
    git(owner, 'remote', 'add', 'origin', 'https://github.com/harborlight/plan.git');
    git(owner, 'add', '.');
    git(
      owner,
      '-c',
      'user.name=Alice',
      '-c',
      'user.email=alice@example.invalid',
      'commit',
      '-qm',
      's',
    );
    const tree = join(top, 'lead-worktree');
    git(owner, 'worktree', 'add', '-q', tree);
    // The control: before the worktree is a root, it shares the owner's key.
    const before = docKeyForPath(join(tree, 'docs', 'plan.md'));
    expect(before?.repoKey).toBe(docKeyForPath(join(owner, 'docs', 'plan.md'))?.repoKey);
    expect(roots.set('w-tree', [tree]).ok).toBe(true);
    try {
      expect(findWorktreeRoot(join(tree, 'docs', 'plan.md'))).toBeNull();
      expect(gitCommonDir(tree)).toBeNull();
      expect(repoIdentityAt(join(tree, 'docs', 'plan.md'))).toBeNull();
      expect(docKeyForPath(join(tree, 'docs', 'plan.md'))).toBeNull();
    } finally {
      roots.set('w-tree', []);
    }
  });
});

describe.skipIf(!CONTAINED)('5: a framed page’s file under a root', () => {
  it('serves a git-listed plain file and not one behind a link', async () => {
    const site = join(root, 'site');
    mkdirSync(site, { recursive: true });
    writeFileSync(join(site, 'style.css'), 'body{}\n');
    writeFileSync(join(root, 'docs', 'inner.css'), 'riverbend{}\n');
    symlinkSync(join(root, 'docs', 'inner.css'), join(site, 'linked.css'));
    git(root, 'init', '-q');
    git(root, 'add', '.');
    clearDocFileListings();
    const ok = await readDocFile(root, ['site'], ['site', 'style.css']);
    expect(ok.ok).toBe(true);
    const linked = await readDocFile(root, ['site'], ['site', 'linked.css']);
    expect(linked).toEqual({ ok: false, status: 404 });
  });
});
