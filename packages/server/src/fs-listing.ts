import { join } from 'node:path';
import { scanFolderPaths, scanFolderPathsAsync } from './fs-scan.ts';
import { realPathUnder } from './safe-path.ts';

/**
 * Which files of a folder bind may be opened: the listing `fs-scan.ts`
 * produces, cached per root, and the checks that read it.
 *
 * Split out of `fs-scan.ts` when the cache stopped running `git` on the
 * request path (below, at `cachedListing`).
 */

/**
 * Is `relPath` one of the files the tree SHOWS for `root`?
 *
 * The all-files tree is `scanFolderPaths(root)` — `git ls-files --cached
 * --others --exclude-standard` in a repo — so an ignored file never appears
 * in it, and on top of that the credential names never do either
 * (`isCredentialShapedName`), because `--others` lists untracked files and an
 * un-ignored `.env` is one. OUTSIDE a repo the listing falls back to a
 * recursive readdir, which has no ignore file to honour; there the floor
 * widens to every dotfile as well (`isSecretShapedName`).
 * `openContextFile` / `openEditableFile` used to accept any path that
 * merely existed under the root, which let a caller who knew the name open
 * `.env` or a credentials dump the tree had deliberately hidden; and a
 * review root is a whole repository, reachable by a share visitor.
 * (Urgent-fixes ticket, 2026-09-02.) The rule is now the tree's rule: a path
 * opens only if the listing contains it.
 *
 * Anything under `.git/` is refused before the listing is consulted. Git
 * never lists its own directory, but a rescan is a subprocess and `.git`
 * holds the one thing (config, hooks, packed refs) that should never need
 * one to be refused.
 *
 * Cached per root so this is not a subprocess per request: a hit is served
 * from the cached listing, rescanned in the background once it is
 * `LISTING_TTL_MS` old (`cachedListing`), and a MISS on a listing older
 * than `MISS_RESCAN_MS` rescans once before answering — a file created a
 * moment ago (an agent writing while the reviewer clicks) is found rather
 * than refused for the rest of the window. A miss on a fresh listing stays a
 * miss, which bounds a hammering caller to one subprocess per
 * `MISS_RESCAN_MS` per root.
 */
export function isListedFile(
  root: string,
  relPath: string,
  include: readonly string[] = [],
): boolean {
  if (relPath.split('/').includes('.git')) return false;
  const now = Date.now();
  const key = listingKey(root, include);
  let entry = cachedListing(key, root, include, now);
  if (entry.paths.has(relPath)) return true;
  if (now - entry.at >= MISS_RESCAN_MS) entry = refreshListing(key, root, include, now);
  return entry.paths.has(relPath);
}

/**
 * The paths `isListedFile` admits for `root`, from the same cache, which may
 * be a few seconds old. For a caller that has to search the listing
 * rather than ask about one path, such as turning a member's docId back into
 * the file it names.
 */
export function listedFiles(root: string, include: readonly string[] = []): ReadonlySet<string> {
  return cachedListing(listingKey(root, include), root, include, Date.now()).paths;
}

/**
 * Whether the file `clean` really serves is one the set shows. Git lists a
 * symlink under its own name, so the listing, the exclude and the credential
 * floor had judged only the link: `clip.mp4 -> .env`, with `.env` ignored,
 * passed every check and streamed `.env` (security review, 2026-10-18). The
 * file it lands on must be inside the root AND pass the same rules itself.
 * A link to a listed file stays allowed — it reaches nothing the tree does
 * not already show. `not-listed` rather than a reason naming the target, so
 * a hidden target's existence is not told.
 *
 * One rule for every path that reads a set's file: the request paths in
 * `doc-store-workspaces.ts`, and the two that read at bind time — a browse
 * bind's entry and a working-tree diff's members (`bind-diff.ts`), which
 * read through the link before any request asked (security review,
 * 2026-10-19). `excludes` are normalized, as `normalizeExcludes` gives them.
 */
export function landsOnListed(
  root: string,
  clean: string,
  abs: string,
  excludes: readonly string[],
  include: readonly string[] = [],
): 'ok' | 'bad-path' | 'not-listed' {
  const target = realPathUnder(root, abs);
  if (target === null) return 'bad-path';
  if (target === clean) return 'ok';
  if (excludes.some((p) => target === p || target.startsWith(`${p}/`))) return 'not-listed';
  return isListedFile(root, target, include) ? 'ok' : 'not-listed';
}

/**
 * A browse bind's entry doc: the root README, else the first markdown, else
 * the first file of `sorted`, skipping each one `landsOnListed` refuses. The
 * entry binds before any request could ask, so it needs the check itself.
 * `entry` is undefined when every file was refused.
 */
export function browseEntry(
  root: string,
  sorted: readonly string[],
  excludes: readonly string[],
  include: readonly string[] = [],
): { entry: string | undefined; refused: string[] } {
  const candidates = new Set([
    ...sorted.filter((r) => r.toLowerCase() === 'readme.md'),
    ...sorted.filter((r) => r.toLowerCase().endsWith('.md')),
    ...sorted,
  ]);
  const refused: string[] = [];
  for (const rel of candidates) {
    if (landsOnListed(root, rel, join(root, rel), excludes, include) === 'ok') {
      return { entry: rel, refused };
    }
    refused.push(rel);
  }
  return { entry: undefined, refused };
}

/** A set's include is part of its listing, so it is part of the cache key:
 *  two sets on one root with different includes list different files. */
function listingKey(root: string, include: readonly string[]): string {
  return include.length === 0 ? root : `${root}\0${include.join('\0')}`;
}

function cachedListing(
  key: string,
  root: string,
  include: readonly string[],
  now: number,
): { at: number; paths: Set<string> } {
  const entry = listingCache.get(key);
  if (!entry) return refreshListing(key, root, include, now);
  // A stale listing still answers, and the rescan runs beside the request
  // rather than in front of it. Every diff or folder page opened more than
  // five seconds after the last one used to run `git ls-files` synchronously
  // inside its first request (51 ms on this repo's 3,656 files, idle), holding
  // every other request on the server for the length of it. A HIT on a stale
  // listing is a file that was listed seconds ago; the open after it reads
  // the file off the main thread and finds it gone if it is. A MISS still
  // rescans before refusing (`isListedFile`).
  if (now - entry.at > LISTING_TTL_MS) refreshInBackground(key, root, include);
  return entry;
}

/** Keys with a background rescan in flight, so a burst of stale hits starts one. */
const refreshing = new Set<string>();

function refreshInBackground(key: string, root: string, include: readonly string[]): void {
  if (refreshing.has(key)) return;
  refreshing.add(key);
  const startedAt = Date.now();
  const generation = cacheGeneration;
  scanFolderPathsAsync(root, include)
    .then((paths) => {
      // Dated from when git was asked, and dropped when a newer listing (a
      // miss's own rescan) or a clear landed while it ran.
      const current = listingCache.get(key);
      if (generation !== cacheGeneration || (current && current.at >= startedAt)) return;
      storeListing(key, { at: startedAt, paths: new Set(paths) });
    })
    // A failed rescan keeps the listing it had; the next stale hit tries again.
    .catch(() => {})
    .finally(() => refreshing.delete(key));
}

/** Forget every cached listing. Tests only. */
export function clearListingCache(): void {
  listingCache.clear();
  cacheGeneration++;
}

/** Bumped by a clear, so a rescan started before it cannot repopulate the cache. */
let cacheGeneration = 0;

const LISTING_TTL_MS = 5_000;
const MISS_RESCAN_MS = 250;
const LISTING_CACHE_MAX_ROOTS = 64;
const listingCache = new Map<string, { at: number; paths: Set<string> }>();

function refreshListing(
  key: string,
  root: string,
  include: readonly string[],
  now: number,
): { at: number; paths: Set<string> } {
  return storeListing(key, { at: now, paths: new Set(scanFolderPaths(root, include)) });
}

function storeListing(
  key: string,
  entry: { at: number; paths: Set<string> },
): { at: number; paths: Set<string> } {
  // Re-insert so the Map keeps insertion order as recency; evict the oldest
  // root once too many reviews have been opened on distinct repos.
  listingCache.delete(key);
  listingCache.set(key, entry);
  if (listingCache.size > LISTING_CACHE_MAX_ROOTS) {
    const oldest = listingCache.keys().next().value;
    if (oldest !== undefined) listingCache.delete(oldest);
  }
  return entry;
}
