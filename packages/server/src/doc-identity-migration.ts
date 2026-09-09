import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listThreads, readDocMeta } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { type JournalEntry, readJournal, writeJournal } from './doc-identity-journal.ts';
import { type DocRow, type Merge, type Plan, type PlanIo } from './doc-identity-plan.ts';
import { gitRenameOf } from './doc-identity-renames.ts';
import {
  DOC_INDEX_VERSION,
  type DocIndexEntry,
  readAllDocIndexes,
  readDocIndex,
  writeDocIndex,
} from './doc-index.ts';
import { docKeyForPath } from './doc-key.ts';
import { type ThreadMergeResult, mergeThreads } from './doc-thread-merge.ts';
import type { RepoRegistry } from './repo-registry.ts';

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

/**
 * Write a merged document temp-then-RENAME.
 *
 * The copy-over-the-original version had a window where a failure left a
 * TRUNCATED `.ydoc` — the durable record of somebody's document, the one
 * thing in this whole run that cannot be rebuilt from anywhere else. A
 * rename is atomic: the file is either the document as it was or the document
 * with the conversations in it.
 */
function saveYdoc(dataDir: string, docId: string, doc: Y.Doc): void {
  const path = ydocPath(dataDir, docId);
  const tmp = `${path}.migrating`;
  writeFileSync(tmp, Y.encodeStateAsUpdate(doc));
  renameSync(tmp, path);
}

/**
 * Bring a document's index row back in line with the `.ydoc` this run just
 * rewrote.
 *
 * The `.ydoc` is the durable record and the row is a cache of it, but the
 * board's badges, `listFromIndex` and a lazy boot all read the row — so a
 * winner that gained twenty threads would keep reporting its old total until
 * something unrelated wrote to it, which for a document nobody opens is
 * never. The counts are recomputed exactly as `indexEntryFor` computes them.
 *
 * Only an EXISTING row is refreshed. A document with no row is one no listing
 * reads, and minting a row for it here would be this script inventing state
 * rather than repairing it.
 */
function refreshIndexRow(dataDir: string, docId: string, doc: Y.Doc): boolean {
  const existing = readDocIndex(dataDir, docId);
  if (!existing) return false;
  const threads = listThreads(doc);
  let open = 0;
  let lastThreadActivityAt: number | undefined;
  for (const t of threads) {
    if (t.status === 'open') open++;
    for (const c of t.comments) {
      if (lastThreadActivityAt === undefined || c.ts > lastThreadActivityAt) {
        lastThreadActivityAt = c.ts;
      }
    }
  }
  const entry: DocIndexEntry = {
    v: DOC_INDEX_VERSION,
    // The row's own meta, not the `.ydoc`'s: the row carries server-side
    // fields (`docKey`, `liveCheckout`) that the CRDT meta does not, and a
    // merge changes none of them.
    meta: existing.meta ?? readDocMeta(doc),
    threads: { open, total: threads.length },
    ...(lastThreadActivityAt !== undefined ? { lastThreadActivityAt } : {}),
    ...(existing.pendingFileWrite ? { pendingFileWrite: true } : {}),
  };
  writeDocIndex(dataDir, docId, entry);
  return true;
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
  /**
   * Claims NOT filed because the document they would point at cannot be read.
   *
   * A key is a promise that it opens a document. Filing one for a `.ydoc`
   * that is missing or corrupt makes the key a dead end that first-writer-
   * wins will never let anything else take, so the claim is refused, its
   * merge is left undone, and the pair is reported by name for a person to
   * look at.
   */
  refusedClaims: Array<{ docKey: string; docId: string }>;
  /** Index rows brought back in line with a `.ydoc` this run rewrote. */
  indexRowsRefreshed: number;
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
    refusedClaims: [],
    indexRowsRefreshed: 0,
    parity: [],
  };
  // The record is read BEFORE anything is touched. A journal that exists and
  // cannot be read stops the run here — no claim filed, no `.ydoc` rewritten —
  // rather than after the corpus has already moved.
  const journalBefore = readJournal(dataDir);

  /** Each document loaded at most once: the validation pass below reads every
   *  winner, and the merge loop would otherwise read them all again. */
  const loaded = new Map<string, Y.Doc | null>();
  const load = (docId: string): Y.Doc | null => {
    if (!loaded.has(docId)) loaded.set(docId, loadYdoc(dataDir, docId));
    return loaded.get(docId) ?? null;
  };

  // Validate BEFORE touching the registry. A claim is filed first-writer-wins
  // and is never repointed, so filing one for a document that turns out to be
  // unreadable leaves the key permanently pointing at nothing — and the run
  // that would notice happens after the write. Reading every winner up front
  // costs one load each, which the merge loop then reuses.
  const refused = new Set<string>();
  for (const claim of plan.claims) {
    if (load(claim.docId)) continue;
    refused.add(claim.docKey);
    out.refusedClaims.push({ docKey: claim.docKey, docId: claim.docId });
  }

  /** Keys this run wrote, and the only ones a revert may take back. */
  const keysFiled: string[] = [];
  /** Who actually holds each key after the claims — not always the plan's pick. */
  const holderOf = new Map<string, string>();
  const conflicted: Array<{ docKey: string; planned: string; holder: string }> = [];
  // ONE commit point for the whole run. The claims used to be persisted the
  // moment they were filed, so a merge that failed parity left the registry
  // holding keys the journal never recorded — filed, unrevertable, and
  // pointing at documents whose conversations had not been copied. The batch
  // now stays open across the merges: the journal is written first, the
  // registry is persisted after it, and any throw restores the snapshot below
  // and writes nothing at all.
  const before = registry.snapshot();
  registry.beginBatch();
  try {
    for (const claim of plan.claims) {
      if (refused.has(claim.docKey)) continue;
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
  } catch (err) {
    registry.restore(before);
    throw err;
  }

  // A merge follows the KEY, not the plan's pick. If a doc claimed the key
  // between the corpus being read and this run, that doc is what the key
  // opens, so it is the doc every conversation has to end up in — including
  // the planned winner's own.
  const effective: Merge[] = plan.merges
    .filter((merge) => !refused.has(merge.docKey))
    .map((merge) => {
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
  try {
    runMerges(dataDir, effective, mergeInto, out, journalMerges, load);
  } catch (err) {
    // The `.ydoc` merges that already landed stay: copying a conversation is
    // additive and a re-run skips what is already there, so the corpus is
    // consistent either way. The registry is what must not survive a refused
    // run, because a filed key with no journal entry cannot be given back.
    registry.restore(before);
    throw err;
  }

  // Journal FIRST, then the registry. Between the two writes the safe
  // direction to fail is a journal naming keys that were never filed —
  // releasing one is a no-op — rather than filed keys nothing can release.
  //
  // Both writes are inside the rollback: a run whose record cannot be written
  // must not leave keys filed, and a run whose keys cannot be filed must not
  // leave a record saying they were.
  try {
    writeJournal(dataDir, {
      ...journalBefore,
      runs: [
        ...journalBefore.runs,
        {
          ranAt: Date.now(),
          claims: plan.claims,
          keysFiled,
          merges: journalMerges,
          unresolved: plan.unresolved,
        },
      ],
    });
  } catch (err) {
    registry.restore(before);
    throw err;
  }
  try {
    registry.endBatch();
  } catch (err) {
    registry.restore(before);
    // Put the record back the way it was. If even this fails the journal is
    // left naming keys that were never filed, which releases as a no-op —
    // still the safe direction, and now said out loud.
    try {
      writeJournal(dataDir, journalBefore);
    } catch (undoErr) {
      console.error(
        '[migrate-doc-identity] the registry write failed and the journal entry could not be taken back; it names keys that were never filed:',
        undoErr,
      );
    }
    throw err;
  }
  return out;
}

/**
 * The merge half, lifted out so `applyPlan` reads as what it now is: file the
 * claims, merge, then commit both records together.
 */
function runMerges(
  dataDir: string,
  effective: Merge[],
  mergeInto: (from: Y.Doc, into: Y.Doc) => ThreadMergeResult,
  out: ApplyResult,
  journalMerges: JournalEntry['merges'],
  load: (docId: string) => Y.Doc | null,
): void {
  for (const merge of effective) {
    const winner = load(merge.winner);
    if (!winner) {
      out.unreadable++;
      continue;
    }
    const before = threadCount(winner);
    let incoming = 0;
    // Recorded before anything is copied, and kept in the journal: the check
    // that runs days later must not have to trust the losers' later contents.
    const loserThreadIds: string[] = [];
    const totals = { copied: 0, reanchored: 0, orphaned: 0, skipped: 0 };
    for (const loserId of merge.losers) {
      const loser = load(loserId);
      if (!loser) {
        out.unreadable++;
        continue;
      }
      incoming += threadCount(loser);
      for (const t of listThreads(loser)) loserThreadIds.push(t.id);
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
    try {
      if (refreshIndexRow(dataDir, merge.winner, winner)) out.indexRowsRefreshed++;
    } catch (err) {
      // A row is a cache of the `.ydoc`, which is already written. Failing to
      // refresh it is worth saying and not worth losing the run over.
      console.error('[migrate-doc-identity] could not refresh the index row for a winner:', err);
    }
    out.merged++;
    out.threadsCopied += totals.copied;
    out.threadsOrphaned += totals.orphaned;
    out.threadsSkipped += totals.skipped;
    out.parity.push({ docKey: merge.docKey, before: before + incoming, after });
    journalMerges.push({ ...merge, ...totals, loserThreadIds });
  }
}

function threadCount(doc: Y.Doc): number {
  return (doc.getMap('threads') as Y.Map<unknown>).size;
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
      `claims refused, doc unreadable ${applied.refusedClaims.length}`,
      `index rows refreshed           ${applied.indexRowsRefreshed}`,
      `parity checks passed           ${applied.parity.length}`,
    );
  }
  return lines;
}
