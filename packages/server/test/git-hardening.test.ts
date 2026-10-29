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
import { readOriginUrl } from '../src/doc-key.ts';
import { checkoutBranch, gitCommonDir } from '../src/doc-origin-repo.ts';
import { scanFolderPaths, scanFolderPathsAsync } from '../src/fs-scan.ts';
import { diffFiles } from '../src/git-diff.ts';
import { gitBarred, hardenedGitArgs, readLine, repoOf } from '../src/git-hardening.ts';
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
  test('a planted filter runs under plain git, and not through the listing or the conflict path', async () => {
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
      // Listing falls back to a walk, in the background rescan too.
      expect(scanFolderPaths(repo)).toContain('notes.md');
      expect(await scanFolderPathsAsync(repo)).toContain('notes.md');
      expect(existsSync(spawned)).toBe(false);
      expect(existsSync(marker)).toBe(false);
      remove();
      // The controls: unguarded, the same reads run the shim's git.
      classifyExternalContent(join(repo, 'notes.md'), '# Harborlight\n');
      expect(existsSync(spawned)).toBe(true);
      for (const listing of [() => scanFolderPaths(repo), () => scanFolderPathsAsync(repo)]) {
        spawnSync('rm', [spawned]);
        await listing();
        expect(existsSync(spawned)).toBe(true);
      }
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

describe('the server reads none of a barred repository’s own files', () => {
  test('its branch, common folder and origin read as unknown', () => {
    const leadRoot = repoWithCommit(join(dir, 'harbor-meta'));
    git(leadRoot, ['remote', 'add', 'origin', 'https://example.invalid/harbor.git']);
    // The controls: read before the root is registered.
    expect(checkoutBranch(leadRoot)).not.toBeNull();
    const common = gitCommonDir(leadRoot);
    expect(common).not.toBeNull();
    expect(readOriginUrl(common ?? '')).toBe('https://example.invalid/harbor.git');
    const roots = new BoardSocketRoots(boardSocketRootsPath(join(dir, 'data-meta')));
    roots.set('w-harbor', [leadRoot]);
    const remove = boundFiles.guards.add(roots);
    try {
      expect(checkoutBranch(leadRoot)).toBeNull();
      expect(gitCommonDir(leadRoot)).toBeNull();
      expect(readOriginUrl(common ?? '')).toBeNull();
    } finally {
      remove();
    }
  });

  test('a pipe where a pointer file belongs answers null without blocking', () => {
    const fifo = join(dir, 'pointer');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    // Were the open to wait for a writer, this test would never finish.
    expect(readLine(fifo, /^(.*)$/s)).toBeNull();
    // The control: a regular file with the same line reads.
    writeFileSync(join(dir, 'plain'), 'gitdir: x\n');
    expect(readLine(join(dir, 'plain'), /^gitdir:\s*(.+?)\s*$/m)).toBe('x');
  });
});

describe('repositories git itself would read', () => {
  test('finds a folder, a worktree, a separate git folder and a linked .git', () => {
    const main = repoWithCommit(join(dir, 'main'));
    expect(repoOf(main)).toEqual({ top: main, gitDirs: [join(main, '.git')] });
    const wt = join(dir, 'wt');
    git(main, ['worktree', 'add', '-q', wt, '-b', 'wt']);
    expect(repoOf(join(wt, 'deeper'))).toEqual({
      top: wt,
      gitDirs: [join(main, '.git', 'worktrees', 'wt'), join(main, '.git')],
    });
    const linked = join(dir, 'linked');
    mkdirSync(linked);
    symlinkSync(join(main, '.git'), join(linked, '.git'));
    expect(repoOf(linked)).toEqual({ top: linked, gitDirs: [join(main, '.git')] });
    // A .git that is a pipe, or names nothing, is refused.
    const planted = join(dir, 'planted');
    mkdirSync(planted);
    writeFileSync(join(planted, '.git'), `gitdir: ${join(dir, 'nowhere')}\n`);
    expect(repoOf(planted)).toBe('refused');
  });

  test('an ordinary repository still diffs, a separate git folder included, while a lead’s is barred', () => {
    const work = join(dir, 'separate');
    const store = join(dir, 'separate-store.git');
    mkdirSync(work);
    git(work, ['init', '-q', `--separate-git-dir=${store}`]);
    writeFileSync(join(work, 'a.md'), '# a\n');
    git(work, ['add', '.']);
    git(work, [
      '-c',
      'user.name=Alice',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'a',
    ]);
    writeFileSync(join(work, 'a.md'), '# a, edited\n');
    const leadRoot = repoWithCommit(join(dir, 'harbor-lead'));
    // A worktree outside the root whose git folder is the lead's.
    const leadWt = join(dir, 'harbor-lead-wt');
    git(leadRoot, ['worktree', 'add', '-q', leadWt, '-b', 'wt']);
    const roots = new BoardSocketRoots(boardSocketRootsPath(join(dir, 'data-separate')));
    roots.set('w-harbor', [leadRoot]);
    const remove = boundFiles.guards.add(roots);
    try {
      expect(gitBarred(work)).toBe(false);
      const diffed = diffFiles(work, 'HEAD', null);
      expect(diffed.ok, JSON.stringify(diffed)).toBe(true);
      expect(diffed.ok && diffed.files.map((f) => f.relPath)).toEqual(['a.md']);
      expect(gitBarred(leadRoot)).toBe(true);
      expect(gitBarred(leadWt)).toBe(true);
      const linkedIn = join(dir, 'linked-in');
      mkdirSync(linkedIn);
      symlinkSync(join(leadRoot, '.git'), join(linkedIn, '.git'));
      expect(gitBarred(linkedIn)).toBe(true);
    } finally {
      remove();
    }
    // With no project registered nothing is barred.
    expect(gitBarred(leadRoot)).toBe(false);
  });
});
