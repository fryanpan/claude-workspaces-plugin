/**
 * How much of a meeting was heard, and telling someone while it can still be
 * fixed — driven through the relay.
 *
 * A 188-minute meeting once reached the transcript for 68 minutes: its start
 * missed, two gaps, and its last 46 minutes gone, with nothing on screen and
 * notes that read as complete. Four behaviours answer that, one case each:
 *
 * - a minute with no audio frame is a gap in the record;
 * - the same minute raises the alert on the meeting's live coverage, and so
 *   does a socket that drops and does not come back within a minute;
 * - a page move (a drop that resumes at once) raises nothing;
 * - when the meeting stops, its notes get one coverage line.
 *
 * THE CLOCK IS FAKE AND NOTHING SLEEPS: the relay's coverage scheduler, its
 * clock and the store's clock are one `FakeClock`, so minutes pass in no time.
 * The engine settles one turn; every name is a house fixture name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MeetingCoverageLive, localClock, type prose } from '@claude-workspaces/core';
import type { NotesUpdate } from '../src/meeting-notes.ts';
import { type MeetingClient, MeetingRelay } from '../src/meeting-protocol.ts';
import { readMeetingJson } from '../src/meeting-raw.ts';
import { MeetingStore, listMeetings } from '../src/meetings.ts';
import type { TranscriptionEngine, TranscriptionSession } from '../src/transcribe.ts';
import { ManualScheduler } from './notes-tick-harness.ts';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const SECOND = 1_000;
const MINUTE = 60_000;
/** Ten seconds of 16 kHz PCM16 in one frame, so a minute is six sends. */
const TEN_SECONDS = new Uint8Array(16_000 * 2 * 10);
const T0 = Date.UTC(2026, 10, 17, 18, 0);

class FakeClock {
  now = T0;
  private seq = 0;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  readonly schedule = (ms: number, fn: () => void): (() => void) => {
    const id = ++this.seq;
    this.pending.set(id, { at: this.now + ms, fn });
    return () => {
      this.pending.delete(id);
    };
  };
  /** Move to `to`, firing whatever falls due on the way, in order. */
  advanceTo(to: number): void {
    while (true) {
      const due = [...this.pending]
        .filter(([, e]) => e.at <= to)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].fn();
    }
    this.now = to;
  }
}

/** An engine that settles one turn the moment it hears its first audio, so
 *  the meeting has notes for the stamp to qualify. */
function oneTurnEngine(): TranscriptionEngine {
  return {
    name: 'one-turn',
    open: (opts) => {
      let said = false;
      const session: TranscriptionSession = {
        send: () => {
          if (said) return;
          said = true;
          opts.onTurn({ turn: 0, text: 'The Riverbend ferry runs hourly.', final: true });
        },
        close: () => Promise.resolve(),
      };
      return Promise.resolve(session);
    },
  };
}

describe('meeting coverage', () => {
  let dataDir: string;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-coverage-'));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A relay with notes on, every coverage change, and every note written. */
  function harness(docId: string, outline: prose.OutlineEntry[] = []) {
    const clock = new FakeClock();
    const coverage: MeetingCoverageLive[] = [];
    const writes: NotesUpdate[] = [];
    const store = new MeetingStore(dataDir, {
      now: () => clock.now,
      retention: () => 'transcripts',
    });
    const relay = new MeetingRelay({
      store,
      engines: [oneTurnEngine()],
      notes: {
        composer: { name: 'never', compose: () => Promise.resolve([]) },
        schedule: new ManualScheduler(),
        readOutline: () => outline,
        notesHeadingId: () => 'h-riverbend',
        onNotes: (u: NotesUpdate) => {
          writes.push(u);
          return true;
        },
      },
      broadcast: () => {},
      now: () => clock.now,
      coverageSchedule: clock.schedule,
      onCoverage: (_docId, c) => coverage.push(c),
      log: () => {},
    });
    const socket = (): MeetingClient => {
      const ws: MeetingClient = { data: { docId }, send: () => {} };
      relay.onOpen(ws);
      return ws;
    };
    const start = async (ws: MeetingClient, resume?: string): Promise<void> => {
      relay.onText(
        ws,
        JSON.stringify({
          type: 'start',
          sampleRate: 16000,
          encoding: 'pcm_s16le',
          ...(resume ? { resume } : {}),
        }),
      );
      await settle();
    };
    /** Ten seconds pass, then their audio arrives. */
    const speak = (ws: MeetingClient, seconds: number): void => {
      for (let i = 0; i < seconds / 10; i++) {
        clock.advanceTo(clock.now + 10 * SECOND);
        relay.onAudio(ws, TEN_SECONDS);
      }
    };
    const stamps = () =>
      writes.flatMap((w) =>
        w.edits.filter((e) => 'markdown' in e && e.markdown.startsWith('Coverage:')),
      );
    const record = () => listMeetings(dataDir, docId).at(-1);
    return { clock, coverage, relay, socket, start, speak, stamps, record };
  }

  it('records a minute with no audio as a gap, closed by the next frame', async () => {
    const h = harness('harbor-gap');
    const ws = h.socket();
    await h.start(ws);
    h.speak(ws, 60);
    // Ninety seconds with no frame, then audio again.
    h.clock.advanceTo(T0 + 150 * SECOND);
    h.relay.onAudio(ws, TEN_SECONDS);
    expect(h.record()?.gaps).toEqual([
      { stream: 'mic', from: T0 + MINUTE, to: T0 + 150 * SECOND, reason: 'no-audio' },
    ]);
  });

  it('raises the alert when the audio stops, and clears it when audio returns', async () => {
    const h = harness('harbor-alert');
    const ws = h.socket();
    await h.start(ws);
    h.speak(ws, 60);
    // Positive control for the threshold: 59 s of nothing is not yet a gap.
    h.clock.advanceTo(T0 + MINUTE + 59 * SECOND);
    expect(h.coverage.some((c) => c.state === 'gap')).toBe(false);
    h.clock.advanceTo(T0 + 2 * MINUTE + SECOND);
    const alert = h.coverage.at(-1);
    expect(alert).toMatchObject({
      state: 'gap',
      gap: { from: T0 + MINUTE, reason: 'no-audio' },
      capturedMs: MINUTE,
    });
    h.relay.onAudio(ws, TEN_SECONDS);
    expect(h.coverage.at(-1)).toMatchObject({ state: 'recording', gapsClosed: 1 });
    expect(h.coverage.at(-1)?.gap).toBeUndefined();
  });

  it('raises the alert when the socket drops without a stop and does not come back', async () => {
    const outline: prose.OutlineEntry[] = [
      {
        id: 'b-old-stamp',
        kind: 'block',
        nodeName: 'paragraph',
        text: 'Coverage: captured 1 of 1 minute.',
        underHeadingId: 'h-riverbend',
      },
    ];
    const h = harness('harbor-drop', outline);
    const ws = h.socket();
    await h.start(ws);
    h.speak(ws, 120);
    const droppedAt = h.clock.now;
    h.relay.onClose(ws, 1006);
    await settle();
    expect(h.coverage.at(-1)?.state).toBe('paused');
    h.clock.advanceTo(droppedAt + MINUTE + SECOND);
    expect(h.coverage.at(-1)).toMatchObject({
      state: 'gap',
      gap: { from: droppedAt, reason: 'connection' },
    });
    // Nothing resumes it: once the browser has given up, the notes are stamped
    // and the stamp says how it ended, replacing the earlier stamp in place.
    expect(h.stamps()).toEqual([]);
    h.clock.advanceTo(droppedAt + 3 * MINUTE);
    expect(h.coverage.at(-1)?.state).toBe('stopped');
    expect(h.stamps()).toEqual([
      {
        op: 'replace_block',
        blockId: 'b-old-stamp',
        markdown: `Coverage: captured 2 of 2 minutes. The recording stopped at ${localClock(droppedAt)} when its connection was lost.`,
      },
    ]);
  });

  it('raises nothing for a page move, which resumes within a second', async () => {
    const h = harness('harbor-move');
    const first = h.socket();
    await h.start(first);
    h.speak(first, 30);
    const meetingId = h.coverage.at(-1)?.meetingId ?? '';
    h.relay.onClose(first, 1001);
    await settle();
    h.clock.advanceTo(h.clock.now + 400);
    const second = h.socket();
    await h.start(second, meetingId);
    h.speak(second, 90);
    h.clock.advanceTo(h.clock.now + 30 * SECOND);
    expect(h.coverage.map((c) => c.state)).not.toContain('gap');
    expect(h.coverage.at(-1)).toMatchObject({ meetingId, state: 'recording' });
    // The resumed leg starts from what the first leg heard.
    expect(h.coverage.at(-1)?.capturedMs).toBe(30 * SECOND);
    expect(h.stamps()).toEqual([]);
  });

  it('stamps the notes with their coverage when the meeting stops', async () => {
    const docId = 'riverbend-stamp';
    const h = harness(docId);
    const ws = h.socket();
    await h.start(ws);
    h.speak(ws, 180);
    // A gap from the last frame at 3:00 until audio returns at 5:10.
    h.clock.advanceTo(T0 + 5 * MINUTE);
    h.speak(ws, 120);
    expect(h.clock.now).toBe(T0 + 7 * MINUTE);
    h.relay.onText(ws, JSON.stringify({ type: 'stop' }));
    await settle();
    await settle();
    const gap = `${localClock(T0 + 3 * MINUTE)}–${localClock(T0 + 5 * MINUTE + 10 * SECOND)}`;
    expect(h.stamps()).toEqual([
      {
        op: 'insert_under_heading',
        headingId: 'h-riverbend',
        markdown: `Coverage: captured 5 of 7 minutes; gaps at ${gap}.`,
      },
    ]);
    const meetingId = h.record()?.meetingId;
    const segment = readMeetingJson(dataDir, docId)?.segments.find(
      (s) => s.meetingId === meetingId,
    );
    expect(segment?.coverage).toEqual({
      capturedMs: 290 * SECOND,
      elapsedMs: 7 * MINUTE,
      gaps: [{ from: T0 + 3 * MINUTE, to: T0 + 5 * MINUTE + 10 * SECOND }],
    });
    expect(h.record()?.audioMs).toBe(5 * MINUTE);
  });
});
