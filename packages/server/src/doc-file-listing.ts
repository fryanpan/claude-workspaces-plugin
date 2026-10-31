import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isCredentialShapedName } from './fs-scan.ts';
import { gitBarred, hardenedGitArgs, hardenedGitEnv } from './git-hardening.ts';

/**
 * Which files of a framed page's folder git lists, for `routes/doc-files.ts`.
 *
 * Git's listing only, never a directory walk. The files route is open to every
 * reader of a doc, share visitors included, so the rule for what it may read
 * must not depend on where the doc happens to sit:
 *
 *  - the doc's folder must be inside a git work tree. Outside one there is no
 *    ignore file to say what is private, so nothing is listed and nothing is
 *    served. The general folder listing (`fs-listing.ts`) walks such a folder
 *    with `readdir`, synchronously; a doc in a home directory would walk
 *    `Library/`, Dropbox placeholders included.
 *  - a listed file is one `git ls-files --cached --others --exclude-standard`
 *    names under the serving folder, so a gitignored file is never served,
 *    and the credential names git would list as untracked are dropped as
 *    the folder listing drops them.
 *
 * Git runs off the event loop (`execFile`), one run per folder at a time,
 * killed past `LISTING_LIMITS.ms` and refused past `LISTING_LIMITS.bytes` of
 * output; a refused or failed run lists nothing.
 *
 * A miss asks the disk before it asks git: a path that does not exist is
 * refused from the listing it has, so a visitor asking for `nope-<n>.json`
 * starts no rescan. Only a file that exists and is missing from a listing
 * older than `LISTING_AGES.missRescanMs` rescans, which is how a file written a moment
 * ago is found.
 */

/** The bound on one git run; an object so a test can lower it. */
export const LISTING_LIMITS = { ms: 10_000, bytes: 8 * 1024 * 1024 };
/**
 * How old a listing may get. Past `freshMs` a hit still answers and a rescan
 * starts beside it; past `maxAgeMs` a hit waits for the rescan; a miss on a
 * file that exists rescans a listing older than `missRescanMs`. An object so
 * a test can lower them.
 */
export const LISTING_AGES = { freshMs: 5_000, maxAgeMs: 30_000, missRescanMs: 1_000 };
const MAX_FOLDERS = 64;

interface Listing {
  at: number;
  /** Null when git would not list the folder: not a work tree, failed, or too large. */
  paths: ReadonlySet<string> | null;
  /** Changes only when the listed paths change. */
  generation: number;
}

const listings = new Map<string, Listing>();
const inflight = new Map<string, Promise<Listing>>();
let nextGeneration = 1;
let scans = 0;

/** How many git runs have started since boot; read by the tests. */
export const listingScanCount = (): number => scans;

/** Forget every listing. Tests only. */
export function clearDocFileListings(): void {
  listings.clear();
}

const keyOf = (dir: string, folder: string[]): string => `${dir}\0${folder.join('/')}`;

/** Paths relative to `dir`, as git names them, or null when git would not list. */
function gitList(dir: string, folder: string[]): Promise<Set<string> | null> {
  if (gitBarred(dir)) return Promise.resolve(null);
  const args = ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  args.push('--', `:(literal)${folder.join('/')}/`);
  return new Promise((resolve) => {
    execFile(
      'git',
      hardenedGitArgs(args),
      {
        env: hardenedGitEnv(),
        encoding: 'utf8',
        maxBuffer: LISTING_LIMITS.bytes,
        timeout: LISTING_LIMITS.ms,
        killSignal: 'SIGKILL',
      },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const out = new Set<string>();
        for (const rel of stdout.split('\0')) {
          if (rel !== '' && !isCredentialShapedName(rel.split('/').pop() ?? rel)) out.add(rel);
        }
        resolve(out);
      },
    );
  });
}

const sameSet = (a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): boolean =>
  a === b || (a !== null && b !== null && a.size === b.size && [...a].every((p) => b.has(p)));

function rescan(dir: string, folder: string[]): Promise<Listing> {
  const key = keyOf(dir, folder);
  const running = inflight.get(key);
  if (running) return running;
  scans++;
  const at = Date.now();
  const run = gitList(dir, folder)
    .then((paths) => {
      const prev = listings.get(key);
      const generation = prev && sameSet(prev.paths, paths) ? prev.generation : nextGeneration++;
      const next = { at, paths, generation };
      listings.delete(key);
      listings.set(key, next);
      while (listings.size > MAX_FOLDERS) {
        const oldest = listings.keys().next().value;
        if (oldest === undefined) break;
        listings.delete(oldest);
      }
      return next;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

async function listing(dir: string, folder: string[]): Promise<Listing> {
  const entry = listings.get(keyOf(dir, folder));
  const now = Date.now();
  if (!entry || now - entry.at > LISTING_AGES.maxAgeMs) return rescan(dir, folder);
  if (now - entry.at > LISTING_AGES.freshMs) void rescan(dir, folder);
  return entry;
}

/**
 * Whether git lists `rel` (segments under `dir` joined with `/`) under the
 * serving folder `folder`. See the header for when a miss rescans.
 */
export async function isGitListed(dir: string, folder: string[], rel: string): Promise<boolean> {
  const got = await listing(dir, folder);
  if (got.paths === null) return false;
  if (got.paths.has(rel)) return true;
  const exists = await lstat(join(dir, rel)).then(
    () => true,
    () => false,
  );
  if (!exists || Date.now() - got.at < LISTING_AGES.missRescanMs) return false;
  return (await rescan(dir, folder)).paths?.has(rel) ?? false;
}

/** The current listing's generation for a folder, or 0 when none is held. */
export const listingGeneration = (dir: string, folder: string[]): number =>
  listings.get(keyOf(dir, folder))?.generation ?? 0;
