/**
 * A digest gives each typed prompt and turn end its text in full beside its
 * one-line summary (Bryan, 2026-10-18: the 120-character lines read as cut
 * off), up to the per-mark cap the wiring already applies.
 */
import { describe, expect, it } from 'bun:test';
import { DIGEST_WINDOW_MS, SessionFeed, type SessionFrame } from '../src/coach/session-feed.ts';
import { DIGEST_TEXT_CHARS, type SessionActivity } from '../src/coach/session-minutes.ts';

function harness(summarizer?: (n: number) => (string | null)[] | null) {
  let now = 1_000_000;
  const timers: { due: number; fn: () => void; live: boolean }[] = [];
  const sent: SessionFrame[] = [];
  const f = new SessionFeed({
    now: () => now,
    schedule: (fn, ms) => {
      const t = { due: now + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    countTurn: () => {},
    lead: () => ({ workspaceId: 'w-coach', agentId: 'agent-coach' }),
    connected: () => true,
    send: (_w, _a, frame) => {
      sent.push(frame);
      return 1;
    },
    eventsOn: () => 0,
    planBoard: () => undefined,
    timeZone: () => 'UTC',
    ...(summarizer ? { summarizer: async (marks) => summarizer(marks.length) } : {}),
  });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.live && t.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      now = next.due;
      next.live = false;
      next.fn();
    }
    now = end;
  };
  const mark = { boardId: 'w-harbor', board: 'Harborlight', session: 's1', repo: 'harborlight' };
  return { f, sent, advance, mark, now: () => now };
}

/** `n` characters of words, so a squash or a cut would show. */
const words = (seed: string, n: number) => `${`${seed} `.repeat(n).slice(0, n - 1)}.`;

const activityOf = (sent: SessionFrame[]): SessionActivity[] => {
  const d = sent[0];
  return d?.event === 'coach.digest' ? d.sessions.flatMap((s) => s.activity ?? []) : [];
};

describe('coach digest full text', () => {
  it('carries a 900-character prompt and turn end whole, beside their lines', async () => {
    // A model line, and none: each mark then falls back to its own first words.
    for (const summarizer of [(n: number) => Array(n).fill('A short line'), () => null]) {
      const { f, sent, advance, mark, now } = harness(summarizer);
      const prompt = words('tide', 900);
      const turn = words('berth', 900);
      expect(prompt).toHaveLength(900);
      f.prompt({ ...mark, at: now(), text: prompt }, true);
      advance(60_000);
      f.turn({ ...mark, at: now(), text: turn });
      advance(DIGEST_WINDOW_MS);
      await f.idle();
      const activity = activityOf(sent);
      expect(activity.map((a) => a.kind)).toEqual(['prompt', 'turn']);
      expect(activity.map((a) => a.text)).toEqual([prompt, turn]);
      for (const a of activity) expect(a.summary.length).toBeLessThanOrEqual(120);
    }
  });

  it('drops full text from the oldest marks first past the budget, and says how many', async () => {
    const { f, sent, advance, mark, now } = harness((n) => Array(n).fill('A short line'));
    // 25 marks at the 2,000-character cap, across two sessions, ten seconds apart.
    const texts: string[] = [];
    for (let i = 0; i < 25; i++) {
      const text = words(`m${String(i).padStart(2, '0')}`, 2_000);
      texts.push(text);
      const m = { ...mark, session: i % 2 === 0 ? 's1' : 's2', at: now(), text };
      if (i < 2) f.prompt(m, true);
      else f.turn(m);
      advance(10_000);
    }
    advance(DIGEST_WINDOW_MS);
    await f.idle();
    const digest = sent[0];
    if (digest?.event !== 'coach.digest') throw new Error('no digest');
    const fit = Math.floor(DIGEST_TEXT_CHARS / 2_000);
    expect(digest.textDropped).toBe(25 - fit);
    const activity = activityOf(sent).sort((a, b) => a.at - b.at);
    expect(activity).toHaveLength(25);
    expect(activity.every((a) => a.summary === 'A short line')).toBe(true);
    expect(activity.map((a) => a.text)).toEqual([
      ...Array(25 - fit).fill(undefined),
      ...texts.slice(25 - fit),
    ]);
  });

  it('says nothing was dropped when the text fits', async () => {
    const { f, sent, advance, mark, now } = harness((n) => Array(n).fill('A short line'));
    f.prompt({ ...mark, at: now(), text: words('tide', 2_000) }, true);
    advance(DIGEST_WINDOW_MS);
    await f.idle();
    expect(sent[0]).not.toHaveProperty('textDropped');
  });
});
