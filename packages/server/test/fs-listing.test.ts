/**
 * A stale folder listing answers at once and is rescanned in the background.
 *
 * Every diff or folder page opened more than five seconds after the last one
 * used to run `git ls-files` synchronously inside its first request, holding
 * the server's one thread for it. The tests below tell the two behaviours
 * apart by what the answer says: a file removed after the listing was taken
 * is still admitted by a stale hit (no rescan ran in front of it), and is
 * gone once the background rescan lands. Under the old code the stale hit
 * itself rescanned and refused the file.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearListingCache, isListedFile, listedFiles } from '../src/fs-listing.ts';
import {
  GIT_TIMEOUT,
  GitListingFailed,
  clearRepoKinds,
  scanFolderPaths,
  scanFolderPathsAsync,
} from '../src/fs-scan.ts';
import { waitFor } from './wait-for.ts';

function git(repo: string, ...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

/** Past the listing's five-second freshness window. */
const PAST_TTL_MS = 6_000;
/** Past the thirty-second limit on answering from a stale listing. */
const PAST_MAX_AGE_MS = 31_000;

/** A repo holding one committed file and one ignored credential-ish file. */
function seedRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, 'init', '-q');
  writeFileSync(join(root, '.gitignore'), 'service-account.json\n');
  writeFileSync(join(root, 'service-account.json'), '{"marker":"not a real key"}\n');
  writeFileSync(join(root, 'Harborlight.md'), '# Harborlight\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'seed');
  return root;
}

describe('folder listing cache', () => {
  let root = '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'fs-listing-'));
    git(root, 'init', '-q');
    writeFileSync(join(root, 'Harborlight.md'), '# Harborlight\n');
    writeFileSync(join(root, 'Riverbend.md'), '# Riverbend\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'seed');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(() => setSystemTime());

  it('serves a stale hit from the cache and rescans beside it', async () => {
    clearListingCache();
    expect(isListedFile(root, 'Harborlight.md')).toBe(true);
    git(root, 'rm', '-q', 'Harborlight.md');

    setSystemTime(new Date(Date.now() + PAST_TTL_MS));
    // Still the listing taken before the removal: nothing ran git first.
    expect(isListedFile(root, 'Harborlight.md')).toBe(true);
    setSystemTime();

    await waitFor(() => !listedFiles(root).has('Harborlight.md'));
    expect(listedFiles(root).has('Riverbend.md')).toBe(true);
  });

  it('still rescans before refusing a file the stale listing does not hold', () => {
    clearListingCache();
    expect(isListedFile(root, 'Riverbend.md')).toBe(true);
    writeFileSync(join(root, 'Saltmarsh.md'), '# Saltmarsh\n');

    setSystemTime(new Date(Date.now() + PAST_TTL_MS));
    expect(isListedFile(root, 'Saltmarsh.md')).toBe(true);
  });

  it('refuses a file that was listed and then ignored, once the listing is too old', () => {
    clearListingCache();
    writeFileSync(join(root, 'report.json'), '{}\n');
    expect(isListedFile(root, 'report.json')).toBe(true);
    writeFileSync(join(root, '.gitignore'), 'report.json\n');

    setSystemTime(new Date(Date.now() + PAST_MAX_AGE_MS));
    expect(isListedFile(root, 'report.json')).toBe(false);
  });

  it('a hung git rescan times out, so the next stale hit rescans again', async () => {
    const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
    const fakeBin = mkdtempSync(join(tmpdir(), 'fs-listing-bin-'));
    // ls-files never answers; everything else is the real git.
    writeFileSync(
      join(fakeBin, 'git'),
      `#!/bin/sh\ncase "$*" in *ls-files*) exec sleep 30;; esac\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(fakeBin, 'git'), 0o755);
    // A root of its own: a rescan an earlier test left in flight on the
    // shared one would stand in for the hung one and pass this unproven.
    const repo = seedRepo('fs-listing-hung-');
    const realPath = process.env.PATH;
    const timeout = GIT_TIMEOUT.ms;
    GIT_TIMEOUT.ms = 200;
    try {
      writeFileSync(join(repo, 'Bob.md'), '# Bob\n');
      expect(isListedFile(repo, 'Bob.md')).toBe(true);
      rmSync(join(repo, 'Bob.md'));

      process.env.PATH = `${fakeBin}:${realPath}`;
      setSystemTime(new Date(Date.now() + PAST_TTL_MS));
      listedFiles(repo); // the background rescan that hangs
      setSystemTime();
      process.env.PATH = realPath;

      // Each poll is a fresh stale hit; one starts a rescan only once the
      // hung one has been given up on.
      await waitFor(() => {
        setSystemTime(new Date(Date.now() + PAST_TTL_MS));
        const listed = listedFiles(repo).has('Bob.md');
        setSystemTime();
        return !listed;
      });
    } finally {
      process.env.PATH = realPath;
      GIT_TIMEOUT.ms = timeout;
      rmSync(fakeBin, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('a git that fails inside a work tree', () => {
  let repo = '';
  let plain = '';

  beforeAll(() => {
    repo = seedRepo('fs-listing-broken-');
    // A corrupt index: `ls-files` fails, `rev-parse` still says work tree.
    writeFileSync(join(repo, '.git', 'index'), 'not an index');
    plain = mkdtempSync(join(tmpdir(), 'fs-listing-plain-'));
    mkdirSync(join(plain, 'notes'));
    writeFileSync(join(plain, 'notes', 'Riverbend.md'), '# Riverbend\n');
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  });

  it('lists nothing rather than the files git ignores', () => {
    clearRepoKinds();
    expect(scanFolderPaths(repo)).toEqual([]);
    // Positive control: a folder outside git still lists by readdir.
    expect(scanFolderPaths(plain)).toEqual(['notes/Riverbend.md']);
  });

  it('rejects in the background, so the cache keeps what it had', async () => {
    clearRepoKinds();
    await expect(scanFolderPathsAsync(repo)).rejects.toBeInstanceOf(GitListingFailed);
    expect(await scanFolderPathsAsync(plain)).toEqual(['notes/Riverbend.md']);
  });

  it('asks again once a folder outside git becomes a repository', () => {
    clearRepoKinds();
    const later = mkdtempSync(join(tmpdir(), 'fs-listing-later-'));
    try {
      writeFileSync(join(later, 'Alice.md'), '# Alice\n');
      expect(scanFolderPaths(later)).toEqual(['Alice.md']);
      git(later, 'init', '-q');
      writeFileSync(join(later, '.gitignore'), 'service-account.json\n');
      writeFileSync(join(later, 'service-account.json'), '{"marker":"not a real key"}\n');
      git(later, 'add', '.');
      git(later, 'commit', '-q', '-m', 'seed');
      writeFileSync(join(later, '.git', 'index'), 'not an index');
      expect(scanFolderPaths(later)).toEqual([]);
    } finally {
      rmSync(later, { recursive: true, force: true });
    }
  });
});
