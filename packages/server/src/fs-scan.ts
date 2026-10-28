import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isUnsupportedType } from './folder-file-types.ts';
import { realPathUnder } from './safe-path.ts';

/** Filesystem scanning + file-type gating for folder binds. */

/**
 * Enumerate the files in `root`. Prefer `git ls-files` (cached + untracked,
 * honoring .gitignore) so node_modules/dist/etc are skipped for free; fall
 * back to a recursive readdir with a hardcoded skip set when the folder
 * isn't inside a git repo or git isn't available. Returns absolute paths.
 *
 * Both modes carry a floor, and they are not the same floor. See
 * `isListedFile` — this listing IS the rule for what a share visitor may
 * open, so a name that gets past here is a name a visitor can read.
 *
 * The GIT mode filters `isCredentialShapedName`: `--exclude-standard` honours
 * the ignore files, but `--others` lists UNTRACKED files, so an `.env`,
 * `.npmrc` or `id_rsa` sitting in a checkout that simply never ignored it is
 * listed and served. That is the same credential-leaving-the-box failure the
 * fallback's floor was added for, on the mode the doc called the safe one.
 *
 * The FALLBACK filters the wider `isSecretShapedName` — every dotfile on top
 * of the credential names — because out there no ignore file was ever
 * consulted. That wider rule is deliberately NOT applied to the git mode: a
 * repo's dotfiles are tracked content somebody chose to commit and a reviewer
 * has to be able to read (`.github/workflows`, `.claude/rules`, `.gitignore`
 * itself), and hiding them would break the diff review rather than protect
 * anything.
 *
 * `include` names files to list even though the repository ignores them
 * (`admitIncluded`); the floors above still apply to them.
 */
export function scanFolder(root: string, include: readonly string[] = []): string[] {
  const files = listFolder(root, null);
  if (include.length === 0) return files;
  const listed = new Set(files);
  for (const abs of admitIncluded(root, include).files) {
    if (!listed.has(abs)) files.push(abs);
  }
  return files;
}

/** A file the scan left out, and the word for why. */
export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

/**
 * Why a scan left a file out. `gitignored` is the repository's own ignore
 * rules; `credential-name` and `hidden` are the floors described above;
 * `skipped-directory` is the fallback's build-output set; `not-a-regular-file`
 * is a symlink, socket or device the fallback does not follow; and
 * `unsupported-type` is a binary nothing in the review can show
 * (`folder-file-types.ts`). A directory left out whole carries a trailing `/`.
 * `not-found` and `bad-path` are an `include` entry naming nothing on disk,
 * or a path outside the folder; `over-include-limit` is one past
 * `MAX_INCLUDE`.
 */
export type SkipReason =
  | 'gitignored'
  | 'credential-name'
  | 'hidden'
  | 'skipped-directory'
  | 'not-a-regular-file'
  | 'unsupported-type'
  | 'not-found'
  | 'bad-path'
  | 'over-include-limit';

/** At most this many `include` entries are looked at; the rest are refused. */
export const MAX_INCLUDE = 1000;

/** At most this many skipped rows are named; `skippedTotal` counts them all. */
export const MAX_SKIPPED = 200;

/**
 * `scanFolder`, plus every file it left out and why, as repo-relative paths.
 *
 * A bind used to answer `skipped: []` whatever the scan dropped, so a folder
 * whose recordings were gitignored reported two files and nothing missing.
 * The ignored half costs a second `git ls-files`, which is why the listing
 * the share rule reads (`isListedFile`) does not ask for it.
 */
export function scanFolderReport(
  root: string,
  include: readonly string[] = [],
): {
  files: string[];
  skipped: SkippedFile[];
  skippedTotal: number;
} {
  let skipped: SkippedFile[] = [];
  const files = listFolder(root, skipped);
  if (include.length > 0) {
    const admitted = admitIncluded(root, include);
    const listed = new Set(files);
    const admittedRel = new Set<string>();
    for (const abs of admitted.files) {
      admittedRel.add(relative(root, abs).split(sep).join('/'));
      if (!listed.has(abs)) files.push(abs);
    }
    // A refused include's own reason replaces the row the scan wrote for it:
    // "gitignored" is no longer why an asked-for file is out.
    const refused = new Set(admitted.skipped.map((row) => row.path));
    skipped = skipped.filter((row) => !admittedRel.has(row.path) && !refused.has(row.path));
    skipped.push(...admitted.skipped);
  }
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped: skipped.slice(0, MAX_SKIPPED), skippedTotal: skipped.length };
}

/**
 * The listing. `-z` is load-bearing: without it git C-quotes every path
 * holding a byte above 0x7f, so a macOS screenshot (U+202F before "PM") was
 * listed as `"Screenshot … 3.04.12\342\200\257PM.png"`, quotes included —
 * counted, shown, and naming no file on disk.
 */
function listFolder(root: string, skipped: SkippedFile[] | null): string[] {
  try {
    const res = gitLsFiles(root, ['--cached', '--others', '--exclude-standard']);
    if (res !== null) {
      const out: string[] = [];
      for (const rel of res) {
        const name = rel.split('/').pop() ?? rel;
        const reason = isCredentialShapedName(name)
          ? 'credential-name'
          : isUnsupportedType(name)
            ? 'unsupported-type'
            : null;
        if (reason) skipped?.push({ path: rel, reason });
        else out.push(join(root, rel));
      }
      if (skipped) {
        // `--directory` names an ignored directory once rather than every
        // file under it, so a repo's node_modules is one row, not thousands.
        const ignored = gitLsFiles(root, [
          '--others',
          '--ignored',
          '--exclude-standard',
          '--directory',
        ]);
        for (const rel of ignored ?? []) skipped.push({ path: rel, reason: 'gitignored' });
      }
      return out;
    }
  } catch {
    // git missing or threw — fall through to readdir.
  }
  return readdirRecursive(root, root, skipped);
}

/**
 * The files of `include` that may be listed although the repository ignores
 * them, and every entry that may not, with why.
 *
 * An include is the owner's agent saying "this one, by name": a folder of
 * screen recordings is gitignored by every repo that keeps them, and without
 * this the only way to show one was to edit the ignore file. It widens
 * nothing else. Each entry names one file, not a directory or a pattern; the
 * credential names and every dotted path stay refused, as does a binary the
 * review cannot show, and a symlink is never followed, so an include cannot
 * reach outside the folder or behind one of the floors above.
 *
 * Called from the bind and from `isListedFile`'s cached rescan, never per
 * request: `lstatSync` is synchronous, like the `git` subprocess beside it.
 */
export function admitIncluded(
  root: string,
  include: readonly string[],
): { files: string[]; skipped: SkippedFile[] } {
  const files: string[] = [];
  const skipped: SkippedFile[] = [];
  for (const [i, raw] of include.entries()) {
    if (i >= MAX_INCLUDE) {
      skipped.push({ path: String(raw), reason: 'over-include-limit' });
      continue;
    }
    const rel = normalizeIncludePath(raw);
    if (rel === null) {
      skipped.push({ path: String(raw), reason: 'bad-path' });
      continue;
    }
    const name = rel.split('/').pop() ?? rel;
    const reason = isCredentialShapedName(name)
      ? 'credential-name'
      : rel.split('/').some((seg) => seg.startsWith('.'))
        ? 'hidden'
        : isUnsupportedType(name)
          ? 'unsupported-type'
          : null;
    if (reason) {
      skipped.push({ path: rel, reason });
      continue;
    }
    const abs = join(root, rel);
    let stat: import('node:fs').Stats;
    try {
      stat = lstatSync(abs);
    } catch {
      skipped.push({ path: rel, reason: 'not-found' });
      continue;
    }
    if (!stat.isFile()) skipped.push({ path: rel, reason: 'not-a-regular-file' });
    else files.push(abs);
  }
  return { files, skipped };
}

/** An include entry as a folder-relative POSIX path, or null outside it. */
function normalizeIncludePath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const segs = raw
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.');
  if (raw.startsWith('/') || segs.length === 0 || segs.includes('..')) return null;
  return segs.join('/');
}

/** `git ls-files -z <args>` under `root`, or null when git cannot answer. */
function gitLsFiles(root: string, args: string[]): string[] | null {
  const res = spawnSync('git', ['-C', root, 'ls-files', '-z', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0 || typeof res.stdout !== 'string') return null;
  return res.stdout.split('\0').filter((rel) => rel !== '');
}

/** Repo-relative POSIX paths for every scanned file, sorted. */
export function scanFolderPaths(root: string, include: readonly string[] = []): string[] {
  return scanFolder(root, include)
    .map((abs) => relative(root, abs).split(sep).join('/'))
    .sort();
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage']);

/**
 * Names that hold a credential often enough that neither listing mode may
 * show them — the floor BOTH modes share.
 *
 * The git mode's guarantee is `--exclude-standard`, and it covers exactly the
 * files somebody remembered to ignore. `--others` lists untracked files, so a
 * `.env` written into a checkout that never had a rule for it is listed like
 * any other new file, and `isListedFile` then lets a share visitor open it.
 * The names below are the ones whose contents are a credential by convention
 * rather than by accident, so refusing them costs a reviewer nothing they
 * came for.
 *
 * Kept to NAMES, never contents: a scanner that reads files to guess would
 * open every file in the repo on every rescan, and a miss would still be a
 * credential leaving the box.
 */
function isCredentialShapedName(name: string): boolean {
  const lower = name.toLowerCase();
  // Environment and tool credential files, including their `.env.local` /
  // `.env.production` suffixed forms.
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  if (lower === '.npmrc' || lower === '.netrc' || lower === '.pgpass') return true;
  if (lower === '.htpasswd' || lower === '.pypirc') return true;
  // Key and certificate material, which carries no dot prefix.
  if (lower.endsWith('.pem') || lower.endsWith('.key') || lower.endsWith('.p12')) return true;
  if (lower.endsWith('.pfx') || lower.endsWith('.keystore')) return true;
  // `id_rsa`, `id_ed25519`, and every other ssh private key's default name.
  if (lower.startsWith('id_')) return true;
  return false;
}

/**
 * Filenames the fallback refuses even though nothing ignored them.
 *
 * `isListedFile` is the rule that decides what a share visitor may open, and
 * inside a repo the guarantee behind it is `git ls-files --exclude-standard`
 * plus the credential floor above. Outside a git repo there is no ignore file
 * to honour and no `git` answer to trust, so the fallback widens that floor
 * to every dotfile. It used to have none at all: the dot-prefix test applied
 * to DIRECTORIES only, so a `bind_folder` on a non-repo directory listed
 * `.env`, `.npmrc` and `.netrc` in the tree and `openContextFile` served them.
 *
 * Deliberately conservative rather than clever. A dotfile in a directory
 * nobody has put under version control is far more likely to be configuration
 * than something a reviewer wants to read, and a false refusal here shows up
 * as one missing row in a tree — a visible, harmless failure — while a false
 * admission is a credential leaving the box.
 */
export function isSecretShapedName(name: string): boolean {
  // Every dotfile. `.env`, `.env.local`, `.npmrc`, `.netrc`, `.pgpass`,
  // `.aws/…` (its directory is skipped anyway) — one rule instead of a list
  // that stops being complete.
  if (name.startsWith('.')) return true;
  return isCredentialShapedName(name);
}

function readdirRecursive(root: string, dir: string, skipped: SkippedFile[] | null): string[] {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const name = entry.name;
    const abs = join(dir, name);
    const rel = (): string => relative(root, abs).split(sep).join('/');
    if (entry.isDirectory()) {
      // Skip .git, any dotdir, and the hardcoded heavy dirs.
      if (name.startsWith('.') || SKIP_DIRS.has(name)) {
        // `.git` is the repository's own store, not a file anybody left out.
        if (name !== '.git') {
          const reason = name.startsWith('.') ? 'hidden' : 'skipped-directory';
          skipped?.push({ path: `${rel()}/`, reason });
        }
        continue;
      }
      out.push(...readdirRecursive(root, abs, skipped));
    } else if (entry.isFile()) {
      const reason = isCredentialShapedName(name)
        ? 'credential-name'
        : isSecretShapedName(name)
          ? 'hidden'
          : isUnsupportedType(name)
            ? 'unsupported-type'
            : null;
      if (reason) skipped?.push({ path: rel(), reason });
      else out.push(abs);
    } else {
      skipped?.push({ path: rel(), reason: 'not-a-regular-file' });
    }
  }
  return out;
}

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
 * from a listing up to `LISTING_TTL_MS` old, and a MISS on a listing older
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
 * The paths `isListedFile` admits for `root`, from the same cache: a hit is
 * up to `LISTING_TTL_MS` old. For a caller that has to search the listing
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
  if (!entry || now - entry.at > LISTING_TTL_MS) return refreshListing(key, root, include, now);
  return entry;
}

/** Forget every cached listing. Tests only. */
export function clearListingCache(): void {
  listingCache.clear();
}

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
  const entry = { at: now, paths: new Set(scanFolderPaths(root, include)) };
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
