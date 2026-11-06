/**
 * A walled lead's repository is kept warm too.
 *
 * Diff reviews of a walled lead's own repository have worked since PR 1509.
 * In such a repository git cannot run synchronously (`gitBarred`), so the
 * listing a request builds itself is a readdir walk of the whole folder on
 * the server's one thread. Its background rescan runs contained git, so it
 * reads nothing on that thread. Keep-warm skipped these roots anyway, because
 * the request's walk had marked them "not listed by git". So a reader who
 * spent 30s on one markdown file paid a full walk on the next one.
 */
import { afterAll, afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardSocketRoots, boardSocketRootsPath } from '../src/board-socket-roots.ts';
import {
  clearListingCache,
  isListedFile,
  listedFiles,
  listingAge,
  warmListings,
} from '../src/fs-listing.ts';
import { clearRepoKinds } from '../src/fs-scan.ts';
import { gitBarred } from '../src/git-hardening.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { waitFor } from './wait-for.ts';

const DARWIN = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
/** Past the listing's five-second freshness window. */
const PAST_TTL_MS = 6_000;

const top = realpathSync(mkdtempSync(join(tmpdir(), 'fs-listing-walled-')));
const roots = new BoardSocketRoots(boardSocketRootsPath(join(top, 'data')), undefined, undefined, {
  home: join(top, 'home'),
  uid: 4242,
  realpath: (p) => realpathSync.native(p),
});
const remove = boundFiles.guards.add(roots);
afterAll(() => {
  remove();
  rmSync(top, { recursive: true, force: true });
});
afterEach(() => {
  setSystemTime();
  clearListingCache();
});

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
}

/** A walled root holding a committed doc and a folder git ignores. */
function walledRepo(): string {
  const root = join(top, 'harborlight');
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, '.gitignore'), 'data/\n');
  writeFileSync(join(root, 'docs', 'plan.md'), '# Harborlight plan\n');
  writeFileSync(join(root, 'data', 'Riverbend.md'), '# ignored by git\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Alice',
    '-c',
    'user.email=alice@example.invalid',
    'commit',
    '-qm',
    's',
  );
  expect(roots.set('w-1', [root]).ok).toBe(true);
  return root;
}

describe.skipIf(!DARWIN)('the listing of a walled lead’s repository', () => {
  it('is kept warm by contained git once a request has read it', async () => {
    clearRepoKinds();
    const root = walledRepo();
    expect(gitBarred(root)).toBe(true);

    const t0 = Date.now();
    // The first request has no listing to answer from, so it walks the folder.
    // A walk has no ignore file, which is how this control tells it from git.
    expect(isListedFile(root, 'docs/plan.md')).toBe(true);
    expect(listedFiles(root).has('data/Riverbend.md')).toBe(true);

    // The reader is still reading: no request, only the keep-warm tick.
    setSystemTime(new Date(t0 + PAST_TTL_MS));
    expect(warmListings()).toBe(1);
    setSystemTime();
    await waitFor(() => listingAge(root, t0 + PAST_TTL_MS) === 0, {
      describe: 'the background rescan stored its listing',
    });
    // Contained git listed it, so the ignored folder is gone from the listing.
    expect(listedFiles(root).has('data/Riverbend.md')).toBe(false);
    expect(isListedFile(root, 'docs/plan.md')).toBe(true);

    // And the root stays warm: the next tick past the window rescans again.
    setSystemTime(new Date(t0 + 2 * PAST_TTL_MS));
    expect(warmListings()).toBe(1);
  });
});
