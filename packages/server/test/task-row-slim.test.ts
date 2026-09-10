/**
 * What a row costs the board, and what it still carries.
 *
 * The board's sync-step-2 hands a fresh tab every row that has ever existed
 * on it, so the price of opening a board is the size of its whole history.
 * On the live board on 2026-09-10 that was 1,001,594 bytes of projected
 * state, 245,920 on the wire after deflate, and 42% of those wire bytes were
 * prose that no list surface renders — on rows of every status, not only
 * closed ones.
 *
 * So the gate this file guards is per FIELD, and each `describe` below is one
 * field's rule stated against the reader that decides it. Every one of them
 * was run as a MUTATION CONTROL before it landed: the rule was deleted from
 * `slimTaskRow` and the test named in its comment went red. A test title is
 * not coverage.
 *
 * The budget at the bottom is deliberately NOT a wall-clock reading: it
 * measures bytes out of the real Yjs encoder over rows built by the real
 * trim, so it says the same thing on a loaded machine as on an idle one. Its
 * positive control is in the same test — the untrimmed fixture is measured
 * too, and the assertion that it is far OVER the budget is what proves the
 * fixture is heavy enough for the trimmed measurement to mean anything.
 */
import { describe, expect, it } from 'bun:test';
import * as Y from 'yjs';
import {
  ACTIVITY_FIELDS,
  ALWAYS_TRIMMED_FIELDS,
  BODY_FIELDS,
  DETAIL_FRESH_MS,
  TRIMMED_ROW_FIELDS,
  slimTaskRow,
} from '../src/task-row-slim.ts';

const NOW = 1_800_000_000_000;

/** A projected row of the shape and weight the live board actually carries:
 *  a capped body, a full read-cap of notes, review items, the original words
 *  and a trail whose transitions carry prose. Closed and long still, unless
 *  a caller says otherwise. */
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

/** An OPEN row that moved five minutes ago — the shape the old trim, which
 *  gated on status alone, sent out whole. */
function liveRow(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return heavyRow(id, { status: 'in-progress', updatedAt: NOW - 5 * 60_000, ...over });
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

describe('reviews and quote — read by nothing outside the open panel', () => {
  // MUTATION CONTROL: emptying `ALWAYS_TRIMMED_FIELDS` fails both of these.
  it('drops them from an open row that moved a minute ago', () => {
    const slim = slimTaskRow(liveRow('t-live'), NOW);
    expect(slim.reviews).toBeUndefined();
    expect(slim.quote).toBeUndefined();
    expect(slim.detailTrimmed).toBe(true);
  });

  it('drops them from a closed row too', () => {
    // Named literally rather than looped over `ALWAYS_TRIMMED_FIELDS`: a test
    // that iterates the list it is checking passes vacuously the moment the
    // list is emptied, which is exactly the regression it exists to catch.
    // Emptying that constant left this green until the names were written out.
    const slim = slimTaskRow(heavyRow('t-done'), NOW);
    expect(slim.reviews).toBeUndefined();
    expect(slim.quote).toBeUndefined();
    expect([...ALWAYS_TRIMMED_FIELDS]).toEqual(['reviews', 'quote']);
  });
});

describe('body — kept only where a list surface draws it', () => {
  // MUTATION CONTROL: making `rendersBodyInAList` return true unconditionally
  // fails the first of these; returning false unconditionally fails the
  // second, which is the one that keeps the walkthrough's card readable.
  it('drops the description from an open row nobody is deciding on', () => {
    const slim = slimTaskRow(liveRow('t-live'), NOW);
    expect(slim.body).toBeUndefined();
    expect(slim.bodyTruncated).toBeUndefined();
    expect([...BODY_FIELDS]).toEqual(['body', 'bodyTruncated']);
  });

  it('keeps it on an open unanswered decision — the walkthrough never refetches', () => {
    // `WalkTaskBody` renders `decisionQueue`'s rows straight off the
    // projection. There is no detail fetch behind the walkthrough, so a
    // trimmed body here is a decision card with no question on it.
    const decision = liveRow('t-decide', { needs: 'decision' });
    const slim = slimTaskRow(decision, NOW);
    expect(slim.body).toBe(decision.body);
    expect(slim.bodyTruncated).toBe(true);
  });

  it('drops it again once that decision is answered or done', () => {
    const answered = { answer: { text: 'yes', by: 'Bryan', ts: NOW } };
    expect(
      slimTaskRow(liveRow('t-a', { needs: 'decision', ...answered }), NOW).body,
    ).toBeUndefined();
    expect(
      slimTaskRow(liveRow('t-c', { needs: 'decision', status: 'done' }), NOW).body,
    ).toBeUndefined();
  });

  it('keeps it on an ARCHIVED unanswered decision, which still draws a card', () => {
    // MUTATION CONTROL: this is the assertion that fails if `archivedAt ===
    // undefined` goes back into `rendersBodyInAList` — the shape this had on
    // the way in. Archiving writes `archivedAt` and leaves `status` alone, so
    // the row still passes every clause `decisionRows` tests and the
    // walkthrough still renders `row.task.body` for it.
    const archived = liveRow('t-arch', { needs: 'decision', archivedAt: NOW - 1000 });
    expect(slimTaskRow(archived, NOW).body).toBe(archived.body);
  });
});

describe('notes — kept while Home may still be drawing them', () => {
  // MUTATION CONTROL: emptying `ACTIVITY_FIELDS` fails the second of these;
  // dropping the `keepNotes` guard fails the first.
  it('keeps them on any row that moved inside the fresh window', () => {
    // `homeActivity` renders the notes of every unarchived task that moved
    // inside `ACTIVITY_WINDOW_MS`, straight off this projection. The two
    // constants are equal on purpose.
    const fresh = heavyRow('t-fresh', { updatedAt: NOW - DETAIL_FRESH_MS / 2 });
    expect(slimTaskRow(fresh, NOW).notes).toEqual(fresh.notes as unknown[]);
  });

  it('drops them once the row has been still for a day', () => {
    expect([...ACTIVITY_FIELDS]).toEqual(['notes']);
    expect(slimTaskRow(heavyRow('t-old'), NOW).notes).toBeUndefined();
    expect(
      slimTaskRow(liveRow('t-stale', { updatedAt: NOW - 2 * DETAIL_FRESH_MS }), NOW).notes,
    ).toBeUndefined();
  });
});

describe('the trail keeps its stops and loses its prose', () => {
  // MUTATION CONTROL: returning `value` unchanged from `trimTransitions`
  // fails the first; dropping stops instead of prose fails the length check.
  it('on an open row as much as a closed one', () => {
    for (const row of [liveRow('t-live'), heavyRow('t-done')]) {
      const trail = slimTaskRow(row, NOW).transitions as Array<Record<string, unknown>>;
      // `doneAt` reads the last `→ done` stamp for the done-window filter,
      // and the effort model reads the same four keys for closed-at and wall
      // clock. Losing a transition would change what the board shows; losing
      // its note costs only the Activity tab, which refetches.
      expect(trail).toHaveLength(20);
      expect(trail[0]).toEqual({
        ts: NOW,
        from: 'todo',
        to: 'done',
        by: { name: 'Ada Lint', kind: 'agent' },
      });
    }
  });
});

describe('what every trimmed row keeps, and what it says about itself', () => {
  const slim = slimTaskRow(heavyRow('t-1'), NOW);

  it('drops every field in the union and says that it did', () => {
    // Widened to `string[]` on purpose: the literal on the right is what a
    // reader checks the union against, and comparing it to its own element
    // type would make the assertion agree with whatever the constant says.
    const dropped: readonly string[] = TRIMMED_ROW_FIELDS;
    expect([...dropped].sort()).toEqual(['body', 'bodyTruncated', 'notes', 'quote', 'reviews']);
    for (const field of TRIMMED_ROW_FIELDS) expect(slim[field]).toBeUndefined();
    expect(slim.detailTrimmed).toBe(true);
    // The list lives in core because the browser's overlay reads it too, and
    // this module's three rules must add up to exactly it: a field this trim
    // drops that the shared list does not name is a field the panel would
    // never put back, silently. Sorted on both sides — the groups are ordered
    // by rule, the shared list by nothing in particular.
    const rules: readonly string[] = [...ALWAYS_TRIMMED_FIELDS, ...BODY_FIELDS, ...ACTIVITY_FIELDS];
    expect([...rules].sort()).toEqual([...dropped].sort());
  });

  it('keeps the list fields the board computes over every row', () => {
    // Not an exhaustive list — these are the ones with a reader that runs
    // over every row: the lane filter, the effort calibration, the archive
    // list and the goal band.
    expect(slim.id).toBe('t-1');
    expect(slim.title).toBe('Bryan can read row t-1');
    expect(slim.status).toBe('done');
    expect(slim.goal).toBe('g-1');
    expect(slim.assignee).toBe('Ada Lint');
    expect(slim.updatedAt).toBe(NOW - 10 * DETAIL_FRESH_MS);
    expect(slim.bodyDocId).toBe('task:t-1');
  });

  it('leaves a row with nothing to trim exactly as projected', () => {
    // `refresh` compares by JSON, but returning the same object keeps a row
    // that was already bare from being rewritten on every tick.
    const bare = {
      id: 't-bare',
      title: 'Nothing to drop',
      status: 'todo',
      updatedAt: NOW,
      transitions: [{ ts: NOW, from: 'todo', to: 'todo', by: { name: 'Ada Lint' } }],
    };
    expect(slimTaskRow(bare, NOW)).toBe(bare);
    expect(slimTaskRow(bare, NOW).detailTrimmed).toBeUndefined();
  });
});

describe('the sync payload budget', () => {
  /**
   * Bytes of Yjs state per row, on rows of BOTH statuses.
   *
   * These fixture rows carry a 20-stop trail and a full read-cap of notes,
   * both longer than the live board's average, so they land higher than its
   * real rows do: 1,544 bytes each under this trim, against 12,717 under the
   * closed-only one and 23,889 untrimmed. 1,800 is the ceiling — room for a
   * long title and a long trail, and no room at all for a body, a notes list,
   * a review item or the prose on a transition to come back.
   *
   * Half the rows are OPEN — quiet for a day, which is 52 of the live board's
   * 85 open rows and exactly what the old status-gated trim sent out whole.
   *
   * A row that moved inside the window keeps its notes and is deliberately
   * NOT in this fixture: its size is the notes' size, and a budget over it
   * would be a budget on `TASK_NOTES_READ_CAP`.
   *
   * A ceiling rather than a ratio on purpose: a ratio would pass just as
   * happily if a future field made BOTH numbers bigger, which is exactly the
   * regression this exists to catch.
   */
  const BYTES_PER_ROW = 1_800;
  const rows = Array.from({ length: 200 }, (_, i) =>
    i % 2 === 0 ? heavyRow(`t-${i}`) : liveRow(`t-${i}`, { updatedAt: NOW - 2 * DETAIL_FRESH_MS }),
  );

  it('keeps 200 rows under the per-row budget', () => {
    expect(syncStateBytes(rows.map((r) => slimTaskRow(r, NOW))) / rows.length).toBeLessThan(
      BYTES_PER_ROW,
    );
  });

  it('and the same rows untrimmed are far over it — the fixture is heavy', () => {
    // The positive control. Without it a budget that passes proves only that
    // the fixture was small.
    expect(syncStateBytes(rows) / rows.length).toBeGreaterThan(BYTES_PER_ROW * 3);
  });
});
