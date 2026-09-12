/**
 * A throwaway checkout shaped like a builder's worktree: a base commit that
 * `origin/main` and `origin/HEAD` both point at, and whatever the builder has
 * written on top of it.
 *
 * The two remote refs are what a real clone has and what `defaultBaseRef`
 * reads, so a fixture without them would be testing the fallback rather than
 * the path every dispatched worktree actually takes. They are set with
 * `update-ref` and `symbolic-ref` rather than by cloning a bare repo: same
 * refs, no second directory and no network vocabulary.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

function write(repo: string, relPath: string, text: string): void {
  const full = join(repo, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

export interface BuilderWorktree {
  path: string;
  /** Write more files into the working tree, uncommitted. */
  edit: (files: Record<string, string>) => void;
  /** Commit whatever is in the working tree, so a test can prove the read
   *  covers committed work as well as a dirty tree. */
  commit: (message?: string) => void;
  cleanup: () => void;
}

/**
 * @param changed files the builder has written since leaving the base, by
 *   path relative to the worktree root. Left uncommitted, because that is the
 *   state a live builder is in for most of its run.
 * @param existing files that were already on the default branch when the
 *   builder took the worktree — what it has to have in order to move or
 *   delete one.
 */
export function makeBuilderWorktree(
  changed: Record<string, string> = {},
  existing: Record<string, string> = {},
): BuilderWorktree {
  const path = mkdtempSync(join(tmpdir(), 'ws-builder-'));
  git(path, 'init', '-q', '-b', 'main');
  write(path, 'README.md', 'base\n');
  for (const [rel, text] of Object.entries(existing)) write(path, rel, text);
  git(path, 'add', '-A');
  git(path, 'commit', '-qm', 'base');
  const base = git(path, 'rev-parse', 'HEAD');
  git(path, 'update-ref', 'refs/remotes/origin/main', base);
  git(path, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(path, 'checkout', '-q', '-b', 'builder');
  for (const [rel, text] of Object.entries(changed)) write(path, rel, text);
  return {
    path,
    edit: (files) => {
      for (const [rel, text] of Object.entries(files)) write(path, rel, text);
    },
    commit: (message = 'work') => {
      git(path, 'add', '-A');
      git(path, 'commit', '-qm', message);
    },
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}
