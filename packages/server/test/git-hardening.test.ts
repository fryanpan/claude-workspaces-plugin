import { beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardSocketRoots, boardSocketRootsPath } from '../src/board-socket-roots.ts';
import { scanFolderPaths } from '../src/fs-scan.ts';
import { gitBarred, hardenedGitArgs, repoOf } from '../src/git-hardening.ts';
import { classifyExternalContent, gitConflictHint } from '../src/git-provenance.ts';
import { boundFiles } from '../src/slow-fs.ts';

// A repository whose config names a program — the shape a lead who could
// write `.git/config` would leave behind. Each server read must not run it.

let dir = '';
let marker = '';

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() });
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_') && v !== undefined) env[k] = v;
  }
  return env;
}

/** A program that leaves `marker` behind when git runs it. */
function plantHook(): string {
  const hook = join(dir, 'hook.sh');
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(hook, 0o755);
  return hook;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cw-git-hardening-')));
  marker = join(dir, 'ran');
});

describe('server git reads ignore programs a repository config names', () => {
  test('core.fsmonitor: plain git runs it, every hardened read does not', () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, ['init', '-q']);
    writeFileSync(join(repo, 'notes.md'), '# Harborlight\n');
    git(repo, ['add', 'notes.md']);
    git(repo, [
      '-c',
      'user.name=Alice',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'x',
    ]);
    git(repo, ['config', 'core.fsmonitor', plantHook()]);

    // Positive control: the planted hook really runs on an unhardened read.
    git(repo, ['status', '--porcelain']);
    expect(existsSync(marker)).toBe(true);
    spawnSync('rm', [marker]);

    git(repo, hardenedGitArgs(['status', '--porcelain']));
    expect(existsSync(marker)).toBe(false);

    classifyExternalContent(join(repo, 'notes.md'), '# Harborlight\n');
    expect(existsSync(marker)).toBe(false);

    expect(scanFolderPaths(repo)).toContain('notes.md');
    expect(existsSync(marker)).toBe(false);
  });

  test('a folder shaped like a bare repository is not read as one', () => {
    const bare = join(dir, 'bare');
    git(dir, ['init', '-q', '--bare', bare]);
    git(bare, ['config', 'core.fsmonitor', plantHook()]);

    // Positive control: unhardened, git takes the folder as a repository.
    expect(git(bare, ['rev-parse', '--git-dir']).status).toBe(0);

    const res = git(bare, hardenedGitArgs(['rev-parse', '--git-dir']));
    expect(res.status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});

/** A repository whose config names a clean filter, which no `-c` option
 *  turns off, and a `core.fsmonitor`: a lead's own repository, planted. */
function plantedRepo(name: string): string {
  const repo = join(dir, name);
  mkdirSync(repo);
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, '.gitattributes'), '*.md filter=harbor\n');
  writeFileSync(join(repo, 'notes.md'), '# Harborlight\n');
  git(repo, ['add', '.']);
  git(repo, [
    '-c',
    'user.name=Alice',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'x',
  ]);
  const hook = plantHook();
  git(repo, ['config', 'core.fsmonitor', hook]);
  git(repo, ['config', 'filter.harbor.clean', `${hook}; cat`]);
  return repo;
}

describe('no git at all under a lead’s root', () => {
  test('a planted filter runs under plain git, and not through the listing or the conflict path', () => {
    const repo = plantedRepo('lead-root');
    // Positive control: a stat-dirty file makes plain git status run both.
    writeFileSync(join(repo, 'notes.md'), '# Harborlight\n\nEdited.\n');
    git(repo, ['status', '--porcelain']);
    expect(existsSync(marker)).toBe(true);
    spawnSync('rm', [marker]);

    // A git on PATH that records each run: under the bar none may happen.
    const shimDir = join(dir, 'shim');
    const spawned = join(dir, 'spawned');
    mkdirSync(shimDir);
    const realGit = spawnSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(shimDir, 'git'), `#!/bin/sh\ntouch '${spawned}'\nexec '${realGit}' "$@"\n`);
    chmodSync(join(shimDir, 'git'), 0o755);
    const realPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${realPath ?? ''}`;
    // Registered for a walled lead, never bound by anyone.
    const roots = new BoardSocketRoots(boardSocketRootsPath(join(dir, 'data')));
    roots.set('w-harbor', [repo]);
    const remove = boundFiles.guards.add(roots);
    try {
      expect(gitConflictHint(join(repo, 'notes.md'), '# Harborlight\n')).toBe('');
      expect(classifyExternalContent(join(repo, 'notes.md'), '# Harborlight\n').source).toBe(
        'unknown',
      );
      // Listing falls back to a walk.
      expect(scanFolderPaths(repo)).toContain('notes.md');
      expect(existsSync(spawned)).toBe(false);
      expect(existsSync(marker)).toBe(false);
      remove();
      // The control: unguarded, the same read runs the shim's git.
      classifyExternalContent(join(repo, 'notes.md'), '# Harborlight\n');
      expect(existsSync(spawned)).toBe(true);
    } finally {
      remove();
      process.env.PATH = realPath;
    }
  });
});

/** A repository with one commit. */
function repoWithCommit(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-q']);
  git(path, [
    '-c',
    'user.name=Alice',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'x',
  ]);
  return path;
}

describe('no git in a repository holding a lead’s root', () => {
  test('bars a parent repository and a worktree whose git folder is in the root', () => {
    const outer = repoWithCommit(join(dir, 'outer'));
    const leadRoot = repoWithCommit(join(outer, 'projects', 'harbor'));
    const wt = join(dir, 'harbor-wt');
    git(leadRoot, ['worktree', 'add', '-q', wt, '-b', 'wt']);
    const other = repoWithCommit(join(dir, 'riverbend'));
    // The controls: nothing is barred before the root is registered.
    for (const d of [outer, wt, other]) expect(gitBarred(d), d).toBe(false);
    const roots = new BoardSocketRoots(boardSocketRootsPath(join(dir, 'data')));
    roots.set('w-harbor', [leadRoot]);
    const remove = boundFiles.guards.add(roots);
    try {
      expect(gitBarred(leadRoot)).toBe(true);
      expect(gitBarred(join(outer, 'README.md'))).toBe(true);
      expect(gitBarred(wt)).toBe(true);
      expect(gitBarred(other)).toBe(false);
    } finally {
      remove();
    }
  });
});

describe('a .git that leads somewhere planted', () => {
  test('refuses a gitdir file git did not write, and a link; keeps a worktree and a folder', () => {
    const main = repoWithCommit(join(dir, 'main'));
    expect(repoOf(main)).toEqual({ top: main, common: join(main, '.git') });
    const wt = join(dir, 'wt');
    git(main, ['worktree', 'add', '-q', wt, '-b', 'wt']);
    expect(repoOf(wt)).toEqual({ top: wt, common: join(main, '.git') });
    expect(repoOf(join(wt, 'deeper'))).toEqual({ top: wt, common: join(main, '.git') });

    const planted = join(dir, 'planted');
    mkdirSync(planted);
    writeFileSync(join(planted, '.git'), `gitdir: ${join(dir, 'elsewhere')}\n`);
    expect(repoOf(planted)).toBe('refused');
    expect(gitBarred(join(planted, 'notes.md'))).toBe(true);

    // Shaped like a worktree's git folder, but not one git registered.
    const fake = join(dir, 'fake', '.git', 'worktrees', 'w');
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, 'commondir'), '../..\n');
    writeFileSync(join(fake, 'gitdir'), `${join(dir, 'somewhere', '.git')}\n`);
    const shaped = join(dir, 'shaped');
    mkdirSync(shaped);
    writeFileSync(join(shaped, '.git'), `gitdir: ${fake}\n`);
    expect(repoOf(shaped)).toBe('refused');

    const linked = join(dir, 'linked');
    mkdirSync(linked);
    symlinkSync(join(main, '.git'), join(linked, '.git'));
    expect(repoOf(linked)).toBe('refused');
  });
});
