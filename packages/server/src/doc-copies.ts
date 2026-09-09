import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutBranch } from './doc-origin-repo.ts';
import type { RepoRegistry } from './repo-registry.ts';

/**
 * One file, several checkouts: which copy is live, which have drifted, and
 * when the answer is a question rather than a value.
 *
 * Identity stopped being the path (`doc-key.ts`), which means a doc can now
 * see more than one copy of itself. That is the point — a review started on a
 * branch keeps its comments when the branch lands — but it forces three
 * questions the old one-path binding never had to ask.
 *
 * **Which copy do we write to.** The one edited most recently, counting our
 * own last flush as an edit. Anything else picks a stale copy the moment a
 * person switches checkouts, and "the checkout I am working in" is exactly
 * what "edited most recently" means in practice.
 *
 * **Has another copy drifted.** Advisory, never blocking: the copies are
 * allowed to differ (that is what a branch IS), and the flag exists so a
 * reviewer is told rather than surprised. Counted per firing, so "this
 * happens constantly" and "this happened once" are different facts.
 *
 * **Is the answer ambiguous.** Two copies edited inside the same window with
 * different bytes is not a race we should win by picking the larger mtime —
 * a hundred milliseconds is not evidence about which one a person meant. So
 * the survey says `ambiguous` and the caller asks, rather than guessing and
 * being right most of the time.
 */

/**
 * How close two edits must be before "most recent" stops being an answer.
 *
 * Not a debounce and deliberately not one of the scaled doc cadences: this is
 * about two PEOPLE (or a person and an agent) touching two checkouts, and it
 * wants to be generous. Ten seconds apart is a sequence; a second apart is a
 * coincidence nobody should have their file picked by.
 */
export const AMBIGUOUS_WINDOW_MS = 10_000;

/** Ceiling on the whole `uncommitted` sweep, and on any single git call in
 *  it. Same discipline and the same reasons as `git-provenance.ts`: budget
 *  plus SIGKILL, because `timeout` alone sends a signal and keeps waiting. */
const GIT_BUDGET_MS = 1_000;
const GIT_CALL_TIMEOUT_MS = 300;

export interface CopySighting {
  /** The checkout root this copy lives in. */
  root: string;
  /** Branch checked out there, or null when detached. */
  branch: string | null;
  /** Absolute path of this copy. */
  path: string;
  /** Modification time, or 0 when the copy does not exist. */
  mtimeMs: number;
  /** sha256 of the bytes, or null when the copy does not exist or is
   *  unreadable. Two copies with the same hash have not drifted, whatever
   *  their mtimes say. */
  sha: string | null;
  /** Does this copy differ from what git has committed there? Only filled in
   *  when the survey was asked for candidates — it costs a subprocess. */
  uncommitted?: boolean;
}

export interface CopySurvey {
  docKey: string;
  relPath: string;
  /** Every checkout of the repo that currently holds this file. */
  copies: CopySighting[];
  /** The copy to read from and write to, or null when no copy exists. */
  live: CopySighting | null;
  /** Copies that exist and differ from the live one. */
  drift: CopySighting[];
  /**
   * True when picking a live copy would be a guess. The caller must ask
   * rather than write — see `ambiguityReason` for what to tell the person.
   */
  ambiguous: boolean;
  ambiguityReason?: 'concurrent-edits' | 'no-copy-anywhere';
}

function hashOf(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Is this copy different from the committed content in its own checkout?
 *
 * `git status --porcelain` over ONE path, with `GIT_*` stripped from the
 * environment for the reason `git-provenance.ts` gives — an inherited
 * `GIT_DIR` would ask the wrong repository and answer confidently. A failure
 * of any kind is `undefined` rather than false: "we do not know" and "it is
 * clean" must not be the same value on a screen that asks somebody to choose.
 */
function isUncommitted(
  root: string,
  relPath: string,
  remainingMs: () => number,
): boolean | undefined {
  const left = remainingMs();
  if (left <= 0) return undefined;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_') && v !== undefined) env[k] = v;
  }
  try {
    const res = spawnSync('git', ['status', '--porcelain', '--', relPath], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: Math.min(GIT_CALL_TIMEOUT_MS, left),
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    });
    if (res.status !== 0 || typeof res.stdout !== 'string') return undefined;
    return res.stdout.trim() !== '';
  } catch {
    return undefined;
  }
}

export interface SurveyOpts {
  /**
   * When WE last wrote a copy ourselves, and where. A flush is an edit: a doc
   * whose own write-back just landed in checkout A must not read checkout B
   * as fresher merely because a `git checkout` there touched an mtime.
   */
  lastFlush?: { root: string; at: number };
  /** Fill in `uncommitted` on every sighting. Costs one git call per copy, so
   *  it is asked for on the ambiguity path and refused on the flush path. */
  withGitStatus?: boolean;
  /** Override for tests; defaults to `AMBIGUOUS_WINDOW_MS`. */
  windowMs?: number;
  /**
   * Checkout roots to leave out of the survey.
   *
   * For the one case where a copy exists and still must not be chosen: a
   * checkout being retired. Its files are all still on disk at the moment the
   * caller says it is going away — that is the whole point of announcing the
   * removal first — so without this the survey would pick the copy that is
   * about to vanish and the binding would be moved nowhere.
   */
  exclude?: string[];
}

/**
 * Look at every checkout of the repo and describe the copies of one file.
 *
 * Pure observation — it writes nothing, flags nothing on the doc, and makes
 * no decision the caller cannot overrule. `doc-store` turns the verdict into
 * a binding, a drift counter, or a refusal.
 */
export function surveyCopies(
  registry: RepoRegistry,
  repoKey: string,
  relPath: string,
  docKey: string,
  opts: SurveyOpts = {},
): CopySurvey {
  const windowMs = opts.windowMs ?? AMBIGUOUS_WINDOW_MS;
  const deadline = Date.now() + GIT_BUDGET_MS;
  const remaining = (): number => Math.max(0, deadline - Date.now());

  const copies: CopySighting[] = [];
  const excluded = new Set(opts.exclude ?? []);
  for (const root of registry.checkoutsFor(repoKey)) {
    if (excluded.has(root)) continue;
    const path = join(root, relPath);
    const mtimeMs = mtimeOf(path);
    if (mtimeMs === 0) continue; // no copy here
    const sighting: CopySighting = {
      root,
      branch: checkoutBranch(root),
      path,
      mtimeMs,
      sha: hashOf(path),
    };
    if (opts.withGitStatus) {
      sighting.uncommitted = isUncommitted(root, relPath, remaining);
    }
    copies.push(sighting);
  }

  if (copies.length === 0) {
    return {
      docKey,
      relPath,
      copies,
      live: null,
      drift: [],
      ambiguous: true,
      ambiguityReason: 'no-copy-anywhere',
    };
  }

  // Our own flush counts as an edit of the copy we wrote, whatever the
  // filesystem says about the others.
  const effectiveMtime = (c: CopySighting): number =>
    opts.lastFlush && opts.lastFlush.root === c.root
      ? Math.max(c.mtimeMs, opts.lastFlush.at)
      : c.mtimeMs;

  const ranked = [...copies].sort((a, b) => effectiveMtime(b) - effectiveMtime(a));
  const live = ranked[0] as CopySighting;
  const drift = copies.filter((c) => c !== live && c.sha !== null && c.sha !== live.sha);

  // Ambiguous only when a rival is BOTH recent and different. A copy that is
  // byte-identical is not a rival however fresh its mtime — nothing turns on
  // which of two identical files we write to, and treating that as a question
  // would stop the common case (a worktree just created from the same commit)
  // dead.
  const rivals = ranked
    .slice(1)
    .filter(
      (c) => c.sha !== live.sha && Math.abs(effectiveMtime(live) - effectiveMtime(c)) <= windowMs,
    );

  const survey: CopySurvey = {
    docKey,
    relPath,
    copies,
    live,
    drift,
    ambiguous: rivals.length > 0,
  };
  if (rivals.length > 0) survey.ambiguityReason = 'concurrent-edits';
  return survey;
}

/** The candidate rows an ambiguity refusal shows a person, newest first. */
export function candidatesOf(survey: CopySurvey): Array<{
  root: string;
  branch: string | null;
  relPath: string;
  path: string;
  mtimeMs: number;
  sha: string | null;
  uncommitted?: boolean;
}> {
  return [...survey.copies]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((c) => {
      const row: {
        root: string;
        branch: string | null;
        relPath: string;
        path: string;
        mtimeMs: number;
        sha: string | null;
        uncommitted?: boolean;
      } = {
        root: c.root,
        branch: c.branch,
        relPath: survey.relPath,
        path: c.path,
        mtimeMs: c.mtimeMs,
        // The first twelve characters are enough for a person to tell two
        // copies apart, and the whole digest on a screen is noise.
        sha: c.sha === null ? null : c.sha.slice(0, 12),
      };
      if (c.uncommitted !== undefined) row.uncommitted = c.uncommitted;
      return row;
    });
}
