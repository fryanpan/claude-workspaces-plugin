/**
 * The git-only listing behind a framed page's folder: no directory walk, a
 * capped git run, and no rescan for a path that does not exist.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LISTING_AGES,
  LISTING_LIMITS,
  clearDocFileListings,
  isGitListed,
  listingGeneration,
  listingScanCount,
} from '../src/doc-file-listing.ts';

describe('isGitListed', () => {
  let root: string;
  let repo: string;
  let loose: string;
  const saved = { ...LISTING_AGES, ...LISTING_LIMITS };
  const write = (abs: string, text = 'x') => {
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'doc-file-listing-'));
    repo = join(root, 'repo');
    loose = join(root, 'loose');
    mkdirSync(repo);
    spawnSync('git', ['init', '-q'], { cwd: repo });
    write(join(repo, '.gitignore'), 'map/secret.json\n');
    write(join(repo, 'map', 'app.js'));
    write(join(repo, 'map', 'secret.json'));
    write(join(repo, 'outside.json'));
    write(join(loose, 'map', 'app.js'));
  });
  beforeEach(() => clearDocFileListings());
  afterEach(() => {
    Object.assign(LISTING_AGES, {
      freshMs: saved.freshMs,
      maxAgeMs: saved.maxAgeMs,
      missRescanMs: saved.missRescanMs,
    });
    Object.assign(LISTING_LIMITS, { ms: saved.ms, bytes: saved.bytes });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('lists what git lists under the folder, and not an ignored or outside file', async () => {
    expect(await isGitListed(repo, ['map'], 'map/app.js')).toBe(true);
    expect(await isGitListed(repo, ['map'], 'map/secret.json')).toBe(false);
    expect(await isGitListed(repo, ['map'], 'outside.json')).toBe(false);
  });

  it('lists nothing outside a git work tree, rather than walking the folder', async () => {
    expect(await isGitListed(loose, ['map'], 'map/app.js')).toBe(false);
  });

  it('lists nothing when git says more than the cap', async () => {
    LISTING_LIMITS.bytes = 4;
    expect(await isGitListed(repo, ['map'], 'map/app.js')).toBe(false);
  });

  it('starts no rescan for a path that does not exist, however stale the listing', async () => {
    expect(await isGitListed(repo, ['map'], 'map/app.js')).toBe(true);
    LISTING_AGES.missRescanMs = 0;
    const before = listingScanCount();
    for (let n = 0; n < 20; n++) {
      expect(await isGitListed(repo, ['map'], `map/nope-${n}.json`)).toBe(false);
    }
    expect(listingScanCount()).toBe(before);
  });

  it('rescans for a file that exists and is missing from a stale listing, and finds it', async () => {
    expect(await isGitListed(repo, ['map'], 'map/app.js')).toBe(true);
    const generation = listingGeneration(repo, ['map']);
    write(join(repo, 'map', 'late.json'));
    LISTING_AGES.missRescanMs = 0;
    const before = listingScanCount();
    expect(await isGitListed(repo, ['map'], 'map/late.json')).toBe(true);
    expect(listingScanCount()).toBe(before + 1);
    expect(listingGeneration(repo, ['map'])).not.toBe(generation);
  });

  it('keeps the generation while the listed paths stay the same', async () => {
    expect(await isGitListed(repo, ['map'], 'map/app.js')).toBe(true);
    const generation = listingGeneration(repo, ['map']);
    LISTING_AGES.maxAgeMs = -1;
    expect(await isGitListed(repo, ['map'], 'map/app.js')).toBe(true);
    expect(listingGeneration(repo, ['map'])).toBe(generation);
  });
});
