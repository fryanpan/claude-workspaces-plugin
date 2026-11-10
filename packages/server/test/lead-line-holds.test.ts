/**
 * The board-level holds (`lead-line-holds.ts`) over the real `MeetingEars`:
 * which arm the environment picks, a line answering "Lead, …" is not held,
 * a meeting with no ears says at once, and ending the meeting drops a
 * waiting line. Timers are a fake clock; nothing here sleeps.
 */
import { describe, expect, it } from 'bun:test';
import { HOLD_TIMING, type HoldOutcome } from '../src/lead-chat/lead-line-hold.ts';
import { ADDRESSED_MS, LeadLineHolds, leadHoldArm } from '../src/lead-chat/lead-line-holds.ts';
import { MeetingEars } from '../src/spoken-reply/meeting-ears.ts';
import type { GateTimers } from '../src/spoken-reply/pause-gate.ts';
import { waitFor } from './wait-for.ts';

const M = { id: 'lcm-1', docId: 'riverbend-plan' };

function fakeTimers() {
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

describe('the lead line holds of a board', () => {
  it('picks the judge with a completer, the gate without, and honours the switch', () => {
    expect(leadHoldArm({}, true)).toBe('judge');
    expect(leadHoldArm({}, false)).toBe('gate');
    expect(leadHoldArm({ CW_MEETING_LEAD_HOLD: 'off' }, true)).toBe('off');
    expect(leadHoldArm({ CW_MEETING_LEAD_HOLD: 'gate' }, true)).toBe('gate');
    expect(leadHoldArm({ CW_MEETING_LEAD_HOLD: 'judge' }, false)).toBe('gate');
    expect(leadHoldArm({ CW_MEETING_LEAD_HOLD: 'loud' }, true)).toBe('judge');
  });

  it('holds while the room talks, and says a line answering "Lead, …" at once', async () => {
    const ears = new MeetingEars();
    ears.started(M.docId);
    const clock = fakeTimers();
    const holds = new LeadLineHolds({
      ears,
      setting: 'gate',
      judge: null,
      timers: clock.timers,
      now: clock.now,
    });
    holds.listen('w-1', M);
    ears.heard(M.docId, { turn: 0, text: 'So we could', final: false });
    let got: HoldOutcome | null = null;
    void holds.wait('w-1', M).then((o) => {
      got = o;
    });
    await Promise.resolve();
    clock.advanceTo(HOLD_TIMING.unfinishedMs - 1);
    expect(got).toBeNull();
    clock.advanceTo(HOLD_TIMING.unfinishedMs);
    await waitFor(() => got !== null, { describe: 'the line released' });
    expect(got).toMatchObject({ said: true });

    ears.heard(M.docId, { turn: 1, text: 'Lead, what is the tide at six', final: false });
    holds.addressed('w-1', M);
    expect(await holds.wait('w-1', M)).toEqual({ said: true, waitedMs: 0, judged: 0 });

    // An ask the lead never answered does not wave through a much later line.
    holds.addressed('w-1', M);
    clock.advanceTo(clock.now() + ADDRESSED_MS + 1);
    ears.heard(M.docId, { turn: 2, text: 'And the other thing is', final: false });
    let late: HoldOutcome | null = null;
    void holds.wait('w-1', M).then((o) => {
      late = o;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(late).toBeNull();
    holds.end('w-1');
    await waitFor(() => late !== null, { describe: 'the late line dropped at the end' });
    expect(late as HoldOutcome | null).toEqual({ said: false, reason: 'ended' });
  });

  it('says at once when nothing can listen, and drops a waiting line at the end', async () => {
    const quiet = new LeadLineHolds({ ears: new MeetingEars(), setting: 'gate', judge: null });
    expect(await quiet.wait('w-2', M)).toMatchObject({ said: true, waitedMs: 0 });

    const ears = new MeetingEars();
    ears.started(M.docId);
    const clock = fakeTimers();
    const holds = new LeadLineHolds({
      ears,
      setting: 'gate',
      judge: null,
      timers: clock.timers,
      now: clock.now,
    });
    holds.listen('w-3', M);
    ears.heard(M.docId, { turn: 0, text: 'So we could', final: false });
    const waiting = holds.wait('w-3', M);
    await Promise.resolve();
    await Promise.resolve();
    holds.end('w-3');
    expect(await waiting).toEqual({ said: false, reason: 'ended' });
  });
});
