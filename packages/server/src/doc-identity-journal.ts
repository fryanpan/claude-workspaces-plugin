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
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/**
 * The journal, or a THROW.
 *
 * No file is an empty journal: that is the first run. A file that exists and
 * does not parse is not — it is the only record of what earlier runs filed,
 * and reading it as empty is how the next apply or revert overwrites it. The
 * keys those runs claimed would then be filed with nothing able to release
 * them, which is precisely the state the journal exists to prevent.
 *
 * So a present-but-unreadable journal stops the run and names itself. Moving
 * it aside by hand is a person's decision, the same one `repo-registry.ts`
 * makes for a corrupt registry — and unlike that file, this one is only ever
 * read by a script somebody is watching.
 */
export function readJournal(dataDir: string): Journal {
  const path = join(dataDir, JOURNAL_FILE);
  if (!existsSync(path)) return { version: 1, runs: [] };
  let parsed: Journal;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Journal;
  } catch (err) {
    throw new Error(
      `[migrate-doc-identity] ${path} exists but did not parse (${String(err)}). It is the only record of what earlier runs filed; move it aside deliberately if you mean to start over.`,
    );
  }
  if (!parsed || !Array.isArray(parsed.runs)) {
    throw new Error(
      `[migrate-doc-identity] ${path} exists but has no "runs" array. It is the only record of what earlier runs filed; move it aside deliberately if you mean to start over.`,
    );
  }
  return parsed;
}

/**
 * Write the journal temp-then-RENAME.
 *
 * It used to write the temp file and then copy its bytes over the real one,
 * which leaves a window where the journal on disk is half a file — and a half
 * a journal is exactly the state `readJournal` now refuses to run over. A
 * rename is atomic, so the file is either the old journal or the new one.
 */
export function writeJournal(dataDir: string, journal: Journal): void {
  const path = join(dataDir, JOURNAL_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(journal, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
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
  // Release FIRST, and only clear the record once it landed. `endBatch` now
  // throws when the write fails, so a failure here is a state we can see: put
  // the registry back and leave the journal untouched, which is a revert that
  // did nothing rather than a revert that lost its own record. Clearing first
  // would leave nothing able to release those keys on the retry.
  try {
    registry.endBatch();
  } catch (err) {
    registry.restore(snapshot);
    throw err;
  }
  journal.runs = [];
  writeJournal(dataDir, journal);
  return out;
}
