import { execFile, spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isUnsupportedType } from './folder-file-types.ts';
import { gitBarred, hardenedGitArgs, hardenedGitEnv } from './git-hardening.ts';

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
  return withIncluded(root, listFolder(root, null), include);
}

function withIncluded(root: string, files: string[], include: readonly string[]): string[] {
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
    return listFolderOrThrow(root, skipped);
  } catch (err) {
    if (!(err instanceof GitListingFailed)) throw err;
    // Fail closed: a repo git could not list shows nothing, rather than a
    // readdir that would show every file its ignore rules hide.
    console.error(`[fs-scan] ${err.message}`);
    return [];
  }
}

/**
 * `listFolder`, throwing `GitListingFailed` where it would list nothing, so
 * the listing cache can keep the answer it had (`fs-listing.ts`).
 */
export function listFolderOrThrow(root: string, skipped: SkippedFile[] | null): string[] {
  const res = gitLsFiles(root, LISTING_ARGS);
  if (res !== null) {
    const out = admitGitListed(root, res, skipped);
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
  // The readdir fallback has no ignore file to honour, so it is only for a
  // folder git says is not a repository. A git that failed inside a work tree
  // (a timeout, an exhausted buffer, "dubious ownership") would otherwise
  // list the repo's ignored `service-account.json` and `secrets.yaml`. A
  // root no git may run in (`gitBarred`) is walked, as it always was.
  if (!gitBarred(root) && repoKindSync(root) !== 'not-a-repo') throw new GitListingFailed(root);
  return readdirRecursive(root, root, skipped);
}

/** `git ls-files` failed in a folder that is, or may be, a git work tree. */
export class GitListingFailed extends Error {
  constructor(root: string) {
    super(`git could not list ${root}; listing nothing rather than every file in it`);
  }
}

type RepoKind = 'work-tree' | 'not-a-repo';

// Roots git said are work trees. Only that answer is kept: a `git init` makes
// a folder a repo, and a kept "not a repo" would send it back to readdir.
const repoKinds = new Map<string, 'work-tree'>();

/** What `git rev-parse --is-inside-work-tree` said, or null when it could not say. */
type GitAnswer = { error?: Error | null; status: number | null; stdout?: string; stderr?: string };
function repoKindOf(res: GitAnswer): RepoKind | null {
  // No git on this machine at all: nothing can be a repository to it.
  if ((res.error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') {
    return 'not-a-repo';
  }
  // `false` is a `.git` directory or a bare repository: not a work tree, and
  // not a folder to read whole either.
  if (res.status === 0) return res.stdout?.trim() === 'true' ? 'work-tree' : null;
  if (res.status === 128 && /not a git repository/i.test(res.stderr ?? '')) return 'not-a-repo';
  return null;
}

function repoKindSync(root: string): RepoKind | null {
  const kept = repoKinds.get(root);
  if (kept) return kept;
  const res = spawnSync('git', REV_PARSE(root), gitOptions());
  const kind = repoKindOf(res);
  if (kind === 'work-tree') repoKinds.set(root, kind);
  return kind;
}

async function repoKindAsync(root: string): Promise<RepoKind | null> {
  const kept = repoKinds.get(root);
  if (kept) return kept;
  const kind = await new Promise<RepoKind | null>((resolve) => {
    execFile('git', REV_PARSE(root), gitOptions(), (err, stdout, stderr) => {
      // An exit code is a number; a spawn failure or a kill is not.
      const code: unknown = err ? (err as { code?: unknown }).code : 0;
      const status = typeof code === 'number' ? code : null;
      resolve(repoKindOf({ error: err, status, stdout, stderr }));
    });
  });
  if (kind === 'work-tree') repoKinds.set(root, kind);
  return kind;
}

/** How long any git here may run before it is killed and counts as failed. */
export const GIT_TIMEOUT = { ms: 30_000 };

/** Every git here: hardened (`git-hardening.ts`), and killed past the limit. */
function gitOptions() {
  return {
    env: hardenedGitEnv(),
    encoding: 'utf8' as const,
    maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_TIMEOUT.ms,
    killSignal: 'SIGKILL' as const,
  };
}

const REV_PARSE = (root: string) =>
  hardenedGitArgs(['-C', root, 'rev-parse', '--is-inside-work-tree']);

/** Forget every root's repository answer. Tests only. */
export function clearRepoKinds(): void {
  repoKinds.clear();
}

const LISTING_ARGS = ['--cached', '--others', '--exclude-standard'];

/** The git mode's floor over what `git ls-files` named, as absolute paths. */
function admitGitListed(root: string, rels: string[], skipped: SkippedFile[] | null): string[] {
  const out: string[] = [];
  for (const rel of rels) {
    const name = rel.split('/').pop() ?? rel;
    const reason = isCredentialShapedName(name)
      ? 'credential-name'
      : isUnsupportedType(name)
        ? 'unsupported-type'
        : null;
    if (reason) skipped?.push({ path: rel, reason });
    else out.push(join(root, rel));
  }
  return out;
}

/**
 * `scanFolderPaths` with the `git` subprocess off the event loop, for a
 * listing nobody is waiting on (`fs-listing.ts` refreshes in the background
 * with it). The readdir fallback and the include `lstat`s stay synchronous:
 * a folder outside git is small or slow either way, and it is the subprocess
 * that grows with the repository.
 */
export async function scanFolderPathsAsync(
  root: string,
  include: readonly string[] = [],
): Promise<string[]> {
  const barred = gitBarred(root);
  const rels = barred
    ? null
    : await new Promise<string[] | null>((resolve) => {
        // A hung git is killed (`gitOptions`), so the cache's in-flight mark clears.
        execFile(
          'git',
          hardenedGitArgs(['-C', root, 'ls-files', '-z', ...LISTING_ARGS]),
          gitOptions(),
          (err, stdout) => resolve(err ? null : stdout.split('\0').filter((rel) => rel !== '')),
        );
      });
  let files: string[];
  if (rels !== null) files = admitGitListed(root, rels, null);
  else if (barred || (await repoKindAsync(root)) === 'not-a-repo') {
    files = readdirRecursive(root, root, null);
  }
  // Rejects, so the cache keeps the listing it had (see `listFolderOrThrow`).
  else throw new GitListingFailed(root);
  return toSortedRel(root, withIncluded(root, files, include));
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
  // A control character names no file anybody typed, and a newline in a
  // listed path is how a log line or a header gets forged. C1 controls and
  // the two Unicode line separators break lines too.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(raw)) return null;
  return segs.join('/');
}

/** `git ls-files -z <args>` under `root`, or null when git cannot answer. */
function gitLsFiles(root: string, args: string[]): string[] | null {
  if (gitBarred(root)) return null;
  let res: ReturnType<typeof spawnSync>;
  try {
    res = spawnSync('git', hardenedGitArgs(['-C', root, 'ls-files', '-z', ...args]), gitOptions());
  } catch {
    return null;
  }
  if (res.status !== 0 || typeof res.stdout !== 'string') return null;
  return res.stdout.split('\0').filter((rel) => rel !== '');
}

/** Repo-relative POSIX paths for every scanned file, sorted. */
export function scanFolderPaths(root: string, include: readonly string[] = []): string[] {
  return toSortedRel(root, scanFolder(root, include));
}

/** `scanFolderPaths`, throwing `GitListingFailed` instead of listing nothing. */
export function scanFolderPathsOrThrow(root: string, include: readonly string[] = []): string[] {
  return toSortedRel(root, withIncluded(root, listFolderOrThrow(root, null), include));
}

function toSortedRel(root: string, files: string[]): string[] {
  return files.map((abs) => relative(root, abs).split(sep).join('/')).sort();
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
