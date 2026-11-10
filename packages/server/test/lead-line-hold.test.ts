/**
 * The lead's meeting line waits for the speaker to finish (`lead-line-hold.ts`),
 * driven on a fake clock with a scripted judge. Every wait is read off
 * `HOLD_TIMING`, so a change to a number moves the test with it.
 */
import { describe, expect, it } from 'bun:test';
import {
  HOLD_TIMING,
  type HoldArm,
  type HoldOutcome,
  LeadLineHold,
} from '../src/lead-chat/lead-line-hold.ts';
import type { GateTimers } from '../src/spoken-reply/pause-gate.ts';
import type { ThoughtJudge } from '../src/spoken-reply/thought-finished.ts';

function fakeClock() {
  let now = 0;
  let next = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: GateTimers = {
    set: (fn, ms) => {
      const id = ++next;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (h) => void due.delete(h as number),
  };
  const advanceTo = (t: number) => {
    for (;;) {
      const first = [...due.entries()]
        .filter(([, d]) => d.at <= t)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      due.delete(first[0]);
      now = first[1].at;
      first[1].fn();
    }
    now = t;
  };
  return { timers, advanceTo, now: () => now };
}

/** A judge whose answers the test gives by hand. */
function handJudge() {
  const asked: Array<{ recent: string; answer: (f: boolean) => void; cancelled: boolean }> = [];
  const judge: ThoughtJudge = (recent, done) => {
    const call = { recent, answer: done, cancelled: false };
    asked.push(call);
    return () => {
      call.cancelled = true;
    };
  };
  return { judge, asked };
}

function rig(arm: HoldArm, judge: ThoughtJudge | null = null) {
  const clock = fakeClock();
  const hold = new LeadLineHold({ arm, now: clock.now, timers: clock.timers, judge });
  const outcomes: Array<HoldOutcome & { at: number }> = [];
  const say = () => hold.request((o) => outcomes.push({ ...o, at: clock.now() }));
  const hear = (at: number, turn: number, text: string, final = false) => {
    clock.advanceTo(at);
    hold.heard({ turn, text, final, speaker: 'Harborlight' });
  };
  return { clock, hold, outcomes, say, hear };
}

const T = HOLD_TIMING;

describe('a lead line in a meeting', () => {
  it('goes at once with no hold (the old behaviour)', () => {
    const r = rig('at-once');
    r.hear(0, 0, 'Saltmarsh is');
    r.say();
    expect(r.outcomes).toEqual([{ said: true, waitedMs: 0, judged: 0, at: 0 }]);
  });

  it('as the tap path gates it, goes on the final of a finished-looking sentence', () => {
    const r = rig('gate');
    r.hear(0, 0, 'Saltmarsh is');
    r.say();
    r.hear(400, 0, 'Saltmarsh is late.');
    expect(r.outcomes).toEqual([]);
    r.hear(600, 0, 'Saltmarsh is late.', true);
    expect(r.outcomes.map((o) => o.at)).toEqual([600]);
  });

  it('with the judge, a final opens nothing: the room must be quiet first', () => {
    const j = handJudge();
    const r = rig('judge', j.judge);
    r.hear(0, 0, 'Saltmarsh is');
    r.say();
    r.hear(400, 0, 'Saltmarsh is late.');
    r.hear(600, 0, 'Saltmarsh is late.', true);
    r.clock.advanceTo(400 + T.quietMs - 1);
    expect(j.asked).toHaveLength(0);
    r.clock.advanceTo(400 + T.quietMs);
    expect(j.asked.map((a) => a.recent)).toEqual(['Harborlight: Saltmarsh is late.']);
    j.asked[0]?.answer(true);
    r.clock.advanceTo(400 + T.quietMs + T.graceMs);
    expect(r.outcomes).toEqual([
      {
        said: true,
        waitedMs: 400 + T.quietMs + T.graceMs,
        judged: 1,
        at: 400 + T.quietMs + T.graceMs,
      },
    ]);
  });

  it('holds when the judge hears more to come, and asks again after the next words', () => {
    const j = handJudge();
    const r = rig('judge', j.judge);
    r.hear(0, 0, 'Saltmarsh is late.', true);
    r.say();
    r.clock.advanceTo(T.quietMs);
    j.asked[0]?.answer(false);
    r.hear(T.quietMs + 300, 1, 'Because the dredge broke.');
    r.clock.advanceTo(T.quietMs + 300 + T.quietMs);
    expect(j.asked).toHaveLength(2);
    expect(j.asked[1]?.recent).toContain('Because the dredge broke.');
    j.asked[1]?.answer(true);
    r.clock.advanceTo(T.quietMs + 300 + T.quietMs + T.graceMs);
    expect(r.outcomes.map((o) => o.said)).toEqual([true]);
  });

  it('cancels the judge when words arrive while it is out', () => {
    const j = handJudge();
    const r = rig('judge', j.judge);
    r.hear(0, 0, 'Why does that matter?', true);
    r.say();
    r.clock.advanceTo(T.quietMs);
    r.hear(T.quietMs + 100, 1, 'Well');
    expect(j.asked[0]?.cancelled).toBe(true);
    j.asked[0]?.answer(true);
    r.clock.advanceTo(T.quietMs + 100 + T.graceMs);
    expect(r.outcomes).toEqual([]);
  });

  it('puts the line back on hold when somebody speaks in the grace window', () => {
    const j = handJudge();
    const r = rig('judge', j.judge);
    r.hear(0, 0, 'That is the plan for Riverbend.', true);
    r.say();
    r.clock.advanceTo(T.quietMs);
    j.asked[0]?.answer(true);
    r.hear(T.quietMs + T.graceMs - 100, 1, 'And Bob');
    r.clock.advanceTo(T.quietMs + T.graceMs * 3);
    expect(r.outcomes).toEqual([]);
  });

  it('overrules an unfinished verdict once the room has been silent long enough', () => {
    const j = handJudge();
    const r = rig('judge', j.judge);
    r.hear(0, 0, 'So, yeah, and that is it, I guess.', true);
    r.say();
    r.clock.advanceTo(T.quietMs);
    j.asked[0]?.answer(false);
    r.clock.advanceTo(T.overrideMs - 1);
    expect(r.outcomes).toEqual([]);
    r.clock.advanceTo(T.overrideMs);
    expect(r.outcomes.map((o) => o.at)).toEqual([T.overrideMs]);
  });

  it('counts the judge’s own call toward the grace window', () => {
    const j = handJudge();
    const r = rig('judge', j.judge);
    r.hear(0, 0, 'That is the plan for Riverbend.', true);
    r.say();
    r.clock.advanceTo(T.quietMs);
    // The call took longer than the grace: the room was quiet throughout.
    r.clock.advanceTo(T.quietMs + T.graceMs + 300);
    j.asked[0]?.answer(true);
    r.clock.advanceTo(T.quietMs + T.graceMs + 300);
    expect(r.outcomes.map((o) => o.at)).toEqual([T.quietMs + T.graceMs + 300]);
  });

  it('waits the unfinished silence after a phrase that stops mid-sentence', () => {
    const j = handJudge();
    const r = rig('judge', j.judge);
    r.hear(0, 0, 'It was the', true);
    r.say();
    r.clock.advanceTo(T.unfinishedMs - 1);
    expect(j.asked).toHaveLength(0);
    r.clock.advanceTo(T.unfinishedMs);
    expect(j.asked).toHaveLength(1);
  });

  it('lets a question to the room hand over the floor without asking the judge', () => {
    const j = handJudge();
    const r = rig('judge', j.judge);
    r.hear(0, 0, 'Any questions');
    r.say();
    r.hear(300, 0, 'Any questions?', true);
    r.clock.advanceTo(300 + T.graceMs);
    expect(j.asked).toHaveLength(0);
    expect(r.outcomes.map((o) => o.at)).toEqual([300 + T.graceMs]);
  });

  it('asks the judge at once when the room is already quiet', () => {
    const j = handJudge();
    const r = rig('judge', j.judge);
    r.hear(0, 0, 'That is the plan for Riverbend.', true);
    r.clock.advanceTo(T.quietMs * 2);
    r.say();
    expect(j.asked).toHaveLength(1);
  });

  it('lets a line go into a room nobody has spoken in, without a call', () => {
    const j = handJudge();
    const r = rig('judge', j.judge);
    r.say();
    r.clock.advanceTo(T.graceMs);
    expect(j.asked).toHaveLength(0);
    expect(r.outcomes.map((o) => o.said)).toEqual([true]);
  });

  it('drops a line the talk has moved past, and says so', () => {
    const r = rig('judge', handJudge().judge);
    r.hear(0, 0, 'So we could, um');
    r.say();
    for (let t = 500; t < T.lapseMs; t += 500) r.hear(t, Math.floor(t / 500), `word ${t}`);
    r.clock.advanceTo(T.lapseMs);
    expect(r.outcomes).toEqual([{ said: false, reason: 'lapsed', at: T.lapseMs }]);
  });

  it('replaces a waiting line with a newer one, and ends with the meeting', () => {
    const r = rig('gate');
    r.hear(0, 0, 'So we could');
    r.say();
    r.say();
    r.hold.end();
    expect(r.outcomes.map((o) => (o.said ? 'said' : o.reason))).toEqual(['replaced', 'ended']);
  });
});
