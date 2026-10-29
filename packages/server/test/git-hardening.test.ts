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
import { scanFolderPaths } from '../src/fs-scan.ts';
import { gitBarred, gitDirRefused, hardenedGitArgs } from '../src/git-hardening.ts';
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

describe('no git at all under a root a lead bound', () => {
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
    const remove = boundFiles.guards.add({
      covers: (path) => path === repo || path.startsWith(`${repo}/`),
      admits: () => true,
      landsInside: () => true,
    });
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

describe('a .git that leads somewhere planted', () => {
  test('refuses a gitdir file pointing outside, and a link; keeps a worktree and a folder', () => {
    const main = join(dir, 'main');
    mkdirSync(main);
    git(main, ['init', '-q']);
    git(main, [
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
    expect(gitDirRefused(main)).toBe(false);
    const wt = join(dir, 'wt');
    git(main, ['worktree', 'add', '-q', wt, '-b', 'wt']);
    expect(gitDirRefused(wt)).toBe(false);
    expect(gitDirRefused(join(wt, 'deeper'))).toBe(false);

    const planted = join(dir, 'planted');
    mkdirSync(planted);
    writeFileSync(join(planted, '.git'), `gitdir: ${join(dir, 'elsewhere')}\n`);
    expect(gitDirRefused(planted)).toBe(true);
    expect(gitBarred(join(planted, 'notes.md'))).toBe(true);

    const linked = join(dir, 'linked');
    mkdirSync(linked);
    symlinkSync(join(main, '.git'), join(linked, '.git'));
    expect(gitDirRefused(linked)).toBe(true);
  });
});
