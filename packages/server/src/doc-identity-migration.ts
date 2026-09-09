/**
 * Put the documents that already exist onto repo-and-path identity.
 *
 * WHAT THIS IS FOR. A document's identity is now its repo plus its path from
 * the repo root, held as a claim in the registry (`repos.json`). Documents
 * minted before that have ids and comments and no claim, so a bind from a
 * second checkout would mint a SECOND document for a file that already has
 * one. This walks the corpus and files the claims.
 *
 * WHY IT IS A SCRIPT AND NOT A BOOT STEP. It reads every index row, spawns
 * git for the renames, and hydrates documents to merge conversations. A boot
 * that did that would turn a restart into a corpus walk, and a bug in it
 * would be a bug nobody could stop. It runs by hand, dry by default, and the
 * server never calls it.
 *
 * WHAT IT NEVER DOES. It deletes nothing. A document that loses a key claim
 * keeps its id, its content and every comment on it, and stays reachable at
 * the link somebody saved. A losing document's threads are COPIED into the
 * winner, not moved. Threads whose text is not in the winner land in the
 * outdated-comments flow rather than being dropped, and the count before
 * equals the count after — winner plus orphans (`doc-thread-merge.ts`).
 *
 * WHICH DOCUMENTS CLAIM A KEY. Prose documents — `markdown` and `code` — are
 * the ones whose identity IS a file. A `diff` document is a member of a
 * review set: twenty reviews of one file are twenty documents on purpose, and
 * collapsing them onto one key would destroy nineteen reviews. A `mockup`'s
 * source is an HTML file that is usually outside any repo. Both are counted
 * and reported, and neither claims. This is narrower than "every document
 * with a sourceUrl" and the difference is the whole reason the report prints
 * the classes.
 *
 * The CLI that drives this is `scripts/migrate-doc-identity.ts`; everything
 * here takes its io as a parameter, so importing this module migrates
 * nothing. `--apply` is the only thing that writes, and a second `--apply`
 * changes nothing: the claims are already held, and a thread already present
 * under its own id is skipped.
 */

import { spawnSync } from 'node:child_process';
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
import { readAllDocIndexes } from './doc-index.ts';
import { docKeyForPath } from './doc-key.ts';
import { type ThreadMergeResult, mergeThreads } from './doc-thread-merge.ts';
import type { RepoRegistry } from './repo-registry.ts';

export const JOURNAL_FILE = 'doc-identity-migration.json';

/**
 * How far back a rename scan reads. Deep enough for a file renamed years ago
 * and shallow enough that a repository with a hundred thousand commits does
 * not stall the migration; a rename older than this leaves its document
 * unresolved, which costs the document nothing but a key claim.
 */
const RENAME_SCAN_COMMITS = 20_000;

export interface JournalEntry {
  ranAt: number;
  claims: KeyClaim[];
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
    merged: 0,
    threadsCopied: 0,
    threadsOrphaned: 0,
    threadsSkipped: 0,
    unreadable: 0,
    parity: [],
  };
  registry.beginBatch();
  try {
    for (const claim of plan.claims) {
      // Read the holder BEFORE claiming: `claim` answers with the docId that
      // ends up holding the key, which is the same answer whether this run
      // filed it or an earlier one did — and telling those apart is the whole
      // evidence that a second run changes nothing.
      const holder = registry.docIdFor(claim.docKey);
      registry.claim(claim.docKey, claim.docId);
      if (holder === undefined) out.claimed++;
      else out.alreadyHeld++;
      for (const old of claim.aliasKeys) {
        registry.aliasKey(old, claim.docKey);
        out.aliased++;
      }
    }
  } finally {
    registry.endBatch();
  }

  const journalMerges: JournalEntry['merges'] = [];
  for (const merge of plan.merges) {
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
  // Two runs over one corpus record the same claim twice, so count KEYS, not
  // journal lines: a revert that reported 822 releases of 411 keys reads as
  // twice the change it made.
  const released = new Set<string>();
  registry.beginBatch();
  try {
    for (const run of journal.runs) {
      for (const claim of run.claims) {
        for (const key of [claim.docKey, ...claim.aliasKeys]) {
          if (released.has(key)) continue;
          registry.releaseKey(key);
          released.add(key);
        }
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

/**
 * Every rename this checkout's history records, oldest first, memoized per
 * checkout root.
 *
 * One scan per repository rather than one per document: the corpus holds
 * thousands of rows and spawning git for each of them is the difference
 * between a migration that runs and one nobody waits for. The window is
 * bounded, and so is the wait — a corpus walk cannot afford one repository
 * to hang it.
 */
const renameScans = new Map<string, Map<string, string>>();

/** Forget the memoized scans. For a caller that renames and then asks again. */
export function clearRenameScans(): void {
  renameScans.clear();
}

function renameScanOf(checkoutRoot: string): Map<string, string> {
  const cached = renameScans.get(checkoutRoot);
  if (cached) return cached;
  const map = new Map<string, string>();
  renameScans.set(checkoutRoot, map);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_') && v !== undefined) env[k] = v;
  }
  let stdout = '';
  try {
    const res = spawnSync(
      'git',
      [
        'log',
        '--diff-filter=R',
        '--name-status',
        '--format=',
        '-M',
        `--max-count=${RENAME_SCAN_COMMITS}`,
      ],
      {
        cwd: checkoutRoot,
        env,
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    if (res.status !== 0 || typeof res.stdout !== 'string') return map;
    stdout = res.stdout;
  } catch {
    return map;
  }
  // Lines read `R097<TAB>old/path<TAB>new/path`, newest commit first. Read
  // them oldest first so a path renamed twice ends up mapped by its OLDEST
  // name too, and the walk below follows the chain to today's name.
  const lines = stdout.split('\n').reverse();
  for (const line of lines) {
    if (!line.startsWith('R')) continue;
    const [, from, to] = line.split('\t');
    if (from && to && from !== to) map.set(from, to);
  }
  return map;
}

/**
 * Ask git where a file went.
 *
 * NOT `git log --follow -- <old path>`: a pathspec limits the diff to that
 * one path, which breaks the rename PAIR — git sees a deletion and reports
 * nothing, with `--follow` or without it. Measured on a two-commit fixture
 * while writing the test. The whole-tree scan above is what actually sees a
 * rename, and the chain walk is what survives a file renamed twice.
 */
export function gitRenameOf(absPath: string, relPath: string): string | null {
  const parts = docKeyForPath(absPath);
  if (!parts) return null;
  const renames = renameScanOf(parts.checkoutRoot);
  let current = relPath;
  const seen = new Set([current]);
  for (;;) {
    const next = renames.get(current);
    // A rename cycle is not something git records, but a corrupt or crafted
    // history could describe one, and an unguarded walk would spin forever.
    if (!next || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current === relPath ? null : current;
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
