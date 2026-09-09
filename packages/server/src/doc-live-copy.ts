import type { DocMeta } from '@claude-workspaces/core';
import { type CopySurvey, candidatesOf, surveyCopies } from './doc-copies.ts';
import { parseDocKey } from './doc-key.ts';
import type { RepoRegistry } from './repo-registry.ts';

/**
 * Turning a survey of a file's copies into a decision about one document:
 * which copy it is bound to, whether to say the others have drifted, and when
 * to refuse and ask.
 *
 * Kept apart from `doc-copies.ts` on purpose. That module only LOOKS — it
 * writes nothing and can be run against any repo — and this one is the half
 * that changes a document. The split is what let the survey be tested
 * exhaustively against real worktrees without a doc store in the picture.
 *
 * Deliberately NOT on the per-flush path. The flush guard for a doc pinned to
 * an origin repo (`originRepoGuard`) is cheap by construction — stat and
 * plumbing-file reads, no subprocess and no file bodies — and this is not: it
 * hashes every copy of the file. So it runs where a decision is actually being
 * made — a bind, a status read, a checkout being retired — and the binding it
 * leaves behind is what the flush path then uses, unchanged.
 */

export interface LiveCopyHost {
  meta(docId: string): DocMeta | undefined;
  registry: RepoRegistry;
  /** Where the doc is bound right now, if anywhere. */
  boundPath(docId: string): string | undefined;
  /** Move the binding to a different copy of the same file. */
  retarget(docId: string, absPath: string): void;
  /** Write the doc's meta through to its sidecar. */
  persistMeta(docId: string): void;
  /** When we last wrote this doc's file ourselves, in epoch ms. */
  lastFlushAt(docId: string): number | undefined;
  now(): number;
}

export type LiveCopyResult =
  | {
      ok: true;
      /** The copy the doc is now bound to, or null when no copy exists
       *  anywhere — which parks the doc rather than failing it. */
      live: string | null;
      retargeted: boolean;
      /** Checkout roots whose copy differs from the live one. */
      drift: string[];
      survey: CopySurvey;
    }
  | {
      ok: false;
      error: 'ambiguous-copy';
      candidates: ReturnType<typeof candidatesOf>;
      survey: CopySurvey;
    }
  | { ok: false; error: 'no-key' };

export interface ResolveOpts {
  /**
   * The checkout the caller has PICKED, answering an earlier
   * `ambiguous-copy`.
   *
   * A pick settles the call it is made on, and the choice is recorded as the
   * doc's live checkout — but it is NOT a standing answer. If the two copies
   * are edited concurrently again, the next question is asked again, because
   * that is new evidence rather than a decision already taken. The cost of
   * the other rule is silent: a stale pick would keep writing into one
   * checkout while somebody worked in the other.
   */
  checkout?: string;
  /** Skip the git-status column. On by default for the same reason the
   *  survey makes it opt-in: it is a subprocess per copy. */
  withGitStatus?: boolean;
}

/**
 * Decide which copy of a repo+path doc is live, and record what we found.
 *
 * Three outcomes, and the third is the one the row is about:
 *
 * - one obvious copy: bind to it, note any drift, done.
 * - no copy anywhere: park. The `.ydoc` is still the durable record, so
 *   nothing is lost and the doc recovers when a checkout reappears.
 * - two copies edited at once with different bytes: **refuse and ask.**
 *   Picking the larger mtime would be right most of the time, and being
 *   right most of the time is exactly what makes the wrong answer expensive
 *   — the person never finds out they were guessed at.
 */
export function resolveLiveCopy(
  host: LiveCopyHost,
  docId: string,
  opts: ResolveOpts = {},
): LiveCopyResult {
  const meta = host.meta(docId);
  // The registry is the authority; `meta.docKey` is the copy a freshly
  // minted doc carries. A doc migrated onto a key has the second and not the
  // first, and rewriting every one of them to say what the table already
  // knows would be six thousand writes for nothing.
  const docKey = meta?.docKey ?? host.registry.primaryKeyFor(docId);
  if (!docKey || !meta) return { ok: false, error: 'no-key' };
  const parsed = parseDocKey(docKey);
  if (!parsed) return { ok: false, error: 'no-key' };

  const boundPath = host.boundPath(docId);
  const lastAt = host.lastFlushAt(docId);
  const surveyOpts: Parameters<typeof surveyCopies>[4] = {};
  if (opts.withGitStatus) surveyOpts.withGitStatus = true;
  if (boundPath !== undefined && lastAt !== undefined) {
    const from = meta.liveCheckout;
    if (from !== undefined) surveyOpts.lastFlush = { root: from, at: lastAt };
  }
  const survey = surveyCopies(host.registry, parsed.repoKey, parsed.relPath, docKey, surveyOpts);

  // A pick overrides the survey's verdict — that is what a pick IS — but only
  // if the checkout it names actually holds a copy. A pick of a checkout with
  // no file would silently park the doc, which is not what the person chose.
  const picked = opts.checkout ? survey.copies.find((c) => c.root === opts.checkout) : undefined;

  if (!picked && survey.ambiguous && survey.ambiguityReason === 'concurrent-edits') {
    return {
      ok: false,
      error: 'ambiguous-copy',
      candidates: candidatesOf(survey),
      survey,
    };
  }

  const live = picked ?? survey.live;
  const drifted = live
    ? survey.copies.filter((c) => c.root !== live.root && c.sha !== null && c.sha !== live.sha)
    : [];

  let changed = false;
  const nextLive = live?.root;
  if (meta.liveCheckout !== nextLive) {
    meta.liveCheckout = nextLive;
    changed = true;
  }

  // Drift rows keep the moment each checkout was FIRST seen to differ, so a
  // long-running disagreement does not look new on every read.
  const before = meta.driftCheckouts ?? [];
  const now = host.now();
  const nextDrift = drifted.map((c) => ({
    root: c.root,
    firstSeenAt: before.find((d) => d.root === c.root)?.firstSeenAt ?? now,
  }));
  if (JSON.stringify(before) !== JSON.stringify(nextDrift)) {
    meta.driftCheckouts = nextDrift.length > 0 ? nextDrift : undefined;
    // A TRANSITION into drift, not an observation of it: the counter answers
    // "how often does this happen", and incrementing per read would answer
    // "how often did anyone look".
    if (before.length === 0 && nextDrift.length > 0) {
      meta.driftFirings = (meta.driftFirings ?? 0) + 1;
    }
    changed = true;
  }

  let retargeted = false;
  if (live && boundPath !== undefined && boundPath !== live.path) {
    host.retarget(docId, live.path);
    retargeted = true;
  }
  if (changed) host.persistMeta(docId);

  return {
    ok: true,
    live: live?.path ?? null,
    retargeted,
    drift: drifted.map((c) => c.root),
    survey,
  };
}
