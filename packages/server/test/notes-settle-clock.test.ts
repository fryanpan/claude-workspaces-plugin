/**
 * The clock a note's lateness is read from: when its turn SETTLED, not when
 * the person started saying it.
 *
 * The goal is "each note written within 10s of its turn settling". The
 * timing row's `settledToWrittenMs` used to start at the turn's FIRST frame,
 * so a note that landed a second after a 30s answer finished read as 31s
 * late, and a ceiling slice of a long turn was billed for every word before
 * it. Both cases below fail on that clock.
 */

import { describe, expect, it } from 'bun:test';
import type { prose } from '@claude-workspaces/core';
import { type NotesComposer, type TickScheduler, beginNotesSession } from '../src/meeting-notes.ts';
import { createNotesTimingLog } from '../src/notes-timing.ts';

class ManualScheduler implements TickScheduler {
  private fns = new Map<number, () => void>();
  private n = 0;
  set(fn: () => void): unknown {
    this.n++;
    this.fns.set(this.n, fn);
    return this.n;
  }
  clear(handle: unknown): void {
    this.fns.delete(handle as number);
  }
  fire(): void {
    const pending = [...this.fns.values()];
    this.fns.clear();
    for (const fn of pending) fn();
  }
}

const edits = (markdown: string): prose.BlockEdit[] => [{ op: 'insert_at_end', markdown }];

function harness() {
  const clock = { now: 1_000 };
  const schedule = new ManualScheduler();
  const timing = createNotesTimingLog();
  const composer: NotesComposer = {
    name: 'timed',
    compose() {
      clock.now += 900; // the model call
      return Promise.resolve(edits('- the Riverbend slipway opens in May'));
    },
  };
  const session = beginNotesSession(
    {
      composer,
      quietMs: 4_000,
      cadenceMs: 6_000,
      schedule,
      now: () => clock.now,
      openTiming: () => timing,
      onNotes: () => {
        clock.now += 20; // the doc write
      },
    },
    { docId: 'doc-settle', meetingId: 'm-settle' },
  );
  return { clock, schedule, timing, session };
}

const WORDS =
  'The Riverbend slipway opens in May. Alice will book the crane for the first week. Bob checks the tide tables.'.split(
    ' ',
  );

describe('settledToWrittenMs is read from the turn settling', () => {
  it('a note written a second after a long answer ends is not late', async () => {
    const { clock, schedule, timing, session } = harness();
    // Thirty seconds of one person talking, a frame a second.
    for (let i = 1; i <= 30; i++) {
      const upto = Math.ceil((WORDS.length * i) / 31);
      session.onTurn({ turn: 0, text: WORDS.slice(0, upto).join(' '), final: false });
      clock.now += 1_000;
    }
    session.onTurn({ turn: 0, text: WORDS.join(' '), final: true });
    const settledAt = clock.now;
    clock.now += 1_000; // the endpoint confirm window
    schedule.fire();
    await session.end();

    const written = timing.rows().filter((r) => r.outcome === 'written');
    const last = written[written.length - 1];
    // 1,000 confirming the pause + 900 composing + 20 writing. The first-frame
    // clock read 31,920 here.
    expect(last?.settledAt).toBe(settledAt);
    expect(last?.settledToWrittenMs).toBe(1_920);
  });

  it('a ceiling slice of a turn still being said is timed from its last words', async () => {
    const { clock, schedule, timing, session } = harness();
    for (let i = 1; i <= 6; i++) {
      const upto = i * 3;
      session.onTurn({
        turn: 0,
        text: WORDS.slice(0, upto).join(' '),
        settledText: WORDS.slice(0, upto - 1).join(' '),
        final: false,
      });
      if (i < 6) clock.now += 1_000;
    }
    const lastGrewAt = clock.now;
    schedule.fire(); // the ceiling, with the turn still going
    await new Promise((r) => setTimeout(r, 0));
    await session.end();

    const first = timing.rows().find((r) => r.outcome === 'written');
    expect(first?.reason).toBe('cadence');
    expect(first?.settledAt).toBe(lastGrewAt);
    // The compose and the write, and nothing for the five seconds of speech
    // before the slice's last frame.
    expect(first?.settledToWrittenMs).toBe(920);
  });
});
