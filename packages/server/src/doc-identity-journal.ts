/**
 * The migration's own record: what a run filed, and how a revert gives it
 * back.
 *
 * Split out of `doc-identity-migration.ts` when that file crossed 500 lines.
 * The seam is the one the run itself commits across — the journal and the
 * registry are written together at the end of `applyPlan`, and the revert
 * reads this file to decide what it may take back — so everything that
 * touches the record lives here and the apply pass keeps the corpus walk.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyClaim, Merge } from './doc-identity-plan.ts';
import type { RepoRegistry } from './repo-registry.ts';

export const JOURNAL_FILE = 'doc-identity-migration.json';

export interface JournalEntry {
  ranAt: number;
  /** What the plan intended, for a person reading the record. */
  claims: KeyClaim[];
  /**
   * The keys THIS RUN actually wrote — canonical keys it filed and aliases it
   * recorded, and nothing else.
   *
   * `revert` releases exactly these. It used to release everything the plan
   * named, which meant a revert deleted the identity of any file the live
   * server had claimed in the meantime, and the next bind from a second
   * checkout minted the duplicate this whole feature exists to prevent. A
   * journal from before this field releases nothing, which is the safe
   * direction to fail in.
   */
  keysFiled: string[];
  merges: Array<Merge & { copied: number; reanchored: number; orphaned: number; skipped: number }>;
  unresolved: string[];
}

export interface Journal {
  version: number;
  runs: JournalEntry[];
}

export function readJournal(dataDir: string): Journal {
  const path = join(dataDir, JOURNAL_FILE);
  if (!existsSync(path)) return { version: 1, runs: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Journal;
    if (!parsed || !Array.isArray(parsed.runs)) return { version: 1, runs: [] };
    return parsed;
  } catch {
    return { version: 1, runs: [] };
  }
}

export function writeJournal(dataDir: string, journal: Journal): void {
  const path = join(dataDir, JOURNAL_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(journal, null, 2), { mode: 0o600 });
  writeFileSync(path, readFileSync(tmp));
}

export interface RevertResult {
  released: number;
  runs: number;
  /** Conversations copied into a winner are LEFT there — see below. */
  mergesLeftInPlace: number;
}

/**
 * Undo the identity half.
 *
 * Every key this migration claimed is released, so the corpus is back to
 * where it was: ids unchanged, comments unchanged, no key pointing anywhere.
 *
 * The copied conversations are deliberately left. Undoing a copy means
 * DELETING threads, and by then somebody may have replied on one — the reply
 * would be the thing destroyed. The losing document still holds its own
 * originals, so nothing is lost by leaving the copies; re-running the
 * migration skips them by id rather than duplicating them. The journal
 * records which merges those were, so a person can act on any of them by
 * hand.
 */
export function revert(dataDir: string, registry: RepoRegistry): RevertResult {
  const journal = readJournal(dataDir);
  const out: RevertResult = { released: 0, runs: journal.runs.length, mergesLeftInPlace: 0 };
  // Only the keys a run actually wrote, and each of them once. Releasing what
  // the PLAN named would delete a claim the live server made in the meantime,
  // and a document that silently loses its key is a duplicate on the next
  // bind. Two runs over one corpus name the same key twice, so count keys.
  const released = new Set<string>();
  const snapshot = registry.snapshot();
  registry.beginBatch();
  try {
    for (const run of journal.runs) {
      for (const key of run.keysFiled ?? []) {
        if (released.has(key)) continue;
        registry.releaseKey(key);
        released.add(key);
      }
      out.mergesLeftInPlace += run.merges.length;
    }
  } catch (err) {
    registry.restore(snapshot);
    throw err;
  }
  out.released = released.size;
  journal.runs = [];
  // Same order as `applyPlan`, for the same reason: a journal cleared before
  // the release lands means the keys stay filed, which is the direction that
  // loses nothing. The reverse would release keys twice, and the second pass
  // could take one the live server had re-claimed in between.
  writeJournal(dataDir, journal);
  registry.endBatch();
  return out;
}
