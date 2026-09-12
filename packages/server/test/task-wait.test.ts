/**
 * Declaring what a task waits on when the board cannot see the thing.
 *
 * Two halves, and the second is the one that matters. The module half asserts
 * that a declaration is BOUNDED — a cap that refuses rather than trims, a
 * renewal that keeps the moment the wait started so a rolling wait cannot
 * disguise itself as a fresh one, and a lapse that is a lapse. The gate half
 * asserts what the wake is then allowed to do with it: annotate the rows it
 * already names, and nothing else. In particular a declared wait must not
 * quieten an UNFILED ask, whose remedy is the lead's and available now.
 *
 * All fixtures are synthetic — invented titles in a made-up workspace. The
 * repo is public.
 */
import { describe, expect, it } from 'bun:test';
import type { Task } from '@claude-workspaces/core/task-wire';
import type { TaskRow } from '../src/keep-moving.ts';
import { evaluateStalls } from '../src/stall-gate.ts';
import {
  EXTERNAL_WAIT_DEFAULT_MS,
  EXTERNAL_WAIT_MAX_MS,
  EXTERNAL_WAIT_WHAT_MAX,
  type ExternalWaitStore,
  clearExternalWait,
  externalWaitActive,
  setExternalWait,
} from '../src/task-wait.ts';

const MIN = 60_000;
const NOW = 1_000 * MIN;

/** The smallest store the module writes through, plus a record of the saves
 *  it asked for — a field write nobody persists is the failure this catches. */
function store(task: Partial<Task> & { id: string }): ExternalWaitStore & {
  task: Task;
  saves: string[];
} {
  const row = {
    workspaceId: 'w-atlas',
    title: 'Confirm the rollout window',
    ...task,
  } as Task;
  const saves: string[] = [];
  return {
    task: row,
    saves,
    getTask: (id) => (id === row.id ? row : undefined),
    scheduleSave: (workspaceId) => {
      saves.push(workspaceId);
    },
  };
}

describe('declaring a wait', () => {
  it('records the words, the declarer and a lapse time, and persists the row', () => {
    const s = store({ id: 't-rollout' });

    const res = setExternalWait(s, 't-rollout', {
      what: 'the fleet restart, then a peer filing the follow-up',
      by: 'Team Lead',
      now: NOW,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.wait.what).toBe('the fleet restart, then a peer filing the follow-up');
    expect(res.wait.by).toBe('Team Lead');
    expect(res.wait.since).toBe(NOW);
    expect(res.wait.until).toBe(NOW + EXTERNAL_WAIT_DEFAULT_MS);
    expect(s.task.externalWait?.what).toBe(res.wait.what);
    expect(s.saves).toEqual(['w-atlas']);
  });

  it('keeps the moment the wait STARTED when the same wait is renewed', () => {
    // The audit half: a wait re-declared every hour has to read as the long
    // wait it is, or the cap buys nothing — a renewal would reset the number
    // a reader judges it by.
    const s = store({ id: 't-rollout' });
    setExternalWait(s, 't-rollout', { what: 'the fleet restart', by: 'Team Lead', now: NOW });

    const renewed = setExternalWait(s, 't-rollout', {
      what: 'the fleet restart',
      by: 'Team Lead',
      now: NOW + 90 * MIN,
    });

    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    expect(renewed.wait.since).toBe(NOW);
    expect(renewed.wait.declaredAt).toBe(NOW + 90 * MIN);
    expect(renewed.wait.until).toBe(NOW + 90 * MIN + EXTERNAL_WAIT_DEFAULT_MS);
  });

  it('restarts the count when the words change — it is a different wait', () => {
    const s = store({ id: 't-rollout' });
    setExternalWait(s, 't-rollout', { what: 'the fleet restart', by: 'Team Lead', now: NOW });

    const other = setExternalWait(s, 't-rollout', {
      what: 'the index rebuild finishing',
      by: 'Team Lead',
      now: NOW + 90 * MIN,
    });

    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.wait.since).toBe(NOW + 90 * MIN);
  });

  it('REFUSES a duration past the cap rather than trimming it to the cap', () => {
    // Trimming would answer 200 and leave the caller believing the row is
    // quiet for six more days than it is.
    const s = store({ id: 't-rollout' });

    const res = setExternalWait(s, 't-rollout', {
      what: 'the quarterly review',
      by: 'Team Lead',
      now: NOW,
      durationMs: EXTERNAL_WAIT_MAX_MS + MIN,
    });

    expect(res).toEqual({ ok: false, error: 'bad-duration' });
    expect(s.task.externalWait).toBeUndefined();
    expect(s.saves).toEqual([]);
  });

  it('refuses a wait with nothing said, and one said at essay length', () => {
    const s = store({ id: 't-rollout' });

    expect(setExternalWait(s, 't-rollout', { what: '   ', by: 'C', now: NOW })).toEqual({
      ok: false,
      error: 'what-required',
    });
    expect(
      setExternalWait(s, 't-rollout', {
        what: 'x'.repeat(EXTERNAL_WAIT_WHAT_MAX + 1),
        by: 'C',
        now: NOW,
      }),
    ).toEqual({ ok: false, error: 'what-too-long' });
    expect(s.task.externalWait).toBeUndefined();
  });

  it('clears, and says so when there was nothing to clear', () => {
    const s = store({ id: 't-rollout' });
    setExternalWait(s, 't-rollout', { what: 'the fleet restart', by: 'C', now: NOW });

    const first = clearExternalWait(s, 't-rollout', NOW + MIN);
    const second = clearExternalWait(s, 't-rollout', NOW + 2 * MIN);

    expect(first.ok && first.changed).toBe(true);
    expect(second.ok && second.changed).toBe(false);
    expect(s.task.externalWait).toBeUndefined();
  });
});

describe('whether a declaration is still standing', () => {
  it('stands until its lapse time and not past it', () => {
    const wait = { what: 'x', since: NOW, declaredAt: NOW, until: NOW + 60 * MIN, by: 'C' };

    expect(externalWaitActive(wait, NOW + 59 * MIN)).toBe(true);
    expect(externalWaitActive(wait, NOW + 61 * MIN)).toBe(false);
  });

  it('reads a declaration with no lapse time as LAPSED, not as eternal', () => {
    // The failure direction of an unreadable declaration has to be that the
    // row keeps being checked. No writer produces this; a hand-edited sidecar
    // could.
    const broken = { what: 'x', since: NOW, declaredAt: NOW, by: 'C' } as unknown as Parameters<
      typeof externalWaitActive
    >[0];

    expect(externalWaitActive(broken, NOW)).toBe(false);
    expect(externalWaitActive(undefined, NOW)).toBe(false);
  });
});

const bands = { dispatchable: new Set(['g1']), ownerBand: new Set(['decisions']) };

function row(over: Partial<TaskRow> & { id: string }): TaskRow {
  return {
    title: 'Confirm the rollout window',
    status: 'in-progress',
    goal: 'g1',
    createdAt: NOW - 200 * MIN,
    transitions: [{ ts: NOW - 200 * MIN, to: 'in-progress' }],
    ownerKind: 'agent',
    ...over,
  };
}

function standing(over: Partial<TaskRow['externalWait']> = {}): TaskRow['externalWait'] {
  return {
    what: 'the fleet restart',
    since: NOW - 30 * MIN,
    declaredAt: NOW - 30 * MIN,
    until: NOW + 30 * MIN,
    by: 'Team Lead',
    ...over,
  };
}

describe('what the stall gate does with a declaration', () => {
  it('names the wait beside the stalled row it explains', () => {
    const verdict = evaluateStalls({
      tasks: [row({ id: 't-rollout', externalWait: standing() })],
      events: [],
      reviewItems: [],
      bands,
      now: NOW,
    });

    expect(verdict.stalled.map((r) => r.id)).toEqual(['t-rollout']);
    expect(verdict.declaredWaits).toEqual([
      {
        id: 't-rollout',
        title: 'Confirm the rollout window',
        what: 'the fleet restart',
        since: NOW - 30 * MIN,
        until: NOW + 30 * MIN,
        by: 'Team Lead',
      },
    ]);
  });

  it('marks a declaration whose time has passed as lapsed', () => {
    const verdict = evaluateStalls({
      tasks: [row({ id: 't-rollout', externalWait: standing({ until: NOW - MIN }) })],
      events: [],
      reviewItems: [],
      bands,
      now: NOW,
    });

    expect(verdict.declaredWaits[0]?.lapsed).toBe(true);
  });

  it('says nothing about a row it never named', () => {
    // A wait is an annotation on a finding. A row moving a minute ago is not
    // a finding, and a frame listing its wait would be reporting on work
    // nobody needs to look at.
    const verdict = evaluateStalls({
      tasks: [row({ id: 't-rollout', externalWait: standing() })],
      events: [{ taskId: 't-rollout', ts: NOW - MIN }],
      reviewItems: [],
      bands,
      now: NOW,
    });

    expect(verdict.stalled).toHaveLength(0);
    expect(verdict.declaredWaits).toHaveLength(0);
  });

  it('still names an UNFILED ask, declaration or no declaration', () => {
    // The remedy for an unfiled ask — file it — is the lead's and available
    // now, so a sentence about waiting on something else may annotate it and
    // must not excuse it. The clock half of this is pinned in
    // stall-quiet-wait.test.ts.
    const verdict = evaluateStalls({
      tasks: [
        row({
          id: 't-palette',
          title: 'Pick the palette',
          ownerKind: 'person',
          externalWait: standing(),
        }),
      ],
      events: [],
      reviewItems: [],
      bands,
      now: NOW,
    });

    expect(verdict.unfiled.map((r) => r.id)).toEqual(['t-palette']);
    expect(verdict.declaredWaits.map((w) => w.id)).toEqual(['t-palette']);
  });
});
