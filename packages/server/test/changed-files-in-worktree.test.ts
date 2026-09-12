/**
 * `changedFilesInWorktree` (`git-diff.ts`): what a builder has written since
 * it left the default branch, which is the read the UI gate's verdict now
 * rests on.
 *
 * Driven against real checkouts rather than a mocked git, because every
 * failure this has to survive — no remote, no merge base, a directory that is
 * not a repo — is a property of git and not of a stub.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFilesInWorktree, defaultBaseRef } from '../src/git-diff.ts';
import { type BuilderWorktree, makeBuilderWorktree } from './builder-worktree-fixture.ts';

const made: BuilderWorktree[] = [];
const worktree = (files?: Record<string, string>): BuilderWorktree => {
  const wt = makeBuilderWorktree(files);
  made.push(wt);
  return wt;
};

afterEach(() => {
  for (const wt of made.splice(0)) wt.cleanup();
});

describe('the base a builder is judged against', () => {
  it('is the remote default branch the clone names', () => {
    expect(defaultBaseRef(worktree().path)).toBe('origin/main');
  });

  it('is nothing at all when no remote branch answers', () => {
    const bare = mkdtempSync(join(tmpdir(), 'ws-noremote-'));
    execFileSync('git', ['-C', bare, 'init', '-q']);
    try {
      expect(defaultBaseRef(bare)).toBeNull();
      expect(changedFilesInWorktree(bare)).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('is nothing at all outside a repo', () => {
    const plain = mkdtempSync(join(tmpdir(), 'ws-norepo-'));
    try {
      expect(changedFilesInWorktree(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('what the read returns', () => {
  it('lists a file the builder has written and not committed', () => {
    const wt = worktree({ 'packages/app/src/board.css': '.b{}\n' });
    expect(changedFilesInWorktree(wt.path)).toEqual(['packages/app/src/board.css']);
  });

  it('lists it the same once it is committed', () => {
    const wt = worktree({ 'packages/app/src/board.css': '.b{}\n' });
    wt.commit();
    expect(changedFilesInWorktree(wt.path)).toEqual(['packages/app/src/board.css']);
  });

  it('lists committed and uncommitted work together', () => {
    const wt = worktree({ 'src/one.ts': 'a\n' });
    wt.commit();
    wt.edit({ 'src/two.ts': 'b\n' });
    expect(changedFilesInWorktree(wt.path)?.sort()).toEqual(['src/one.ts', 'src/two.ts']);
  });

  it('is an empty list — not null — for a worktree that has changed nothing', () => {
    const files = changedFilesInWorktree(worktree().path);
    expect(files).toEqual([]);
    expect(files).not.toBeNull();
  });

  it('does not blame the builder for what the default branch moved on', () => {
    // The base is the MERGE BASE, so a branch left behind by main must not
    // read as having changed every file main touched since.
    const wt = worktree({ 'src/mine.ts': 'mine\n' });
    wt.commit();
    execFileSync('git', ['-C', wt.path, 'checkout', '-q', 'main']);
    wt.edit({ 'src/theirs.ts': 'theirs\n' });
    execFileSync('git', ['-C', wt.path, 'add', '-A']);
    execFileSync('git', ['-C', wt.path, 'commit', '-qm', 'main moves on'], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
    execFileSync('git', [
      '-C',
      wt.path,
      'update-ref',
      'refs/remotes/origin/main',
      execFileSync('git', ['-C', wt.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    ]);
    execFileSync('git', ['-C', wt.path, 'checkout', '-q', 'builder']);
    expect(changedFilesInWorktree(wt.path)).toEqual(['src/mine.ts']);
  });
});
