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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearListingCache, isListedFile, listedFiles } from '../src/fs-listing.ts';
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
});
