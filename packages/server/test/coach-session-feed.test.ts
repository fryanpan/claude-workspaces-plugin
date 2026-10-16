/**
 * The coach session's feed: a frame is addressed on the Coach board to its
 * lead, and only while that lead holds a stream. What he does while it is
 * away waits, on disk across a restart, and goes as one digest when it is
 * back. What he does arrives as one digest per window, at
 * most every 15 minutes and only when the window holds something; his
 * answers and his setting arrive as they happen.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoachBacklog } from '../src/coach/backlog.ts';
import { DIGEST_WINDOW_MS, SessionFeed, type SessionFrame } from '../src/coach/session-feed.ts';

/** A clock and a timer the test moves by hand. */
function fakeTime(start = 1_000_000) {
  let now = start;
  const timers: { due: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const t = { due: now + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = timers.filter((t) => t.live && t.due <= end).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        now = next.due;
        next.live = false;
        next.fn();
      }
      now = end;
    },
    pending: () => timers.filter((t) => t.live).length,
  };
}

function feed(
  opts: {
    lead?: boolean;
    connected?: boolean;
    took?: number;
    today?: number;
    limit?: number;
    time?: ReturnType<typeof fakeTime>;
  } = {},
) {
  const sent: [string, string, SessionFrame][] = [];
  const turns: number[] = [];
  const time = opts.time ?? fakeTime();
  const f = new SessionFeed({
    now: time.now,
    schedule: time.schedule,
    countTurn: (at) => turns.push(at),
    lead: () => (opts.lead === false ? null : { workspaceId: 'w-coach', agentId: 'agent-coach' }),
    connected: () => opts.connected ?? true,
    send: (ws, agent, frame) => {
      sent.push([ws, agent, frame]);
      return opts.took ?? 1;
    },
    eventsOn: () => opts.today ?? 0,
    planBoard: () => undefined,
    timeZone: () => 'UTC',
    ...(opts.limit === undefined ? {} : { dailyLimit: opts.limit }),
  });
  return { f, sent, turns, time };
}

const viewNews = (docId: string) => ({
  event: 'coach.event' as const,
  kind: 'view' as const,
  boardId: 'w-harbor',
  board: 'Harborlight',
  docId,
  text: 'The passage in view.',
});

describe('SessionFeed', () => {
  it('addresses each frame to the lead on the Coach board, stamped with its time', () => {
    const { f, sent } = feed();
    expect(f.reachable()).toBe(true);
    expect(f.send({ event: 'coach.preference', readiness: 'more' }, 42)).toBe(true);
    expect(sent).toEqual([
      [
        'w-coach',
        'agent-coach',
        { event: 'coach.preference', readiness: 'more', workspaceId: 'w-coach', at: 42 },
      ],
    ]);
  });

  it('sends nothing with no lead or a lead holding no stream, and says when no stream took it', () => {
    for (const opts of [{ lead: false }, { connected: false }]) {
      const { f, sent } = feed(opts);
      expect(f.reachable()).toBe(false);
      expect(f.send({ event: 'coach.preference', readiness: 'less' }, 1)).toBe(false);
      expect(sent).toEqual([]);
    }
    expect(feed({ took: 0 }).f.send({ event: 'coach.preference', readiness: 'less' }, 1)).toBe(
      false,
    );
  });

  it('sends nothing once the day’s turns reach the budget, 400 by default', () => {
    const under = feed({ today: 399 });
    expect(under.f.paused(1)).toBe(false);
    expect(under.f.send({ event: 'coach.preference', readiness: 'more' }, 1)).toBe(true);
    const at = feed({ today: 400 });
    expect(at.f.paused(1)).toBe(true);
    expect(at.f.send({ event: 'coach.preference', readiness: 'more' }, 1)).toBe(false);
    expect(at.sent).toEqual([]);
    const lower = feed({ today: 3, limit: 3 });
    expect(lower.f.send({ event: 'coach.preference', readiness: 'more' }, 1)).toBe(false);
  });
});

describe('the digest', () => {
  it('turns 50 views in 15 minutes into one frame, sent when the window closes', () => {
    const { f, sent, turns, time } = feed();
    const start = time.now();
    for (let i = 0; i < 50; i += 1) {
      expect(f.send(viewNews(i % 2 === 0 ? 'd-post' : 'd-hover'), time.now())).toBe(true);
      time.advance(15_000);
    }
    expect(sent).toEqual([]);
    time.advance(DIGEST_WINDOW_MS - 50 * 15_000);
    expect(sent).toHaveLength(1);
    const frame = sent[0]?.[2];
    expect(frame).toMatchObject({
      event: 'coach.digest',
      workspaceId: 'w-coach',
      from: start,
      to: start + DIGEST_WINDOW_MS,
    });
    const items = frame?.event === 'coach.digest' ? frame.items : [];
    expect(items).toHaveLength(50);
    expect(items.every((i) => i.kind === 'view' && !('text' in i))).toBe(true);
    expect(turns).toEqual([start + DIGEST_WINDOW_MS]);
  });

  it('collapses a stay in one place to one line, and keeps what he wrote', () => {
    const { f, sent, time } = feed();
    for (let i = 0; i < 50; i += 1) {
      f.send({ ...viewNews('d-post'), heading: `Part ${i % 2}` }, time.now());
      time.advance(10_000);
    }
    f.send(
      {
        event: 'coach.event',
        kind: 'wrote',
        boardId: 'w-harbor',
        docId: 'd-post',
        text: 'Berths are free.',
      },
      time.now(),
    );
    time.advance(DIGEST_WINDOW_MS);
    const frame = sent[0]?.[2];
    expect(frame?.event === 'coach.digest' && frame.items).toEqual([
      expect.objectContaining({
        kind: 'view',
        docId: 'd-post',
        minutes: 15,
        headings: ['Part 0', 'Part 1'],
      }),
      expect.objectContaining({ kind: 'wrote', text: 'Berths are free.' }),
    ]);
  });

  it('sends at most one digest per 15 minutes, and none for a quiet window', () => {
    const { f, sent, time } = feed();
    f.send(viewNews('d-post'), time.now());
    time.advance(DIGEST_WINDOW_MS);
    expect(sent).toHaveLength(1);
    time.advance(3 * DIGEST_WINDOW_MS);
    expect(sent).toHaveLength(1);
    expect(time.pending()).toBe(0);
    const second = time.now();
    f.send(viewNews('d-hover'), second);
    time.advance(DIGEST_WINDOW_MS - 1);
    expect(sent).toHaveLength(1);
    time.advance(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.[2]).toMatchObject({ from: second });
  });

  it('sends his answers and his setting at once, outside the window', () => {
    const { f, sent, time } = feed();
    f.send(viewNews('d-post'), time.now());
    f.send({ event: 'coach.preference', readiness: 'less' }, time.now());
    expect(sent.map(([, , fr]) => fr.event)).toEqual(['coach.preference']);
  });

  it('holds what he does while the session is away, and sends every waiting window as one digest when it is back', () => {
    const away = feed({ connected: false });
    expect(away.f.send(viewNews('d-post'), away.time.now())).toBe(true);
    let connected = true;
    const time = fakeTime();
    const sent: SessionFrame[] = [];
    const turns: number[] = [];
    const f = new SessionFeed({
      now: time.now,
      schedule: time.schedule,
      countTurn: (at) => turns.push(at),
      lead: () => ({ workspaceId: 'w-coach', agentId: 'agent-coach' }),
      connected: () => connected,
      send: (_w, _a, fr) => {
        sent.push(fr);
        return 1;
      },
      eventsOn: () => 0,
      planBoard: () => undefined,
      timeZone: () => 'UTC',
    });
    const start = time.now();
    f.send(viewNews('d-post'), time.now());
    connected = false;
    time.advance(DIGEST_WINDOW_MS);
    f.send(viewNews('d-hover'), time.now());
    time.advance(DIGEST_WINDOW_MS);
    expect(sent).toEqual([]);
    connected = true;
    f.reconnected();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event: 'coach.digest',
      from: start,
      to: start + 2 * DIGEST_WINDOW_MS,
      windows: 2,
    });
    const items = sent[0]?.event === 'coach.digest' ? sent[0].items : [];
    expect(items.map((i) => i.docId)).toEqual(['d-post', 'd-hover']);
    expect(turns).toHaveLength(1);
    f.reconnected();
    expect(sent).toHaveLength(1);
  });

  it('keeps a held window across a restart, open or closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coach-backlog-'));
    try {
      const time = fakeTime();
      let connected = false;
      const sent: SessionFrame[] = [];
      const make = (clock = time) =>
        new SessionFeed({
          now: clock.now,
          schedule: clock.schedule,
          countTurn: () => {},
          lead: () => ({ workspaceId: 'w-coach', agentId: 'agent-coach' }),
          connected: () => connected,
          send: (_w, _a, fr) => {
            sent.push(fr);
            return 1;
          },
          eventsOn: () => 0,
          planBoard: () => undefined,
          timeZone: () => 'UTC',
          backlog: new CoachBacklog(dir, time.now()),
        });
      const first = make();
      first.send(viewNews('d-post'), time.now());
      first.stop();
      const second = make();
      connected = true;
      second.reconnected();
      expect(sent).toHaveLength(1);
      const items = sent[0]?.event === 'coach.digest' ? sent[0].items : [];
      expect(items.map((i) => i.docId)).toEqual(['d-post']);
      second.stop();
      const third = make();
      third.reconnected();
      expect(sent).toHaveLength(1);
      third.stop();
      // A crash: the open window was written as it filled, and the next
      // feed closes it when it would have closed.
      const crashed = make(fakeTime(time.now()));
      crashed.send(viewNews('d-hover'), time.now());
      const after = make();
      time.advance(DIGEST_WINDOW_MS);
      expect(sent).toHaveLength(2);
      const resumed = sent[1]?.event === 'coach.digest' ? sent[1].items : [];
      expect(resumed.map((i) => i.docId)).toEqual(['d-hover']);
      after.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says each prompt in a few words through the summariser, and falls back to its own words', async () => {
    for (const reply of [['Asked for a berth chart'], null]) {
      const time = fakeTime();
      const sent: SessionFrame[] = [];
      const asked: string[][] = [];
      const f = new SessionFeed({
        now: time.now,
        schedule: time.schedule,
        countTurn: () => {},
        lead: () => ({ workspaceId: 'w-coach', agentId: 'agent-coach' }),
        connected: () => true,
        send: (_w, _a, fr) => {
          sent.push(fr);
          return 1;
        },
        eventsOn: () => 0,
        planBoard: () => undefined,
        timeZone: () => 'UTC',
        summarizer: async (marks) => {
          asked.push(marks.map((m) => m.text));
          return reply;
        },
      });
      const text = 'Draw the Harborlight berth chart for the spring tides';
      f.prompt(
        {
          boardId: 'w-harbor',
          board: 'Harborlight',
          session: 's1',
          repo: 'harborlight',
          at: time.now(),
          text,
        },
        true,
      );
      time.advance(DIGEST_WINDOW_MS);
      await f.idle();
      expect(asked).toEqual([[text]]);
      const sessions = sent[0]?.event === 'coach.digest' ? sent[0].sessions : [];
      expect(sessions).toMatchObject([
        {
          boardId: 'w-harbor',
          repo: 'harborlight',
          activity: [{ kind: 'prompt', summary: reply?.[0] ?? text }],
        },
      ]);
      expect(JSON.stringify(sent)).toContain(reply?.[0] ?? text);
    }
  });

  it('stop cancels a window still open', () => {
    const { f, sent, time } = feed();
    f.send(viewNews('d-post'), time.now());
    f.stop();
    time.advance(DIGEST_WINDOW_MS);
    expect(sent).toEqual([]);
  });
});
