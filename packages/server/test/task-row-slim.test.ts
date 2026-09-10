/**
 * What a closed row costs the board, and what it still carries.
 *
 * The board's sync-step-2 hands a fresh tab every row that has ever existed
 * on it, so the price of opening a board is the size of its whole history.
 * On the live board on 2026-09-09 that was 5,431,267 bytes of state, 1.6 MB
 * on the wire after deflate, of which 3.22 MB of live content belonged to the
 * 638 archived-or-done rows the default view does not draw.
 *
 * The budget below is the regression gate for that, and it is deliberately
 * NOT a wall-clock reading: it measures bytes out of the real Yjs encoder
 * over rows built by the real trim, so it says the same thing on a loaded
 * machine as on an idle one. Its positive control is in the same test — the
 * untrimmed fixture is measured too, and the assertion that it is far OVER
 * the budget is what proves the fixture is heavy enough for the trimmed
 * measurement to mean anything.
 */
import { describe, expect, it } from 'bun:test';
import * as Y from 'yjs';
import {
  DETAIL_FRESH_MS,
  TRIMMED_ROW_FIELDS,
  isClosedRow,
  slimClosedRow,
} from '../src/task-row-slim.ts';

const NOW = 1_800_000_000_000;

/** A projected row of the shape and weight the live board actually carries:
 *  a capped body, a full read-cap of notes, review items, the original words
 *  and a trail whose transitions carry prose. */
function heavyRow(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    workspaceId: 'w-1',
    title: `Bryan can read row ${id}`,
    status: 'done',
    assignee: 'Ada Lint',
    goal: 'g-1',
    order: 1,
    links: [],
    updatedAt: NOW - 10 * DETAIL_FRESH_MS,
    createdAt: NOW - 40 * DETAIL_FRESH_MS,
    bodyDocId: `task:${id}`,
    body: 'b'.repeat(4_000),
    bodyTruncated: true,
    quote: 'q'.repeat(400),
    reviews: Array.from({ length: 4 }, (_, i) => ({
      id: `r-${i}`,
      question: 'w'.repeat(200),
      askedBy: 'Ada Lint',
    })),
    notes: Array.from({ length: 50 }, (_, i) => ({
      at: NOW - i * 1000,
      kind: 'turn',
      text: 'n'.repeat(200),
      agent: 'Ada Lint',
    })),
    transitions: Array.from({ length: 20 }, (_, i) => ({
      ts: NOW - i * 1000,
      from: 'todo',
      to: 'done',
      by: { name: 'Ada Lint', kind: 'agent' },
      note: 'p'.repeat(200),
      usage: { tokens: 10 },
    })),
    ...over,
  };
}

/** Bytes of Yjs state for a `tasks` map holding these rows — the sync-step-2
 *  payload a fresh tab is handed, measured through the real encoder. */
function syncStateBytes(rows: Array<Record<string, unknown>>): number {
  const doc = new Y.Doc();
  const map = doc.getMap('tasks');
  doc.transact(() => {
    for (const row of rows) map.set(String(row.id), row);
  });
  return Y.encodeStateAsUpdate(doc).length;
}

describe('which rows are trimmed', () => {
  it('leaves an open row exactly as projected', () => {
    const open = heavyRow('t-open', { status: 'in-progress' });
    expect(slimClosedRow(open, NOW)).toBe(open);
    expect(isClosedRow(open)).toBe(false);
  });

  it('leaves a closed row that moved inside the fresh window alone', () => {
    // Home's Recent activity draws the notes and the trail of anything that
    // moved in the last day, closed rows included, straight off this
    // projection — so trimming these would empty that list.
    const justClosed = heavyRow('t-fresh', { updatedAt: NOW - DETAIL_FRESH_MS / 2 });
    expect(slimClosedRow(justClosed, NOW)).toBe(justClosed);
  });

  it('trims an archived row even when its status never reached done', () => {
    const archived = heavyRow('t-arch', { status: 'triage', archivedAt: NOW - DETAIL_FRESH_MS * 3 });
    expect(slimClosedRow(archived, NOW).detailTrimmed).toBe(true);
  });
});

describe('what a trimmed row keeps', () => {
  const slim = slimClosedRow(heavyRow('t-1'), NOW);

  it('drops every detail-panel field and says that it did', () => {
    for (const field of TRIMMED_ROW_FIELDS) expect(slim[field]).toBeUndefined();
    expect(slim.detailTrimmed).toBe(true);
  });

  it('keeps the list fields the board computes over every row', () => {
    // Not an exhaustive list — these are the ones with a reader that runs
    // over CLOSED rows: the lane filter, the effort calibration, the archive
    // list and the goal band.
    expect(slim.id).toBe('t-1');
    expect(slim.title).toBe('Bryan can read row t-1');
    expect(slim.status).toBe('done');
    expect(slim.goal).toBe('g-1');
    expect(slim.assignee).toBe('Ada Lint');
    expect(slim.updatedAt).toBe(NOW - 10 * DETAIL_FRESH_MS);
    expect(slim.bodyDocId).toBe('task:t-1');
  });

  it('keeps the whole trail, and only the prose leaves it', () => {
    // `doneAt` reads the last `→ done` stamp for the done-window filter, and
    // the effort model reads the same four keys for closed-at and wall clock.
    // Losing a transition would change what the board shows; losing its note
    // costs only the Activity tab, which refetches.
    const trail = slim.transitions as Array<Record<string, unknown>>;
    expect(trail).toHaveLength(20);
    expect(trail[0]).toEqual({
      ts: NOW,
      from: 'todo',
      to: 'done',
      by: { name: 'Ada Lint', kind: 'agent' },
    });
  });
});

describe('the sync payload budget', () => {
  /**
   * Bytes of Yjs state per closed row.
   *
   * The live board's rows averaged 5,050 bytes each before the trim and 1,132
   * after it. These fixture rows carry a 20-stop trail, longer than that
   * board's average, so they land higher — 1,800 is the ceiling that leaves
   * room for a long title and a long trail and no room at all for a body, a
   * notes list, a review item or the prose on a transition to come back.
   *
   * A ceiling rather than a ratio on purpose: a ratio would pass just as
   * happily if a future field made BOTH numbers bigger, which is exactly the
   * regression this exists to catch.
   */
  const BYTES_PER_CLOSED_ROW = 1_800;
  const rows = Array.from({ length: 200 }, (_, i) => heavyRow(`t-${i}`));

  it('keeps 200 closed rows under the per-row budget', () => {
    expect(syncStateBytes(rows.map((r) => slimClosedRow(r, NOW))) / rows.length).toBeLessThan(
      BYTES_PER_CLOSED_ROW,
    );
  });

  it('and the same rows untrimmed are far over it — the fixture is heavy', () => {
    // The positive control. Without it a budget that passes proves only that
    // the fixture was small.
    expect(syncStateBytes(rows) / rows.length).toBeGreaterThan(BYTES_PER_CLOSED_ROW * 3);
  });
});
