/**
 * What the doc-identity migration WOULD do, worked out without touching
 * anything.
 *
 * A document's identity is now its repo plus its path from the repo root.
 * Documents minted before that have ids and comments and no claim on a key,
 * so a bind from a second checkout would mint a SECOND document for a file
 * that already has one. This decides, for every document already on disk,
 * which key it should hold — and where two of them want the same one.
 *
 * WHICH DOCUMENTS CLAIM A KEY. Prose documents — `markdown` and `code` — are
 * the ones whose identity IS a file. A `diff` document is a member of a
 * review set: twenty reviews of one file are twenty documents on purpose, and
 * collapsing them onto one key would destroy nineteen reviews. A `mockup`'s
 * source is an HTML file that is usually outside any repo. Both are counted
 * and reported, and neither claims. That is narrower than "every document
 * with a sourceUrl", and the difference is why the report prints the classes.
 *
 * Pure by construction: everything it reads arrives through `PlanIo`, which
 * is what lets the dry run be the same code as the run.
 */

import { makeDocKey } from './doc-key.ts';

/** The kinds of document whose identity is the file itself. */
const PROSE_TYPES = new Set(['markdown', 'code']);

export interface DocRow {
  docId: string;
  type: string;
  sourceUrl?: string;
  /** Newest of the doc's own activity signals — the merge tie-break. */
  lastActivityAt: number;
  threads: number;
}

/** Everything the planner touches that is not arithmetic. */
export interface PlanIo {
  rows: () => DocRow[];
  /** `docKeyForPath`, injected so the planner can be tested without a repo. */
  keyFor: (absPath: string) => { repoKey: string; relPath: string; docKey: string } | null;
  exists: (absPath: string) => boolean;
  /**
   * Where a file that is no longer at `relPath` went, according to git.
   * Returns the new path relative to the repo root, or null.
   */
  renamedTo: (repoKeyPath: string, relPath: string) => string | null;
}

export interface KeyClaim {
  docKey: string;
  docId: string;
  /** The key this doc used to live under, when a rename moved it. */
  aliasKeys: string[];
  /** How the doc reached its key — for the report, and for the reader. */
  via: 'sourceUrl' | 'rename';
}

export interface Merge {
  docKey: string;
  winner: string;
  losers: string[];
}

export interface Plan {
  claims: KeyClaim[];
  merges: Merge[];
  /** Prose docs whose file is in no checkout this machine can see. They keep
   *  their id and their comments and claim nothing. */
  unresolved: string[];
  counts: {
    rows: number;
    withSourceUrl: number;
    prose: number;
    setAddressed: number;
    bySourceUrl: number;
    byRename: number;
    unresolved: number;
    distinctKeys: number;
    duplicateKeys: number;
    docsInMerges: number;
  };
}

/**
 * Work out what the migration would do. Pure: it reads through `io` and
 * writes nothing, which is what makes the dry run the same code as the run.
 */
export function planMigration(io: PlanIo): Plan {
  const rows = io.rows();
  const counts = {
    rows: rows.length,
    withSourceUrl: 0,
    prose: 0,
    setAddressed: 0,
    bySourceUrl: 0,
    byRename: 0,
    unresolved: 0,
    distinctKeys: 0,
    duplicateKeys: 0,
    docsInMerges: 0,
  };
  const unresolved: string[] = [];
  const byKey = new Map<
    string,
    Array<{ row: DocRow; aliasKeys: string[]; via: KeyClaim['via'] }>
  >();

  for (const row of rows) {
    if (!row.sourceUrl) continue;
    counts.withSourceUrl++;
    if (!PROSE_TYPES.has(row.type)) {
      counts.setAddressed++;
      continue;
    }
    counts.prose++;
    const key = io.keyFor(row.sourceUrl);
    if (!key) {
      // No repo at that path at all: the checkout is gone, or the file never
      // lived in one. Nothing to claim, and nothing lost.
      counts.unresolved++;
      unresolved.push(row.docId);
      continue;
    }
    let docKey = key.docKey;
    const aliasKeys: string[] = [];
    let via: KeyClaim['via'] = 'sourceUrl';
    if (!io.exists(row.sourceUrl)) {
      const moved = io.renamedTo(row.sourceUrl, key.relPath);
      if (moved) {
        // The old key becomes an ALIAS rather than being forgotten: a link
        // saved against the old path has to keep resolving.
        aliasKeys.push(docKey);
        docKey = makeDocKey(key.repoKey, moved);
        via = 'rename';
        counts.byRename++;
      } else {
        // The checkout is there and the file is not, and git does not know
        // where it went. The doc keeps its id and its comments.
        counts.unresolved++;
        unresolved.push(row.docId);
        continue;
      }
    } else {
      counts.bySourceUrl++;
    }
    const bucket = byKey.get(docKey) ?? [];
    bucket.push({ row, aliasKeys, via });
    byKey.set(docKey, bucket);
  }

  const claims: KeyClaim[] = [];
  const merges: Merge[] = [];
  for (const [docKey, bucket] of byKey) {
    // Newest wins: the copy somebody has been working in is the one whose
    // link should keep opening the live document.
    const sorted = [...bucket].sort((a, b) => b.row.lastActivityAt - a.row.lastActivityAt);
    const winner = sorted[0] as (typeof sorted)[number];
    const aliasKeys = [...new Set(bucket.flatMap((b) => b.aliasKeys))].filter((k) => k !== docKey);
    claims.push({ docKey, docId: winner.row.docId, aliasKeys, via: winner.via });
    if (sorted.length > 1) {
      merges.push({
        docKey,
        winner: winner.row.docId,
        losers: sorted.slice(1).map((s) => s.row.docId),
      });
      counts.duplicateKeys++;
      counts.docsInMerges += sorted.length;
    }
  }
  counts.distinctKeys = claims.length;
  return { claims, merges, unresolved, counts };
}
