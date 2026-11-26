/**
 * `gitTracking`: whether git tracks a file, which the Library uses to tell a
 * file an agent just wrote (untracked) from one a pull left (tracked).
 *
 * All fixtures synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitTracking } from '../src/git-provenance.ts';

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });

describe('gitTracking', () => {
  let repo: string;
  let loose: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'git-tracking-repo-'));
    loose = mkdtempSync(join(tmpdir(), 'git-tracking-loose-'));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, '.gitignore'), 'scratch/\n*.tmp.md\n');
    writeFileSync(join(repo, 'handbook.md'), '# Handbook\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(loose, { recursive: true, force: true });
  });

  it('reads a committed file as tracked and a new one beside it as untracked', async () => {
    writeFileSync(join(repo, 'quay-plan.md'), '# Quay plan\n');
    expect(await gitTracking(join(repo, 'handbook.md'))).toBe('tracked');
    expect(await gitTracking(join(repo, 'quay-plan.md'))).toBe('untracked');
  });

  it('reads an ignored file as untracked: nothing pulled it there', async () => {
    writeFileSync(join(repo, 'notes.tmp.md'), 'draft\n');
    expect(await gitTracking(join(repo, 'notes.tmp.md'))).toBe('untracked');
  });

  it('cannot tell for a file outside any repository', async () => {
    writeFileSync(join(loose, 'harborlight.md'), '# Harborlight\n');
    expect(await gitTracking(join(loose, 'harborlight.md'))).toBe('unknown');
  });

  it('reads a name with glob characters as that one file', async () => {
    writeFileSync(join(repo, 'a?.md'), 'x\n');
    git(repo, 'add', 'a?.md');
    git(repo, 'commit', '-q', '-m', 'glob');
    writeFileSync(join(repo, 'ab.md'), 'y\n');
    expect(await gitTracking(join(repo, 'ab.md'))).toBe('untracked');
  });
});
