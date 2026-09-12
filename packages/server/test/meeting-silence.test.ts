/**
 * A recording that hears nothing ends itself.
 *
 * The only reason a running meeting needs a timer is to notice one with no
 * content in it (Bryan, 2026-09-12): a microphone left open after everyone has
 * gone is billed by the second the engine socket is open, and nothing else in
 * the system ever notices. So the relay counts fifteen minutes from the start
 * of a recording and from every SETTLED turn, and stops the meeting down the
 * same path a person's Stop takes when the count runs out.
 *
 * THE CLOCK IS INJECTED AND NOTHING HERE SLEEPS. The deadline runs on the
 * relay's `schedule` seam, so these tests advance a fake clock through
 * fourteen and twenty-nine minutes in no time at all — which is the only way
 * a production window of fifteen minutes is testable without either waiting it
 * out or shrinking it to something that is no longer the rule.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MeetingClient, MeetingRelay } from '../src/meeting-protocol.ts';
import {
  DEFAULT_SILENCE_TIMEOUT_MS,
  SILENCE_TIMEOUT_MS,
  resolveSilenceTimeoutMs,
} from '../src/meeting-silence.ts';
import { MeetingStore, listMeetings } from '../src/meetings.ts';
import type { EngineTurn, TranscriptionEngine, TranscriptionSession } from '../src/transcribe.ts';

/** Give an awaited continuation a chance to run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const MINUTE = 60_000;

/**
 * The clock the relay's deadline runs on, with no real time in it.
 *
 * `advance` fires whatever is due in due order, so a deadline re-armed inside
 * a callback lands where its own window says rather than immediately.
 */
class FakeClock {
  now = 0;
  private seq = 0;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  /** How many deadlines have ever been armed — the re-arm counter. */
  armed = 0;

  readonly schedule = (ms: number, fn: () => void): (() => void) => {
    const id = ++this.seq;
    this.armed += 1;
    this.pending.set(id, { at: this.now + ms, fn });
    return () => {
      this.pending.delete(id);
    };
  };

  /** Deadlines still waiting to fire. */
  get outstanding(): number {
    return this.pending.size;
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [id, entry] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (entry.at > this.now) continue;
      this.pending.delete(id);
      entry.fn();
    }
  }
}

/** An engine whose turns the test emits by hand. */
function scriptedEngine(): {
  engine: TranscriptionEngine;
  speak: (turn: EngineTurn) => void;
  closes: () => number;
} {
  let emit: ((turn: EngineTurn) => void) | null = null;
  let closed = 0;
  return {
    engine: {
      name: 'scripted',
      open: (opts): Promise<TranscriptionSession> => {
        emit = opts.onTurn;
        return Promise.resolve({
          send: () => {},
          close: () => {
            closed += 1;
            return Promise.resolve();
          },
        });
      },
    },
    speak: (turn) => emit?.(turn),
    closes: () => closed,
  };
}

/** One frame the relay wrote, or one lifecycle fact it broadcast. */
type Sent = Record<string, unknown>;

/**
 * A second socket on a relay that already exists — what a reconnect is.
 *
 * The relay outlives the connection, so `attach` is how a test reaches the
 * state that survives one. Everything else about the connection is new.
 */
function attach(relay: MeetingRelay, docId: string): { ws: MeetingClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const ws: MeetingClient = {
    data: { docId },
    send: (payload) => sent.push(JSON.parse(payload) as Sent),
  };
  relay.onOpen(ws);
  return { ws, sent };
}

function open(
  store: MeetingStore,
  docId: string,
): {
  clock: FakeClock;
  ws: MeetingClient;
  relay: MeetingRelay;
  sent: Sent[];
  broadcasts: Sent[];
  speak: (turn: EngineTurn) => void;
  closes: () => number;
} {
  const clock = new FakeClock();
  const { engine, speak, closes } = scriptedEngine();
  const sent: Sent[] = [];
  const broadcasts: Sent[] = [];
  const relay = new MeetingRelay({
    store,
    engines: [engine],
    notes: null,
    broadcast: (_docId, payload) => broadcasts.push(payload),
    schedule: clock.schedule,
    now: () => clock.now,
  });
  const ws: MeetingClient = {
    data: { docId },
    send: (payload) => sent.push(JSON.parse(payload) as Sent),
  };
  relay.onOpen(ws);
  return { clock, ws, relay, sent, broadcasts, speak, closes };
}

const startFrame = JSON.stringify({ type: 'start', sampleRate: 16000, encoding: 'pcm_s16le' });

describe('a recording with nothing in it', () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-silence-'));
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('stops itself after the window, and the record says why', async () => {
    const store = new MeetingStore(dataDir);
    const h = open(store, 'harborlight-standup');
    h.relay.onText(h.ws, startFrame);
    await settle();
    expect(h.sent.some((m) => m.type === 'ready')).toBe(true);

    // One millisecond short of the window: still recording.
    h.clock.advance(SILENCE_TIMEOUT_MS - 1);
    await settle();
    expect(h.sent.some((m) => m.type === 'stopped')).toBe(false);

    h.clock.advance(1);
    await settle();

    const stopped = h.sent.find((m) => m.type === 'stopped');
    expect(stopped).toBeDefined();
    expect(stopped?.reason).toBe('silence');
    // The same path a person's Stop takes: the engine session was closed and
    // the doc's other viewers were told the meeting is over.
    expect(h.closes()).toBe(1);
    expect(h.broadcasts.filter((b) => b.event === 'meeting.stopped').length).toBe(1);

    const record = listMeetings(dataDir, 'harborlight-standup')[0];
    expect(record?.endedAt).toBeGreaterThan(0);
    expect(record?.endedBy).toBe('silence');
    // And the doc is free: a later Record starts a fresh meeting rather than
    // being refused as already recording.
    const again = open(store, 'harborlight-standup');
    again.relay.onText(again.ws, startFrame);
    await settle();
    const ready = again.sent.find((m) => m.type === 'ready');
    expect(ready).toBeDefined();
    expect(ready?.meetingId).not.toBe(record?.meetingId);
    again.relay.onClose(again.ws);
    await settle();
  });

  it('starts the window again on settled words, and a partial does not', async () => {
    const store = new MeetingStore(dataDir);
    const h = open(store, 'riverbend-review');
    h.relay.onText(h.ws, startFrame);
    await settle();

    // Minute 14: somebody speaks, and the engine settles the turn.
    h.clock.advance(14 * MINUTE);
    h.speak({ turn: 0, text: 'the levee holds', final: true });
    await settle();

    // Another fourteen minutes — past the original deadline, inside the new
    // one. The recording is still running.
    h.clock.advance(14 * MINUTE);
    await settle();
    expect(h.sent.some((m) => m.type === 'stopped')).toBe(false);

    // A partial is the engine still revising, not evidence of content, so it
    // must not push the deadline out.
    h.speak({ turn: 1, text: 'and the', final: false });
    await settle();
    h.clock.advance(MINUTE);
    await settle();
    const stopped = h.sent.find((m) => m.type === 'stopped');
    expect(stopped?.reason).toBe('silence');
    expect(listMeetings(dataDir, 'riverbend-review')[0]?.turns).toBe(1);
  });

  it('a person stopping first cancels the deadline — no second stop', async () => {
    const store = new MeetingStore(dataDir);
    const h = open(store, 'saltmarsh-sync');
    h.relay.onText(h.ws, startFrame);
    await settle();
    expect(h.clock.outstanding).toBe(1);

    h.relay.onText(h.ws, JSON.stringify({ type: 'stop' }));
    await settle();
    expect(h.sent.filter((m) => m.type === 'stopped').length).toBe(1);
    // Nothing is left armed to fire into a meeting that is over…
    expect(h.clock.outstanding).toBe(0);
    // …and running the clock past the whole window stops nothing a second
    // time, in the record or on the wire.
    h.clock.advance(SILENCE_TIMEOUT_MS * 2);
    await settle();
    expect(h.sent.filter((m) => m.type === 'stopped').length).toBe(1);
    expect(h.broadcasts.filter((b) => b.event === 'meeting.stopped').length).toBe(1);
    const record = listMeetings(dataDir, 'saltmarsh-sync')[0];
    // A person's stop is not a timeout, and the record must not claim it was.
    expect(record?.endedBy).toBeUndefined();
  });

  it('a reconnect resumes the window it left, not a fresh one', async () => {
    const store = new MeetingStore(dataDir);
    const h = open(store, 'harborlight-retro');
    h.relay.onText(h.ws, startFrame);
    await settle();
    const meetingId = h.sent.find((m) => m.type === 'ready')?.meetingId as string;
    expect(meetingId).toBeTruthy();
    // Somebody says one thing and then the room goes quiet. The words matter
    // to the setup as well as the story: a meeting with no transcript file
    // cannot be resumed at all, so the reconnect hazard is only ever reachable
    // on a meeting that once had content.
    h.speak({ turn: 0, text: 'the tide is out', final: true });
    await settle();

    // Fourteen silent minutes, then the network drops the socket. A drop
    // STOPS the meeting — the resume below is what undoes that.
    h.clock.advance(14 * MINUTE);
    h.relay.onClose(h.ws);
    await settle();

    const again = attach(h.relay, 'harborlight-retro');
    h.relay.onText(
      again.ws,
      JSON.stringify({
        type: 'start',
        sampleRate: 16000,
        encoding: 'pcm_s16le',
        resume: meetingId,
      }),
    );
    await settle();
    expect(again.sent.find((m) => m.type === 'ready')?.resumed).toBe(true);

    // One more minute is fifteen since anyone last said anything, and that is
    // the whole window — not fifteen more starting from the reconnect. A
    // recording nobody is in must not be kept alive by a flaky network.
    h.clock.advance(MINUTE);
    await settle();
    const stopped = again.sent.find((m) => m.type === 'stopped');
    expect(stopped?.reason).toBe('silence');
    const record = listMeetings(dataDir, 'harborlight-retro')[0];
    expect(record?.meetingId).toBe(meetingId);
    expect(record?.endedBy).toBe('silence');
    // One recording, not two: the resume appended to the one that was
    // already there.
    expect(listMeetings(dataDir, 'harborlight-retro').length).toBe(1);
    expect(record?.turns).toBe(1);
  });
});

describe('the silence window', () => {
  it('is fifteen minutes unless the environment shortens it', () => {
    expect(DEFAULT_SILENCE_TIMEOUT_MS).toBe(15 * MINUTE);
    expect(resolveSilenceTimeoutMs(undefined)).toBe(DEFAULT_SILENCE_TIMEOUT_MS);
    expect(resolveSilenceTimeoutMs('')).toBe(DEFAULT_SILENCE_TIMEOUT_MS);
    expect(resolveSilenceTimeoutMs('2000')).toBe(2000);
  });

  it('refuses every value that would lengthen it or stop a meeting at once', () => {
    for (const raw of ['0', '-1', 'soon', '5', String(16 * MINUTE)]) {
      expect(resolveSilenceTimeoutMs(raw)).toBe(DEFAULT_SILENCE_TIMEOUT_MS);
    }
  });
});
