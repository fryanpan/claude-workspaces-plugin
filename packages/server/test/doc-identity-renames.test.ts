import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearRenameScans, gitRenameOf } from '../src/doc-identity-renames.ts';

/**
 * Asking git where a file went, against real repositories.
 *
 * Fixtures are synthetic.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

describe('gitRenameOf', () => {
  let tmp: string;
  let repo: string;
  const rel = 'docs/plan.md';

  beforeEach(() => {
    clearRenameScans();
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-rename-')));
    repo = join(tmp, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', 'git@github.com:example/widgets.git');
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, rel), '# Plan\n\nThe cache is warmed at boot.\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
  });

  afterEach(() => {
    clearRenameScans();
    rmSync(tmp, { recursive: true, force: true });
  });

  const rename = (from: string, to: string): void => {
    git(repo, 'mv', from, to);
    git(repo, 'commit', '-m', `rename ${to}`);
    clearRenameScans();
  };

  it('answers null for a file that never moved, and the new path for one that did', () => {
    // The negative half needs the positive one beside it: a resolver that
    // always answered null would pass the first assertion alone, and one that
    // always answered would pass the second.
    expect(gitRenameOf(join(repo, rel), rel)).toBeNull();
    rename(rel, 'docs/roadmap.md');
    expect(gitRenameOf(join(repo, rel), rel)).toBe('docs/roadmap.md');
  });

  it('follows a file renamed twice to where it is now', () => {
    rename(rel, 'docs/roadmap.md');
    rename('docs/roadmap.md', 'docs/strategy.md');
    expect(gitRenameOf(join(repo, rel), rel)).toBe('docs/strategy.md');
    // And the middle name resolves too — a link saved against it still works.
    expect(gitRenameOf(join(repo, 'docs/roadmap.md'), 'docs/roadmap.md')).toBe('docs/strategy.md');
  });

  it('answers null for a path that is in no repository', () => {
    expect(gitRenameOf(join(tmp, 'loose.md'), 'loose.md')).toBeNull();
  });

  it('remembers one scan per checkout, and forgets on demand', () => {
    // The memo is the whole reason a corpus of thousands of documents does
    // not spawn thousands of `git log`s. It also means a rename made after a
    // scan is invisible until the memo is dropped, which is the behaviour a
    // caller has to know about.
    expect(gitRenameOf(join(repo, rel), rel)).toBeNull();
    git(repo, 'mv', rel, 'docs/roadmap.md');
    git(repo, 'commit', '-m', 'rename');
    expect(gitRenameOf(join(repo, rel), rel)).toBeNull();
    clearRenameScans();
    expect(gitRenameOf(join(repo, rel), rel)).toBe('docs/roadmap.md');
  });

  it('reads the checkout it is asked about, not every branch in the repo', () => {
    // A worktree on a branch cut BEFORE the rename still holds the file at
    // the old path, and answering with a path from somebody else's branch
    // would be a wrong answer, not a helpful one. The main checkout, whose
    // history has the rename, gets it.
    const wt = join(tmp, 'wt');
    git(repo, 'worktree', 'add', wt, '-b', 'feature');
    rename(rel, 'docs/roadmap.md');
    expect(gitRenameOf(join(wt, rel), rel)).toBeNull();
    expect(gitRenameOf(join(repo, rel), rel)).toBe('docs/roadmap.md');
  });
});
