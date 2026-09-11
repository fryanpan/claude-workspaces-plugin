/**
 * The split the report claims, driven over logs whose answer is known.
 *
 * The property worth protecting is the honest one: on a log written before
 * `dispatch.requested` existed the two legs are NOT separable, and the report
 * has to say `unsplit` rather than attribute the whole interval to whichever
 * leg it can see.
 *
 * All fixtures are synthetic — invented boards and agents.
 */
import { describe, expect, it } from 'vitest';
import { type EventRow, episodes, leg, parseEventLog, report } from './dispatch-timing.ts';

const MIN = 60_000;
const LEAD = { id: 'agent-harborlight' };
const BUILDER = { id: 'agent-riverbend' };

const flip = (taskId: string, ts: number, to = 'in-progress', actor = LEAD): EventRow => ({
  event: 'task.transitioned',
  taskId,
  to,
  ts,
  actor,
});
const asked = (taskId: string, ts: number, outcome = 'registered'): EventRow => ({
  event: 'dispatch.requested',
  taskId,
  ts,
  outcome,
  actor: LEAD,
});
const noted = (taskId: string, ts: number, actor = BUILDER): EventRow => ({
  event: 'task.noted',
  taskId,
  ts,
  actor,
});

describe('reading a board log for dispatch timing', () => {
  it('splits one run into planning and queueing', () => {
    const rows = [flip('t-1', 0), asked('t-1', 10 * MIN), noted('t-1', 25 * MIN)];
    const [ep] = episodes(rows);
    expect(ep?.requestedAt).toBe(10 * MIN);
    expect(ep?.laneAt).toBe(25 * MIN);
    const r = report(episodes(rows), 4);
    expect(r.planning.medianMs).toBe(10 * MIN);
    expect(r.queueing.medianMs).toBe(15 * MIN);
    expect(r.whole.medianMs).toBe(25 * MIN);
    expect(r.dominant).toBe('queueing');
  });

  it('refuses to split a log written before the marker existed', () => {
    // Every episode here has both ENDS and no middle — exactly the history
    // this measurement inherits. Reporting a dominant leg off that would be
    // an invention.
    const rows = [flip('t-1', 0), noted('t-1', 40 * MIN), flip('t-2', MIN), noted('t-2', 90 * MIN)];
    const r = report(episodes(rows), 4);
    expect(r.planning.count).toBe(0);
    expect(r.queueing.count).toBe(0);
    expect(r.whole.count).toBe(2);
    expect(r.dominant).toBe('unsplit');
  });

  it('takes the first note as the lane, and dates a second actor separately', () => {
    // Any actor for the lane: a builder's Stop-hook note is posted under the
    // parent session's agent id, so the actor cannot tell a builder from the
    // lead. The other-actor moment is kept, and is a different question.
    const rows = [flip('t-1', 0), noted('t-1', 5 * MIN, LEAD), noted('t-1', 30 * MIN, BUILDER)];
    const [ep] = episodes(rows);
    expect(ep?.laneAt).toBe(5 * MIN);
    expect(ep?.otherActorAt).toBe(30 * MIN);
  });

  it('counts how many rows were already running when each one flipped', () => {
    const rows = [flip('t-1', 0), flip('t-2', MIN), flip('t-3', 2 * MIN)];
    expect(episodes(rows).map((e) => e.inProgressAtFlip)).toEqual([1, 2, 3]);
  });

  it('lets a row out of the running set when it leaves in-progress', () => {
    const rows = [flip('t-1', 0), flip('t-1', MIN, 'done'), flip('t-2', 2 * MIN)];
    const eps = episodes(rows);
    expect(eps).toHaveLength(2);
    expect(eps[1]?.inProgressAtFlip).toBe(1);
  });

  it('treats a second run at the same row as its own episode', () => {
    const rows = [
      flip('t-1', 0),
      noted('t-1', 5 * MIN),
      flip('t-1', 10 * MIN, 'todo'),
      flip('t-1', 20 * MIN),
      noted('t-1', 22 * MIN),
    ];
    const eps = episodes(rows);
    expect(eps).toHaveLength(2);
    expect(eps[0]?.laneAt).toBe(5 * MIN);
    expect(eps[1]?.laneAt).toBe(22 * MIN);
  });

  it('keeps the FIRST ask of a run, not a retry after the cap refused one', () => {
    const rows = [flip('t-1', 0), asked('t-1', MIN, 'cap-reached'), asked('t-1', 30 * MIN)];
    const [ep] = episodes(rows);
    expect(ep?.requestedAt).toBe(MIN);
    expect(ep?.requestedOutcome).toBe('cap-reached');
    expect(report(episodes(rows), 4).capRefusals).toBe(1);
  });

  it('splits the undivided interval by how busy the board was', () => {
    const rows = [
      // Two runs while the board is quiet, two while it is at a cap of 2.
      flip('t-1', 0),
      noted('t-1', 2 * MIN),
      flip('t-1', 3 * MIN, 'done'),
      flip('t-2', 4 * MIN),
      noted('t-2', 6 * MIN),
      flip('t-3', 7 * MIN),
      noted('t-3', 60 * MIN),
    ];
    const r = report(episodes(rows), 2);
    expect(r.withSlotsFree.count).toBe(2);
    expect(r.underPressure.count).toBe(1);
    expect(r.underPressure.medianMs).toBe(53 * MIN);
  });

  it('answers a count of zero rather than a zero measurement', () => {
    expect(leg([])).toEqual({ count: 0, medianMs: 0, p90Ms: 0, meanMs: 0 });
  });

  it('reads a log whose last line is torn', () => {
    const text = `${JSON.stringify(flip('t-1', 0))}\n{"event":"task.not`;
    expect(parseEventLog(text)).toHaveLength(1);
  });
});
