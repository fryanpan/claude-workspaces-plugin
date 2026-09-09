import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';
import {
  type DocRow,
  type KeyClaim,
  type Merge,
  type Plan,
  type PlanIo,
} from './doc-identity-plan.ts';
import { gitRenameOf } from './doc-identity-renames.ts';
import { readAllDocIndexes } from './doc-index.ts';
import { docKeyForPath } from './doc-key.ts';
import { type ThreadMergeResult, mergeThreads } from './doc-thread-merge.ts';
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

function writeJournal(dataDir: string, journal: Journal): void {
  const path = join(dataDir, JOURNAL_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(journal, null, 2), { mode: 0o600 });
  writeFileSync(path, readFileSync(tmp));
}

const ydocPath = (dataDir: string, docId: string): string => join(dataDir, `${docId}.ydoc`);

function loadYdoc(dataDir: string, docId: string): Y.Doc | null {
  const path = ydocPath(dataDir, docId);
  if (!existsSync(path)) return null;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(readFileSync(path)));
  } catch {
    return null;
  }
  return doc;
}

function saveYdoc(dataDir: string, docId: string, doc: Y.Doc): void {
  const path = ydocPath(dataDir, docId);
  const tmp = `${path}.migrating`;
  writeFileSync(tmp, Y.encodeStateAsUpdate(doc));
  writeFileSync(path, readFileSync(tmp));
}

export interface ApplyResult {
  /** Keys this run filed. A second run over the same corpus files none. */
  claimed: number;
  /**
   * Keys somebody already held when this run started — this doc from an
   * earlier run, or another doc. Either way the claim is left alone: `claim`
   * is first-wins and never repoints.
   */
  alreadyHeld: number;
  aliased: number;
  merged: number;
  threadsCopied: number;
  threadsOrphaned: number;
  threadsSkipped: number;
  /**
   * Keys the plan meant for one doc that another doc already held — a bind
   * that happened between the corpus being read and the run. The key stays
   * with its holder, and the planned doc's conversation is merged INTO the
   * holder, so the document the key opens is never the one without the
   * comments.
   */
  conflicts: number;
  /**
   * Aliases refused because the old and new keys belong to different docs.
   * Recording one would repoint every link saved against the old key.
   */
  aliasesRefused: number;
  /** Documents whose `.ydoc` could not be read. Nothing is written for one. */
  unreadable: number;
  parity: Array<{ docKey: string; before: number; after: number }>;
}

/**
 * File the claims and copy the conversations.
 *
 * Idempotent by construction: `claim` is first-wins and never repoints, and a
 * thread already present under its own id is skipped. Running it twice
 * reports the same shape with nothing left to do.
 */
export function applyPlan(
  dataDir: string,
  plan: Plan,
  registry: RepoRegistry,
  /**
   * How a losing document's conversation is copied into the winner. A
   * parameter only so a test can hand in a merger that loses a thread and
   * watch the parity assertion below refuse the run — the assertion is the
   * one thing here that cannot be checked by reading what came out, because
   * a run it should have stopped writes a corpus that looks fine.
   */
  mergeInto: (from: Y.Doc, into: Y.Doc) => ThreadMergeResult = mergeThreads,
): ApplyResult {
  const out: ApplyResult = {
    claimed: 0,
    alreadyHeld: 0,
    aliased: 0,
    conflicts: 0,
    aliasesRefused: 0,
    merged: 0,
    threadsCopied: 0,
    threadsOrphaned: 0,
    threadsSkipped: 0,
    unreadable: 0,
    parity: [],
  };
  /** Keys this run wrote, and the only ones a revert may take back. */
  const keysFiled: string[] = [];
  /** Who actually holds each key after the claims — not always the plan's pick. */
  const holderOf = new Map<string, string>();
  const conflicted: Array<{ docKey: string; planned: string; holder: string }> = [];
  registry.beginBatch();
  try {
    for (const claim of plan.claims) {
      // Read the holder BEFORE claiming: `claim` answers with the docId that
      // ends up holding the key, which is the same answer whether this run
      // filed it or an earlier one did — and telling those apart is what says
      // a second run changed nothing, and what keeps a revert off a claim
      // this run did not make.
      const holder = registry.docIdFor(claim.docKey);
      if (holder === undefined) {
        registry.claim(claim.docKey, claim.docId);
        keysFiled.push(claim.docKey);
        holderOf.set(claim.docKey, claim.docId);
        out.claimed++;
      } else {
        holderOf.set(claim.docKey, holder);
        out.alreadyHeld++;
        if (holder !== claim.docId) {
          out.conflicts++;
          conflicted.push({ docKey: claim.docKey, planned: claim.docId, holder });
        }
      }
      for (const old of claim.aliasKeys) {
        const res = registry.aliasKey(old, claim.docKey);
        if (!res.ok) {
          out.aliasesRefused++;
          continue;
        }
        if (res.aliased) {
          keysFiled.push(old);
          out.aliased++;
        }
      }
    }
  } finally {
    registry.endBatch();
  }

  // A merge follows the KEY, not the plan's pick. If a doc claimed the key
  // between the corpus being read and this run, that doc is what the key
  // opens, so it is the doc every conversation has to end up in — including
  // the planned winner's own.
  const effective: Merge[] = plan.merges.map((merge) => {
    const winner = holderOf.get(merge.docKey) ?? merge.winner;
    return {
      docKey: merge.docKey,
      winner,
      losers: [...merge.losers, merge.winner].filter((id) => id !== winner),
    };
  });
  const planned = new Set(plan.merges.map((m) => m.docKey));
  for (const c of conflicted) {
    // A key with one planned doc and a different holder is not in plan.merges
    // — the planner saw one document for it — but it is a merge now.
    if (planned.has(c.docKey)) continue;
    effective.push({ docKey: c.docKey, winner: c.holder, losers: [c.planned] });
  }

  const journalMerges: JournalEntry['merges'] = [];
  for (const merge of effective) {
    const winner = loadYdoc(dataDir, merge.winner);
    if (!winner) {
      out.unreadable++;
      continue;
    }
    const before = threadCount(winner);
    let incoming = 0;
    const totals = { copied: 0, reanchored: 0, orphaned: 0, skipped: 0 };
    for (const loserId of merge.losers) {
      const loser = loadYdoc(dataDir, loserId);
      if (!loser) {
        out.unreadable++;
        continue;
      }
      incoming += threadCount(loser);
      const res = mergeInto(loser, winner);
      totals.copied += res.copied;
      totals.reanchored += res.reanchored;
      totals.orphaned += res.orphaned;
      totals.skipped += res.skipped;
    }
    const after = threadCount(winner);
    // The parity assertion, made per merge rather than in aggregate: every
    // thread that existed is still addressable, in the winner or as an
    // outdated one in it. `skipped` is a thread the winner already had under
    // the same id — the same conversation, counted once.
    if (after !== before + incoming - totals.skipped) {
      throw new Error(
        `[migrate-doc-identity] parity failed for ${merge.docKey}: ${before} + ${incoming} incoming (${totals.skipped} already present) became ${after}`,
      );
    }
    saveYdoc(dataDir, merge.winner, winner);
    out.merged++;
    out.threadsCopied += totals.copied;
    out.threadsOrphaned += totals.orphaned;
    out.threadsSkipped += totals.skipped;
    out.parity.push({ docKey: merge.docKey, before: before + incoming, after });
    journalMerges.push({ ...merge, ...totals });
  }

  const journal = readJournal(dataDir);
  journal.runs.push({
    ranAt: Date.now(),
    claims: plan.claims,
    keysFiled,
    merges: journalMerges,
    unresolved: plan.unresolved,
  });
  writeJournal(dataDir, journal);
  return out;
}

function threadCount(doc: Y.Doc): number {
  return (doc.getMap('threads') as Y.Map<unknown>).size;
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
  } finally {
    registry.endBatch();
  }
  out.released = released.size;
  journal.runs = [];
  writeJournal(dataDir, journal);
  return out;
}

/** The io the real run uses: the data dir, the filesystem, and git. */
export function liveIo(dataDir: string): PlanIo {
  return {
    rows: () => {
      const out: DocRow[] = [];
      for (const [docId, entry] of readAllDocIndexes(dataDir)) {
        const ydoc = ydocPath(dataDir, docId);
        let mtime = 0;
        try {
          mtime = existsSync(ydoc) ? Number(Bun.file(ydoc).lastModified) : 0;
        } catch {
          mtime = 0;
        }
        out.push({
          docId,
          type: String(entry.meta.type ?? ''),
          ...(entry.meta.sourceUrl ? { sourceUrl: entry.meta.sourceUrl } : {}),
          lastActivityAt: Math.max(entry.lastThreadActivityAt ?? 0, mtime),
          threads: entry.threads?.total ?? 0,
        });
      }
      return out;
    },
    keyFor: (absPath) => {
      const parts = docKeyForPath(absPath);
      if (!parts) return null;
      return { repoKey: parts.repoKey, relPath: parts.relPath, docKey: parts.docKey };
    },
    exists: (absPath) => existsSync(absPath),
    renamedTo: (absPath, relPath) => gitRenameOf(absPath, relPath),
  };
}

export function reportLines(plan: Plan, applied?: ApplyResult): string[] {
  const c = plan.counts;
  const lines = [
    `index rows                     ${c.rows}`,
    `  with a sourceUrl             ${c.withSourceUrl}`,
    `    prose (claims a key)       ${c.prose}`,
    `    set-addressed (diff/mock)  ${c.setAddressed}`,
    `mapped by sourceUrl            ${c.bySourceUrl}`,
    `mapped by rename               ${c.byRename}`,
    `left unresolved                ${c.unresolved}`,
    `distinct keys                  ${c.distinctKeys}`,
    `keys held by more than one doc ${c.duplicateKeys} (${c.docsInMerges} docs)`,
  ];
  if (applied) {
    lines.push(
      '',
      `claims filed                   ${applied.claimed}`,
      `keys already held              ${applied.alreadyHeld}`,
      `rename aliases                 ${applied.aliased}`,
      `  refused, keys held apart     ${applied.aliasesRefused}`,
      `keys held by another doc       ${applied.conflicts} (merged into the holder)`,
      `documents merged into          ${applied.merged}`,
      `threads copied                 ${applied.threadsCopied}`,
      `  landed as outdated           ${applied.threadsOrphaned}`,
      `  already present, skipped     ${applied.threadsSkipped}`,
      `unreadable .ydoc               ${applied.unreadable}`,
      `parity checks passed           ${applied.parity.length}`,
    );
  }
  return lines;
}
