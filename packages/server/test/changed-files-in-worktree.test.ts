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
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFilesInWorktree, defaultBaseRef } from '../src/git-diff.ts';
import { type BuilderWorktree, makeBuilderWorktree } from './builder-worktree-fixture.ts';

const made: BuilderWorktree[] = [];
const worktree = (
  files?: Record<string, string>,
  existing?: Record<string, string>,
  objectFormat?: 'sha1' | 'sha256',
): BuilderWorktree => {
  const wt = makeBuilderWorktree(files, existing, objectFormat);
  made.push(wt);
  return wt;
};

const run = (wt: BuilderWorktree, ...args: string[]): string =>
  execFileSync('git', ['-C', wt.path, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();

afterEach(() => {
  for (const wt of made.splice(0)) wt.cleanup();
});

describe('the base a builder is judged against', () => {
  it('is the remote default branch the clone names', () => {
    expect(defaultBaseRef(worktree().path)).toBe('origin/main');
  });

  it('is the closest trunk, not whichever ref origin/HEAD was cloned against', () => {
    // The repo renamed master to main and kept the old branch. git never
    // refreshes origin/HEAD, so it still names the abandoned trunk — and
    // reading from there blames the builder for everything main has landed
    // since the rename.
    const wt = worktree();
    const base = run(wt, 'rev-parse', 'HEAD');
    run(wt, 'checkout', '-q', 'main');
    wt.edit({ 'packages/app/src/board.css': '.somebody-else{}\n' });
    run(wt, 'add', '-A');
    run(wt, 'commit', '-qm', 'somebody else moves main on');
    run(wt, 'update-ref', 'refs/remotes/origin/main', run(wt, 'rev-parse', 'HEAD'));
    run(wt, 'update-ref', 'refs/remotes/origin/master', base);
    run(wt, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master');
    run(wt, 'checkout', '-q', '-b', 'builder2');
    wt.edit({ 'packages/server/src/clock.ts': 'export const t = 1;\n' });

    expect(defaultBaseRef(wt.path)).toBe('origin/main');
    expect(changedFilesInWorktree(wt.path)).toEqual(['packages/server/src/clock.ts']);
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

  it('starts from a recorded baseline, so a reused worktree is not one history', () => {
    // The worktree finished one task and was handed to another. Everything
    // the first occupant committed is still on the branch; only what the
    // second has written is this dispatch's work.
    const wt = worktree({ 'packages/app/src/board.css': '.first{}\n' });
    wt.commit('the previous occupant');
    const baseline = execFileSync('git', ['-C', wt.path, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    wt.edit({ 'packages/server/src/clock.ts': 'export const t = 1;\n' });

    expect(changedFilesInWorktree(wt.path)?.sort()).toEqual([
      'packages/app/src/board.css',
      'packages/server/src/clock.ts',
    ]);
    expect(changedFilesInWorktree(wt.path, baseline)).toEqual(['packages/server/src/clock.ts']);
  });

  it('ignores a baseline that is not in this branch’s history', () => {
    const other = worktree({ 'src/elsewhere.ts': 'x\n' });
    other.commit();
    const stranger = execFileSync('git', ['-C', other.path, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const wt = worktree({ 'src/mine.ts': 'mine\n' });
    // A commit this repo has never heard of falls back to the merge base
    // rather than failing the read or reporting a diff about nothing.
    expect(changedFilesInWorktree(wt.path, stranger)).toEqual(['src/mine.ts']);
  });

  it('reads a repository whose object ids are SHA-256', () => {
    // git prints 64-character ids there. A reader that recognises only the
    // 40-character shape answers "cannot tell" for every worktree in such a
    // repo, which silences the gate rather than failing it.
    const wt = worktree({ 'packages/app/src/board.css': '.b{}\n' }, {}, 'sha256');
    expect(changedFilesInWorktree(wt.path)).toEqual(['packages/app/src/board.css']);
  });

  it('names both ends of a rename, so a file moved OUT of a tree still counts', () => {
    // A screen moved into the server's templates is a change to something a
    // person looks at. A list holding only the destination says otherwise.
    const wt = worktree({}, { 'packages/app/src/pages/home.tsx': '<main/>\n' });
    mkdirSync(join(wt.path, 'packages/server/src'), { recursive: true });
    execFileSync('git', [
      '-C',
      wt.path,
      'mv',
      'packages/app/src/pages/home.tsx',
      'packages/server/src/home-template.ts',
    ]);
    wt.commit('move the screen');
    expect(changedFilesInWorktree(wt.path)?.sort()).toEqual([
      'packages/app/src/pages/home.tsx',
      'packages/server/src/home-template.ts',
    ]);
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
