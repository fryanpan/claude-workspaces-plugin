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
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
function trimmed(id: string, updatedAt: number, status = 'done'): BoardTask {
  return { ...task(id), updatedAt, status, detailTrimmed: true, body: undefined } as BoardTask;
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
  } as unknown as BoardTask;
}

describe('mergeTaskDetail', () => {
  it('hands back the projected row when nothing was fetched', () => {
    const row = trimmed('t-1', 10);
    expect(mergeTaskDetail(row, new Map())).toBe(row);
  });

  it('hands back the fetched row for the revision it was fetched at', () => {
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

  it('never overlays a row that arrived whole', () => {
    // A row the server did not mark is authoritative on the wire — an
    // overlay winning over it would show a body the ydoc has already
    // replaced. An open DECISION arrives this way: its body is the one a
    // list surface draws, so the trim leaves it on.
    const open = { ...task('t-1'), updatedAt: 10, body: 'live' } as BoardTask;
    const overlay = new Map([[detailKey('t-1', 10), whole('t-1', 10, 'fetched')]]);
    expect(mergeTaskDetail(open, overlay).body).toBe('live');
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
    expect(merged.reviews).toHaveLength(1);
    expect(merged.notes).toHaveLength(1);
    expect(merged.quote).toBe('what Bryan actually said');
  });
});

describe('asking for the rest of a row', () => {
  let state: BoardState;
  let fetchMock: ReturnType<typeof vi.fn>;
  let renderDetail: ReturnType<typeof vi.fn>;

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
    renderDetail = vi.fn();
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
