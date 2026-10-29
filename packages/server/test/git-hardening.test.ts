import { beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanFolderPaths } from '../src/fs-scan.ts';
import { hardenedGitArgs } from '../src/git-hardening.ts';
import { classifyExternalContent } from '../src/git-provenance.ts';

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
