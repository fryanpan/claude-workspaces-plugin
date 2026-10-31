/**
 * The board's lead in its meeting (`lead-chat/meeting-feed.ts`): told once
 * when the meeting starts, then sent what the room settles, batched so a
 * run of short turns costs the lead one turn rather than one each, and
 * never later than `LEAD_MEETING_BATCH_MS` after a line settled.
 *
 * The clock is injected: these cases assert the order and the content of
 * what reached the lead at each step of a manual scheduler, never how long
 * the machine took.
 */
import { describe, expect, it } from 'bun:test';
import {
  LEAD_MEETING_BATCH_MS,
  LEAD_MEETING_HEARD_EVENT,
  LEAD_MEETING_STARTED_EVENT,
  LeadMeetingFeed,
} from '../src/lead-chat/meeting-feed.ts';
import type { TickScheduler } from '../src/pause-ticker.ts';

class ManualClock implements TickScheduler {
  at = 1_000;
  private timers = new Map<number, { due: number; fn: () => void }>();
  private n = 0;
  set(fn: () => void, ms: number): unknown {
    this.n++;
    this.timers.set(this.n, { due: this.at + ms, fn });
    return this.n;
  }
  clear(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  advance(ms: number): void {
    this.at += ms;
    for (const [id, t] of [...this.timers]) {
      if (t.due <= this.at) {
        this.timers.delete(id);
        t.fn();
      }
    }
  }
}

const MEETING = {
  id: 'lcm-1',
  docId: 'riverbend-sync',
  docTitle: 'Riverbend sync',
  by: { id: 'known-alice', name: 'Alice' },
};

class ClockedSends {
  clock = new ManualClock();
  sent: Array<{
    workspaceId: string;
    agentId: string;
    frame: Record<string, unknown>;
    at: number;
  }> = [];
}

function setup(lead: string | null = 'harborlight-lead') {
  const clock = new ClockedSends();
  const feed = new LeadMeetingFeed({
    leadOf: () => lead,
    send: (workspaceId, agentId, frame) => {
      clock.sent.push({ workspaceId, agentId, frame, at: clock.clock.at });
      return 1;
    },
    schedule: clock.clock,
    now: () => clock.clock.at,
  });
  return { feed, clock: clock.clock, sent: clock.sent };
}

describe('the lead in its meeting', () => {
  it('tells the lead the meeting started, at once, naming its doc', () => {
    const { feed, sent } = setup();
    feed.started('w-harbor', MEETING);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.agentId).toBe('harborlight-lead');
    expect(sent[0]?.frame).toMatchObject({
      event: LEAD_MEETING_STARTED_EVENT,
      workspaceId: 'w-harbor',
      meetingId: 'lcm-1',
      docId: 'riverbend-sync',
      docTitle: 'Riverbend sync',
      actor: { id: 'known-alice', name: 'Alice' },
    });
  });

  it('sends each settled line within the batch window, in the order said, one frame per window', () => {
    const { feed, clock, sent } = setup();
    feed.started('w-harbor', MEETING);
    const t0 = clock.at;
    feed.heard('w-harbor', MEETING, { turn: 0, who: 'Alice', text: 'The ferry runs at six.' });
    clock.advance(300);
    feed.heard('w-harbor', MEETING, { turn: 1, who: 'Bob', text: 'Saltmarsh opens at nine.' });
    // Inside the window nothing has gone yet: the two lines travel together.
    clock.advance(LEAD_MEETING_BATCH_MS - 301);
    expect(sent.map((s) => s.frame.event)).toEqual([LEAD_MEETING_STARTED_EVENT]);
    clock.advance(1);
    expect(sent.map((s) => s.frame.event)).toEqual([
      LEAD_MEETING_STARTED_EVENT,
      LEAD_MEETING_HEARD_EVENT,
    ]);
    const heard = sent[1];
    expect(heard?.frame.lines).toEqual([
      { turn: 0, who: 'Alice', text: 'The ferry runs at six.' },
      { turn: 1, who: 'Bob', text: 'Saltmarsh opens at nine.' },
    ]);
    expect(heard?.frame.actor).toEqual({ id: 'known-alice', name: 'Alice' });
    // The first line's wait is the window, inside the 2s the lead is promised.
    expect((heard?.at ?? 0) - t0).toBe(LEAD_MEETING_BATCH_MS);
    expect(LEAD_MEETING_BATCH_MS).toBeLessThan(2_000);

    // A line after the flush opens a window of its own.
    feed.heard('w-harbor', MEETING, { turn: 2, who: 'Alice', text: 'Riverbend next.' });
    clock.advance(LEAD_MEETING_BATCH_MS);
    expect(sent.at(-1)?.frame.lines).toEqual([{ turn: 2, who: 'Alice', text: 'Riverbend next.' }]);
  });

  it('sends what is held when the meeting ends, and nothing after', () => {
    const { feed, clock, sent } = setup();
    feed.heard('w-harbor', MEETING, { turn: 0, who: 'Alice', text: 'Last word.' });
    feed.ended('w-harbor');
    expect(sent.map((s) => s.frame.lines)).toEqual([
      [{ turn: 0, who: 'Alice', text: 'Last word.' }],
    ]);
    clock.advance(LEAD_MEETING_BATCH_MS * 2);
    expect(sent).toHaveLength(1);
  });

  it('sends nothing to an empty lead seat, and drops what it held', () => {
    const { feed, clock, sent } = setup(null);
    feed.started('w-harbor', MEETING);
    feed.heard('w-harbor', MEETING, { turn: 0, who: 'Alice', text: 'Anyone there?' });
    clock.advance(LEAD_MEETING_BATCH_MS);
    expect(sent).toEqual([]);
  });
});
