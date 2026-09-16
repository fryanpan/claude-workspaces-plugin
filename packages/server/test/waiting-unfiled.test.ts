/**
 * An unfiled wait may not excuse the stall clock.
 *
 * Before this, `task.noted` was movement whatever it said, so an agent that
 * closed every turn with "waiting on <person>" reset its own task's clock
 * forever and the task never stalled. What changes is narrow and one-way: a
 * note whose words ASK a person loses its movement credit while nothing is
 * filed on that person's queue, and the gate names the task under its own
 * bucket. No bucket is ever SET from prose — the 2026-09-08 rule that a wait
 * is declared, never inferred, is untouched.
 *
 * Each case carries its control. The pair that matters most is the last one
 * in the classifier block: the same note, the same silence, with an open item
 * filed on the task — the note keeps its credit, the task is
 * `blocked-on-owner`, and nothing is a finding.
 *
 * All fixtures are synthetic — invented names and a made-up board. The repo
 * is public.
 */
import { describe, expect, it } from 'bun:test';
import { type ReviewItemRow, type TaskRow, classifyOpenTasks } from '../src/keep-moving.ts';
import { evaluateStalls } from '../src/stall-gate.ts';
import {
  WAITING_UNFILED_BUCKET,
  noteClockOf,
  noteClocks,
  ownerNamesFrom,
} from '../src/waiting-unfiled.ts';

const MIN = 60_000;
const now = 1_000 * MIN;
const STALL = 30 * MIN;
const bands = { dispatchable: new Set(['g1']), ownerBand: new Set(['decisions']) };

const OWNERS = ['Harborlight'];

/** A task claimed long ago, with nothing but its notes since. */
function claimedRow(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 't-1',
    title: 'Cut the release branch',
    status: 'in-progress',
    goal: 'g1',
    createdAt: now - 300 * MIN,
    transitions: [{ ts: now - 300 * MIN, to: 'in-progress' }],
    ownerKind: 'agent',
    ...over,
  };
}

/** The note the whole feature is about: the agent saying it is stuck on a
 *  person, five minutes ago — well inside the quiet window. */
const WAIT_NOTE = {
  ts: now - 5 * MIN,
  kind: 'turn',
  text: 'Branch is cut and the smoke run is green. Waiting on Harborlight to pick the window.',
  agent: 'Millwright',
};

/** The same turn, reporting rather than asking. */
const PLAIN_NOTE = {
  ts: now - 5 * MIN,
  kind: 'turn',
  text: 'Branch is cut and the smoke run is green. Tagging it next.',
  agent: 'Millwright',
};

function clocksFor(row: TaskRow): Map<string, ReturnType<typeof noteClockOf>> {
  return noteClocks([{ id: row.id, notes: row.notes ?? [] }], OWNERS);
}

describe('noteClockOf — which note the clock may read', () => {
  it('an asking note above every plain one leaves no plain note to read', () => {
    const clock = noteClockOf([WAIT_NOTE], OWNERS);
    expect(clock.newestPlainAt).toBe(0);
    expect(clock.askedAt).toBe(WAIT_NOTE.ts);
  });

  it('control: a note that only reports keeps its own timestamp and asks nothing', () => {
    const clock = noteClockOf([PLAIN_NOTE], OWNERS);
    expect(clock.newestPlainAt).toBe(PLAIN_NOTE.ts);
    expect(clock.askedAt).toBeUndefined();
  });

  it('an agent that went back to work after asking is moving again', () => {
    const clock = noteClockOf(
      [
        { ts: now - 40 * MIN, kind: 'turn', text: 'Waiting on Harborlight to pick the window.' },
        { ts: now - 3 * MIN, kind: 'turn', text: 'Picked it up again; rebasing onto main.' },
      ],
      OWNERS,
    );
    expect(clock.newestPlainAt).toBe(now - 3 * MIN);
    expect(clock.askedAt).toBeUndefined();
  });

  it('falls back to the newest plain note under a run of asks', () => {
    const clock = noteClockOf(
      [
        { ts: now - 50 * MIN, kind: 'turn', text: 'Rebased and pushed.' },
        { ts: now - 20 * MIN, kind: 'turn', text: 'Your call on the window?' },
        { ts: now - 5 * MIN, kind: 'turn', text: 'Still waiting on Harborlight.' },
      ],
      OWNERS,
    );
    expect(clock.newestPlainAt).toBe(now - 50 * MIN);
    expect(clock.askedAt).toBe(now - 5 * MIN);
  });

  it('reads newest-first whatever order the notes were appended in', () => {
    const clock = noteClockOf(
      [
        { ts: now - 5 * MIN, kind: 'turn', text: 'Still waiting on Harborlight.' },
        { ts: now - 50 * MIN, kind: 'turn', text: 'Rebased and pushed.' },
      ],
      OWNERS,
    );
    expect(clock.newestPlainAt).toBe(now - 50 * MIN);
  });
});

describe('ownerNamesFrom — the people are read off the board', () => {
  it('names whoever has moved a task as a person, and nobody else', () => {
    const names = ownerNamesFrom([
      {
        transitions: [
          { by: { kind: 'person', name: 'Harborlight' } },
          { by: { kind: 'agent', name: 'Millwright' } },
          { by: { kind: 'person', name: 'Harborlight' } },
        ],
      },
      { transitions: [{ by: { kind: 'person', name: 'Saltmarsh' } }] },
    ]);
    expect(names).toEqual(['Harborlight', 'Saltmarsh']);
  });

  it('a board nobody has touched as a person names nobody', () => {
    expect(
      ownerNamesFrom([{ transitions: [{ by: { kind: 'agent', name: 'Millwright' } }] }]),
    ).toEqual([]);
  });
});

describe('classifyOpenTasks — an unfiled wait does not reset the clock', () => {
  it('control: a plain note five minutes ago keeps the task moving', () => {
    const row = claimedRow({ notes: [PLAIN_NOTE] });
    const [out] = classifyOpenTasks([row], [], [], now, STALL, bands, undefined, clocksFor(row));
    expect(out?.sinceActivityMs).toBe(5 * MIN);
    expect(out?.stalled).toBe(false);
    expect(out?.waitingUnfiled).toBe(false);
  });

  it('the wait note is refused its credit, so the task reads as quiet since it was claimed', () => {
    const row = claimedRow({ notes: [WAIT_NOTE] });
    const [out] = classifyOpenTasks([row], [], [], now, STALL, bands, undefined, clocksFor(row));
    expect(out?.sinceActivityMs).toBe(300 * MIN);
    expect(out?.waitingUnfiled).toBe(true);
  });

  it('control: the SAME note with an open item filed on the task changes nothing', () => {
    const row = claimedRow({ notes: [WAIT_NOTE] });
    const filed: ReviewItemRow[] = [
      {
        taskId: row.id,
        askedAt: now - 6 * MIN,
        address: { kind: 'task', taskId: row.id, reviewItemId: 'ri-1' },
      },
    ];
    const [out] = classifyOpenTasks([row], [], filed, now, STALL, bands, undefined, clocksFor(row));
    expect(out?.bucket).toBe('blocked-on-owner');
    expect(out?.sinceActivityMs).toBe(5 * MIN);
    expect(out?.waitingUnfiled).toBe(false);
    expect(out?.stalled).toBe(false);
  });

  it('with no note clocks at all the classifier behaves exactly as it did before', () => {
    const row = claimedRow({ notes: [WAIT_NOTE] });
    const [out] = classifyOpenTasks([row], [], [], now, STALL, bands);
    expect(out?.sinceActivityMs).toBe(5 * MIN);
    expect(out?.waitingUnfiled).toBe(false);
  });
});

describe('evaluateStalls — the finding, and what it is not', () => {
  const gateInput = (row: TaskRow, reviewItems: ReviewItemRow[] = []) => ({
    tasks: [row],
    events: [],
    reviewItems,
    bands,
    now,
    quietMs: STALL,
    noteClocks: clocksFor(row),
  });

  it('names the task on the unfiled list under its own bucket, not as a plain stall', () => {
    const verdict = evaluateStalls(gateInput(claimedRow({ notes: [WAIT_NOTE] })));
    expect(verdict.stalled).toHaveLength(0);
    expect(verdict.unfiled).toHaveLength(1);
    expect(verdict.unfiled[0]?.id).toBe('t-1');
    expect(verdict.unfiled[0]?.bucket).toBe(WAITING_UNFILED_BUCKET);
  });

  it('control: with the ask filed the task is on no finding list at all', () => {
    const row = claimedRow({ notes: [WAIT_NOTE] });
    const verdict = evaluateStalls(
      gateInput(row, [
        {
          taskId: row.id,
          askedAt: now - 6 * MIN,
          address: { kind: 'task', taskId: row.id, reviewItemId: 'ri-1' },
        },
      ]),
    );
    expect(verdict.stalled).toHaveLength(0);
    expect(verdict.unfiled).toHaveLength(0);
    expect(verdict.waiting).toHaveLength(1);
  });

  it('control: the same note inside the quiet window is not yet a finding', () => {
    const fresh = claimedRow({
      createdAt: now - 10 * MIN,
      transitions: [{ ts: now - 10 * MIN, to: 'in-progress' }],
      notes: [{ ...WAIT_NOTE, ts: now - MIN }],
    });
    const verdict = evaluateStalls(gateInput(fresh));
    expect(verdict.unfiled).toHaveLength(0);
    expect(verdict.stalled).toHaveLength(0);
  });

  it('a dispatched builder gets no doubled window for an unfiled wait', () => {
    const row = claimedRow({ notes: [WAIT_NOTE] });
    const verdict = evaluateStalls({
      ...gateInput(row),
      watchingDispatchTaskIds: new Set([row.id]),
    });
    expect(verdict.unfiled[0]?.bucket).toBe(WAITING_UNFILED_BUCKET);
    expect(verdict.checkIn).toHaveLength(0);
  });
});
