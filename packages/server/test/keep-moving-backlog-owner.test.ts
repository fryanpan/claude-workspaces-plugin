/**
 * A Backlog row is idle BY RULE, whoever owns it.
 *
 * The standing rule is that the backlog is not auto-dispatched, so a row
 * sitting there is nobody's failure to act. But `blocked-on-owner-unfiled` —
 * the bucket the classifier itself calls a protocol violation, and the one
 * that raises the "a real ask is missing" wake — was reached first by any
 * person-owned row, backlog or not. The lead could never clear such a wake:
 * there is no ask to file, because nobody knows what the row is for. Every
 * one of those drowned a wake somebody COULD act on.
 *
 * So the person half of the owner test is narrowed by `inBacklog`. The
 * owner-band half is not, and must not be: `dispatchable` is built by
 * SUBTRACTING the owner band (stall-wiring.ts), so an owner-band row also
 * fails `bands.dispatchable.has(...)` and a plain reorder of the two tests
 * would have silenced the owner band's unfiled asks entirely. The third case
 * below is the control that holds that true.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { type TaskRow, classifyOpenTasks } from '../src/keep-moving.ts';

const MIN = 60_000;
const now = 1_000 * MIN;
const STALL = 30 * MIN;
/** The shape stall-wiring builds: `dispatchable` is the goal list MINUS the
 *  owner band, so a goal named by neither set is the backlog. */
const bands = { dispatchable: new Set(['g-ranked']), ownerBand: new Set(['g-decisions']) };

function row(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 't-1',
    title: 'Sketch the archive browser',
    status: 'todo',
    createdAt: now - 400 * MIN,
    transitions: [{ ts: now - 400 * MIN, to: 'todo' }],
    ...over,
  };
}

describe('classifyOpenTasks — a Backlog row is not an unfiled ask', () => {
  it('a person-owned row in the backlog is backlog-unranked and raises no wake', () => {
    const [r] = classifyOpenTasks(
      [row({ ownerKind: 'person', goal: 'g-someday' })],
      [],
      [],
      now,
      STALL,
      bands,
    );
    expect(r?.bucket).toBe('backlog-unranked');
    expect(r?.unfiledAsk).toBe(false);
    expect(r?.stalled).toBe(false);
  });

  it('a person-owned row with NO goal at all is backlog too, not a violation', () => {
    const [r] = classifyOpenTasks([row({ ownerKind: 'person' })], [], [], now, STALL, bands);
    expect(r?.bucket).toBe('backlog-unranked');
    expect(r?.unfiledAsk).toBe(false);
  });

  it('a person-owned row in a DISPATCHABLE band with nothing filed is still unfiled', () => {
    const [r] = classifyOpenTasks(
      [row({ ownerKind: 'person', goal: 'g-ranked' })],
      [],
      [],
      now,
      STALL,
      bands,
    );
    expect(r?.bucket).toBe('blocked-on-owner-unfiled');
    expect(r?.unfiledAsk).toBe(true);
  });

  it('an OWNER-BAND row with nothing filed is still unfiled — the band is not backlog', () => {
    const [r] = classifyOpenTasks(
      [row({ ownerKind: 'agent', goal: 'g-decisions' })],
      [],
      [],
      now,
      STALL,
      bands,
    );
    expect(r?.bucket).toBe('blocked-on-owner-unfiled');
    expect(r?.unfiledAsk).toBe(true);
  });

  it('a person-owned backlog row IN PROGRESS is backlog too — no stall wake either', () => {
    const [r] = classifyOpenTasks(
      [row({ ownerKind: 'person', goal: 'g-someday', status: 'in-progress' })],
      [],
      [],
      now,
      STALL,
      bands,
    );
    expect(r?.bucket).toBe('backlog-unranked');
    expect(r?.stalled).toBe(false);
  });

  it('an AGENT-owned backlog row in progress still stalls — the narrowing is owner-only', () => {
    const [r] = classifyOpenTasks(
      [row({ ownerKind: 'agent', goal: 'g-someday', status: 'in-progress' })],
      [],
      [],
      now,
      STALL,
      bands,
    );
    expect(r?.bucket).toBe('in-progress');
    expect(r?.stalled).toBe(true);
  });

  it('on a GOAL-LESS board nothing is backlog, so an unfiled ask still reports', () => {
    // stall-wiring.ts builds `dispatchable` from the rows' own goals when the
    // board declares none, precisely so no row reads as unranked there. Every
    // server row carries a goal (`chores` is the catch-all), so the set holds
    // real ids and the person-owned row below is NOT in the backlog.
    const goalless = { dispatchable: new Set(['chores']), ownerBand: new Set<string>() };
    const [r] = classifyOpenTasks(
      [row({ ownerKind: 'person', goal: 'chores' })],
      [],
      [],
      now,
      STALL,
      goalless,
    );
    expect(r?.bucket).toBe('blocked-on-owner-unfiled');
    expect(r?.unfiledAsk).toBe(true);
  });

  it('a filed item still wins over the backlog: the row reads blocked-on-owner', () => {
    const [r] = classifyOpenTasks(
      [row({ ownerKind: 'person', goal: 'g-someday' })],
      [],
      [{ taskId: 't-1', askedAt: now - 10 * MIN }],
      now,
      STALL,
      bands,
    );
    expect(r?.bucket).toBe('blocked-on-owner');
    expect(r?.unfiledAsk).toBe(false);
  });

  it('a schedule rule in the backlog is still a rule row — that test stays first', () => {
    const [r] = classifyOpenTasks(
      [
        row({
          ownerKind: 'person',
          goal: 'g-someday',
          schedule: {
            rule: { kind: 'every', everyMs: 7 * 86_400_000 },
            armedAt: now - 30 * 86_400_000,
          },
        }),
      ],
      [],
      [],
      now,
      STALL,
      bands,
    );
    expect(r?.bucket).toBe('scheduled-rule');
  });
});
