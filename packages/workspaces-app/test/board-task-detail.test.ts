/**
 * Putting a trimmed row back together, in the browser.
 *
 * The server sends a task out as a list row — OPEN rows included, since the
 * fields the trim drops are read by the panel and by no list surface — and
 * the panel asks for the rest. Three rules make that invisible to every
 * surface downstream, and each of them is a bug this had on the way in: the
 * fetched row is held against the revision it was fetched at, the ask happens
 * once per revision however many times the render path calls it, and a failed
 * ask leaves the list row standing rather than blanking the panel.
 */
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardState } from '../src/board/board-actions.ts';
import type { BoardTask } from '../src/board/board-model.ts';
import {
  createTaskDetailLoads,
  detailKey,
  mergeTaskDetail,
} from '../src/board/board-task-detail.ts';
import { boardState, task } from './support/board-region-harness.ts';

/** A row as the server sends one: no body, marked. `status` is a parameter
 *  because it is no longer what decides the trim — an in-progress row reaches
 *  the browser exactly as short as a closed one. */
function trimmed(
  id: string,
  updatedAt: number,
  status = 'done',
  bodyWrittenAt?: number,
): BoardTask {
  return {
    ...task(id),
    updatedAt,
    status,
    ...(bodyWrittenAt !== undefined ? { bodyWrittenAt } : {}),
    detailTrimmed: true,
    body: undefined,
    // The trail as the wire carries it: the stop, without the words on it.
    transitions: [
      { ts: updatedAt, from: 'todo', to: 'in-progress', by: { name: 'Ada', kind: 'agent' } },
    ],
  } as unknown as BoardTask;
}

/** The same row as the detail route answers it — every field the trim drops. */
function whole(id: string, updatedAt: number, body: string): BoardTask {
  return {
    ...task(id),
    updatedAt,
    status: 'done',
    body,
    notes: [{ ts: updatedAt, by: 'agent', text: 'what happened' }],
    reviews: [{ id: 'r-1', ask: 'does this read right?' }],
    quote: 'what Bryan actually said',
    transitions: [
      {
        ts: updatedAt,
        from: 'todo',
        to: 'in-progress',
        by: { name: 'Ada', kind: 'agent' },
        note: 'why it moved',
      },
    ],
  } as unknown as BoardTask;
}

describe('mergeTaskDetail', () => {
  it('hands back the projected row when nothing was fetched', () => {
    const row = trimmed('t-1', 10);
    expect(mergeTaskDetail(row, new Map())).toBe(row);
  });

  it('fills the projected row from the fetch made at its revision', () => {
    const row = trimmed('t-1', 10);
    const full = whole('t-1', 10, 'the whole description');
    const overlay = new Map([[detailKey('t-1', 10), full]]);
    expect(mergeTaskDetail(row, overlay).body).toBe('the whole description');
  });

  it('drops a fetched row the moment the projection moves past it', () => {
    // An agent posting a note bumps `updatedAt`. Holding the overlay against
    // the id alone left the panel rendering a body fetched before the change.
    const overlay = new Map([[detailKey('t-1', 10), whole('t-1', 10, 'stale')]]);
    expect(mergeTaskDetail(trimmed('t-1', 11), overlay).body).toBeUndefined();
  });

  it('drops a fetched body once the description has been rewritten under it', () => {
    // The residue the first two rounds of this design left behind, and the
    // one that reaches the common path: `updateBodySnapshot` rewrites the
    // body, stamps `bodyWrittenAt`, and deliberately bumps NO row clock. On a
    // trimmed row there is no body in the projection to differ, so keyed on
    // `updatedAt` alone the snapshot went on filling the hole with the text
    // somebody had already replaced — on an open panel, until something
    // unrelated touched the row. Bryan edits task bodies; so do agents.
    //
    // MUTATION CONTROL: dropping `bodyWrittenAt` from `detailKey` fails the
    // first assertion (the stale body comes back); dropping it from the
    // PROJECTION cannot be caught here at all, which is why the server test
    // in `projection.test.ts` asserts the field reaches the row.
    const overlay = new Map([
      [detailKey('t-1', 10, 100), whole('t-1', 10, 'the body before the rewrite')],
    ]);
    const rewritten = trimmed('t-1', 10, 'in-progress', 200);
    expect(rewritten.updatedAt).toBe(10);

    expect(mergeTaskDetail(rewritten, overlay).body).toBeUndefined();
    // Positive control: the same row at the revision the fetch was made at
    // still fills, so this is not passing because the overlay is unreachable.
    expect(mergeTaskDetail(trimmed('t-1', 10, 'in-progress', 100), overlay).body).toBe(
      'the body before the rewrite',
    );
  });

  it('never overlays a row that arrived whole', () => {
    // A row the server did not mark is authoritative on the wire — an
    // overlay winning over it would show a body the ydoc has already
    // replaced. An open DECISION arrives this way: its body is the one a
    // list surface draws, so the trim leaves it on.
    const open = { ...task('t-1'), updatedAt: 10, body: 'live' } as BoardTask;
    const overlay = new Map([[detailKey('t-1', 10), whole('t-1', 10, 'fetched')]]);
    expect(mergeTaskDetail(open, overlay).body).toBe('live');
  });

  it('never lets the snapshot overrule a field the board still sends', () => {
    // The whole reason the fetched row is merged FIELD BY FIELD rather than
    // handed back whole. `updateBodySnapshot` — the choke point every body
    // rewrite passes through — stamps `quote`, clears `possiblyStale`, and
    // deliberately does not bump `updatedAt`, so the overlay key does not
    // move. Returning the snapshot whole therefore kept re-asserting the
    // drift notice the rewrite had just cleared, on a panel the reader was
    // looking at, until something unrelated moved the row.
    //
    // MUTATION CONTROL: `return overlay.get(...) ?? projected` fails the
    // first assertion; dropping the loop over the trimmed fields fails the
    // second.
    const flagged = {
      ...whole('t-1', 10, 'the description before the rewrite'),
      possiblyStale: { docRevision: 3, ts: 9 },
    } as BoardTask;
    const overlay = new Map([[detailKey('t-1', 10), flagged]]);
    // The projection has since dropped the flag — the refresh deletes keys
    // the row no longer has — and the fetched snapshot still carries it.
    const cleared = trimmed('t-1', 10, 'in-progress');
    expect(cleared.possiblyStale).toBeUndefined();

    const merged = mergeTaskDetail(cleared, overlay);
    expect(merged.possiblyStale).toBeUndefined();
    expect(merged.quote).toBe('what Bryan actually said');
  });

  it('leaves a KEPT body alone on a row that is marked for other reasons', () => {
    // The marker says something went, never which thing. An open unanswered
    // decision keeps its `body` — the walkthrough's card draws it off the
    // projection and never refetches — and is still marked, because its
    // `reviews` and `quote` went. Filling the body from the snapshot there
    // would put the fetched copy on a card the projection is keeping current,
    // and permanently: a body rewrite moves nothing this key is built from.
    //
    // MUTATION CONTROL: dropping the `filled[field] === undefined` guard
    // fails the first assertion.
    const decision = {
      ...task('t-1'),
      updatedAt: 10,
      status: 'in-progress',
      needs: 'decision',
      detailTrimmed: true,
      body: 'the description as the board is carrying it NOW',
    } as unknown as BoardTask;
    const overlay = new Map([
      [detailKey('t-1', 10), whole('t-1', 10, 'the body as it was fetched')],
    ]);

    const merged = mergeTaskDetail(decision, overlay);
    expect(merged.body).toBe('the description as the board is carrying it NOW');
    // Positive control: the fields that DID go are still filled from the
    // snapshot, so this is not passing because the merge did nothing.
    expect(merged.quote).toBe('what Bryan actually said');
    expect(merged.reviews).toHaveLength(1);
  });

  it('takes the marker off the row it filled', () => {
    // `detailTrimmed` says something is missing, and nothing is once this has
    // run — which is also what keeps `loadTaskDetail` from asking again for a
    // revision it already holds.
    const overlay = new Map([[detailKey('t-1', 10), whole('t-1', 10, 'filled')]]);
    expect(mergeTaskDetail(trimmed('t-1', 10), overlay).detailTrimmed).toBeFalsy();
    // Positive control: the row that was NOT filled keeps saying so.
    expect(mergeTaskDetail(trimmed('t-1', 10), new Map()).detailTrimmed).toBe(true);
  });

  it('fills an OPEN trimmed row the same way it fills a closed one', () => {
    // The marker is the whole contract — `mergeTaskDetail` reads it and not
    // the status, which is what lets the server widen the trim to open rows
    // without a client change. An in-progress ticket somebody is working on
    // now arrives short and is filled here.
    const live = trimmed('t-1', 10, 'in-progress');
    expect(live.body).toBeUndefined();
    const overlay = new Map([[detailKey('t-1', 10), whole('t-1', 10, 'the live description')]]);
    const merged = mergeTaskDetail(live, overlay);
    expect(merged.body).toBe('the live description');
    // The trail comes back with its prose, which the trim shortens in place
    // rather than removing — a field an overlay that only filled ABSENT keys
    // would leave narrowed. The projected row's own stop carries no note.
    expect(live.transitions[0]?.note).toBeUndefined();
    expect(merged.transitions[0]?.note).toBe('why it moved');
    expect(merged.reviews).toHaveLength(1);
    expect(merged.notes).toHaveLength(1);
    expect(merged.quote).toBe('what Bryan actually said');
  });
});

describe('asking for the rest of a row', () => {
  let state: BoardState;
  let fetchMock: ReturnType<typeof vi.fn>;
  // vitest 4's bare `vi.fn()` is typed `Mock<Procedure | Constructable>` —
  // callable OR newable — which no longer satisfies the plain `() => void`
  // this is handed to. The signature says which of the two it is.
  let renderDetail: Mock<() => void>;

  function loads() {
    return createTaskDetailLoads({
      state,
      workspaceId: 'w-1',
      schedule: (paint: () => void) => paint(),
      renderDetail,
    });
  }

  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    state = boardState({ tasks: new Map([['t-1', trimmed('t-1', 10)]]) });
    renderDetail = vi.fn<() => void>();
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ task: whole('t-1', 10, 'the whole description') }),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('fetches the row, stores it under its revision and repaints', async () => {
    loads().loadTaskDetail('t-1');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/workspaces/w-1/tasks/t-1/detail');
    expect(state.taskDetail.get(detailKey('t-1', 10))?.body).toBe('the whole description');
    expect(renderDetail).toHaveBeenCalled();
  });

  it('asks once however often the render path calls it', async () => {
    // `renderDetail` runs on every board event and every clock tick.
    const api = loads();
    for (let i = 0; i < 5; i++) api.loadTaskDetail('t-1');
    await settle();
    api.loadTaskDetail('t-1');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing on a row that arrived whole', async () => {
    state.tasks.set('t-2', { ...task('t-2'), updatedAt: 10 } as BoardTask);
    loads().loadTaskDetail('t-2');
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('has the whole row in render-visible state by the time it repaints', async () => {
    // The bug this closes: the fetched row was written to `state.taskDetail`
    // only, and `renderDetail` reads `state.tasks`. The overlay is folded into
    // `state.tasks` by the PROJECTION, which runs on a board update — so on a
    // board where nothing else is happening the repaint scheduled right here
    // painted the trimmed row, and went on painting it until some unrelated
    // event fired a projection. On a quiet board that is never.
    //
    // Hence no projection anywhere in this test, and the assertion reads what
    // the render read AT THE MOMENT it was called: a check made afterwards
    // would pass against a state some later tick had repaired.
    const seen: Array<BoardTask | undefined> = [];
    renderDetail = vi.fn(() => {
      seen.push(state.tasks.get('t-1'));
    });
    loads().loadTaskDetail('t-1');
    await settle();

    expect(renderDetail).toHaveBeenCalled();
    const painted = seen[0];
    expect(painted?.body).toBe('the whole description');
    // Every field the trim drops, not just the one the panel shows first.
    expect(painted?.notes?.length).toBe(1);
    expect(painted?.reviews?.length).toBe(1);
    expect(painted?.quote).toBe('what Bryan actually said');
  });

  it('leaves the projected row alone once the projection has moved past it', async () => {
    // The revision guard still holds on this path. An agent's note bumps
    // `updatedAt` while the fetch is in flight, and the answer that lands
    // describes a row that no longer exists — folding it in would put a stale
    // body on screen, which is the failure `detailKey` exists to prevent.
    let inFlight: () => void = () => {};
    fetchMock.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          inFlight = () =>
            resolve({ ok: true, json: async () => ({ task: whole('t-1', 10, 'stale body') }) });
        }),
    );
    loads().loadTaskDetail('t-1');
    await settle();
    state.tasks.set('t-1', trimmed('t-1', 11));
    inFlight();
    await settle();

    expect(state.tasks.get('t-1')?.body).toBeUndefined();
    expect(state.tasks.get('t-1')?.updatedAt).toBe(11);
  });

  it('asks again, and paints the NEW body, when the description is rewritten', async () => {
    // The whole path the reader actually walks: open the panel, get the row,
    // then somebody rewrites the description while it is on screen. The
    // rewrite bumps no row clock and pushes no body — `bodyWrittenAt` moving
    // is the only thing that reaches the browser — so this is the assertion
    // that the panel does not go on showing the words that are gone.
    //
    // MUTATION CONTROL: dropping `bodyWrittenAt` from `detailKey` fails
    // `toHaveBeenCalledTimes(2)` — the second render finds the key already
    // asked and never re-asks.
    state.tasks.set('t-1', trimmed('t-1', 10, 'in-progress', 100));
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ task: whole('t-1', 10, 'the description as first fetched') }),
    }));
    const api = loads();
    api.loadTaskDetail('t-1');
    await settle();
    expect(state.tasks.get('t-1')?.body).toBe('the description as first fetched');

    // What the ydoc pushes after `updateBodySnapshot`: the same row, the same
    // `updatedAt`, a moved `bodyWrittenAt` — and still no body on it.
    state.tasks.set('t-1', trimmed('t-1', 10, 'in-progress', 200));
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ task: whole('t-1', 10, 'the description AFTER the rewrite') }),
    }));
    api.loadTaskDetail('t-1');
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.tasks.get('t-1')?.body).toBe('the description AFTER the rewrite');
  });

  it('leaves the list row standing when the ask never reaches the server', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('offline');
    });
    loads().loadTaskDetail('t-1');
    await settle();
    expect(state.taskDetail.size).toBe(0);
    expect(mergeTaskDetail(state.tasks.get('t-1') as BoardTask, state.taskDetail).id).toBe('t-1');
  });
});
