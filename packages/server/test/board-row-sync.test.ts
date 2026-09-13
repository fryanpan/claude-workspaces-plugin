/**
 * `BoardRowSync` skips the rows nobody named only when it can prove they did
 * not move — and falls back to the full pass on each of the three things that
 * move a row with nothing naming it: the roster, the notes trim window, and a
 * row appearing or leaving unannounced.
 *
 * Every case reads the map it wrote AND the counter, because a sync that
 * silently went full would pass an equality check while doing the old work.
 */
import { describe, expect, it } from 'bun:test';
import * as Y from 'yjs';
import { BoardRowSync, type RowSyncStats } from '../src/board-row-sync.ts';
import { DETAIL_FRESH_MS, slimTaskRow } from '../src/task-row-slim.ts';

interface Row {
  id: string;
  title: string;
  updatedAt: number;
  notes?: string[];
}

const T0 = 1_780_000_000_000;

function board(rows: Row[]) {
  const ydoc = new Y.Doc();
  const tasksMap = ydoc.getMap<unknown>('tasks');
  const stats: RowSyncStats = { rowsProjected: 0, fullPasses: 0, scopedPasses: 0 };
  const sync = new BoardRowSync<Row>(stats);
  const state = { rows, roster: 'agent-harborlight' as string | null, now: T0 };
  const run = (named: string[] | null) =>
    ydoc.transact(() =>
      sync.sync({
        tasksMap,
        rows: state.rows,
        named,
        roster: state.roster,
        now: state.now,
        project: (r) => slimTaskRow({ ...r }, state.now),
      }),
    );
  return { tasksMap, stats, state, run };
}

const row = (id: string, title: string, updatedAt = T0): Row => ({
  id,
  title,
  updatedAt,
  notes: [`${title} was surveyed`],
});

describe('BoardRowSync', () => {
  it('projects only the named row once a full pass has run', () => {
    const b = board([row('a', 'Chart the estuary'), row('b', 'Rebuild the tide tables')]);
    b.run(null);
    expect(b.stats).toEqual({ rowsProjected: 2, fullPasses: 1, scopedPasses: 0 });

    b.state.rows = [row('a', 'Chart the whole estuary'), b.state.rows[1] as Row];
    b.run(['a']);
    expect(b.stats).toEqual({ rowsProjected: 3, fullPasses: 1, scopedPasses: 1 });
    expect((b.tasksMap.get('a') as Row).title).toBe('Chart the whole estuary');

    // Naming nothing, or a goal id the map does not hold, writes nothing.
    b.run([]);
    b.run(['g-goal']);
    expect(b.stats).toEqual({ rowsProjected: 3, fullPasses: 1, scopedPasses: 3 });
    expect([...b.tasksMap.keys()].sort()).toEqual(['a', 'b']);
  });

  it('removes a named row the store no longer holds', () => {
    const b = board([row('a', 'Chart the estuary'), row('b', 'Rebuild the tide tables')]);
    b.run(null);
    b.state.rows = [b.state.rows[0] as Row];
    b.run(['b']);
    expect(b.stats.scopedPasses).toBe(1);
    expect([...b.tasksMap.keys()]).toEqual(['a']);
  });

  it('goes full when the roster moved', () => {
    const b = board([row('a', 'Chart the estuary'), row('b', 'Rebuild the tide tables')]);
    b.run(null);
    b.state.roster = 'agent-harborlight\nagent-saltmarsh';
    b.run([]);
    expect(b.stats).toEqual({ rowsProjected: 4, fullPasses: 2, scopedPasses: 0 });
    // …and a roster that cannot say whether it moved never scopes.
    b.state.roster = null;
    b.run([]);
    b.run([]);
    expect(b.stats.fullPasses).toBe(4);
  });

  it('goes full when a row it did not name would now lose its notes', () => {
    const b = board([
      row('a', 'Chart the estuary', T0),
      row('b', 'Rebuild the tide tables', T0 + 60_000),
    ]);
    b.run(null);
    expect((b.tasksMap.get('a') as Row).notes).toEqual(['Chart the estuary was surveyed']);

    // Just inside the window: nothing to trim, so a scoped pass is safe.
    b.state.now = T0 + DETAIL_FRESH_MS - 1;
    b.run([]);
    expect(b.stats.scopedPasses).toBe(1);

    // Row a's window closes. Nobody named it, and its notes must still go.
    b.state.now = T0 + DETAIL_FRESH_MS;
    b.run(['b']);
    expect(b.stats.fullPasses).toBe(2);
    expect((b.tasksMap.get('a') as Row).notes).toBeUndefined();
    expect((b.tasksMap.get('b') as Row).notes).toEqual(['Rebuild the tide tables was surveyed']);

    // The next deadline is row b's, not the one that already passed.
    b.run([]);
    expect(b.stats.scopedPasses).toBe(2);
  });

  it('goes full when a row arrived or left without being named', () => {
    const b = board([row('a', 'Chart the estuary')]);
    b.run(null);
    b.state.rows = [...b.state.rows, row('c', 'Sound the channel')];
    b.run([]);
    expect(b.stats.fullPasses).toBe(2);
    expect([...b.tasksMap.keys()].sort()).toEqual(['a', 'c']);

    b.state.rows = [row('c', 'Sound the channel')];
    b.run(['c']);
    expect(b.stats.fullPasses).toBe(3);
    expect([...b.tasksMap.keys()]).toEqual(['c']);
  });

  it('starts with a full pass even when a row is named', () => {
    const b = board([row('a', 'Chart the estuary'), row('b', 'Rebuild the tide tables')]);
    b.run(['a']);
    expect(b.stats.fullPasses).toBe(1);
    expect([...b.tasksMap.keys()].sort()).toEqual(['a', 'b']);
  });
});
