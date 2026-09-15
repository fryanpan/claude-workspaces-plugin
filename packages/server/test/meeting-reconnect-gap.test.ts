/**
 * A reconnect records the stretch it lost.
 *
 * A meeting whose socket drops loses the audio spoken while it is down —
 * deliberately, so a minute of banked speech is never pushed into a freshly
 * opened session billed by the second. What was NOT true is that the record
 * said so: a gap was written only when the browser reported one of its own
 * captures dying or muting, so a meeting that dropped its socket five times
 * and lost half a minute of talk read back as complete. The outage is a fact
 * the server can see on its own — the leg it ended, and the leg that picked
 * the meeting up again — and this file is that arithmetic.
 *
 * THE TIMESTAMPS ARE THE FIXTURE, for the reason `meeting-gaps-resume.test.ts`
 * gives at length: `stop()` stamps the real now, so the first leg's end is
 * corrected by one more append-only line before the resume that follows it.
 *
 * All fixtures are synthetic; the repo is public.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MeetingClient, MeetingRelay } from '../src/meeting-protocol.ts';
import { type MeetingGap, MeetingStore, listMeetings, meetingIndexPath } from '../src/meetings.ts';
import type { TranscriptionEngine } from '../src/transcribe.ts';

const dirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-reconnect-gap-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.now();
const STARTED = NOW - 600_000;
/** The socket went at this instant, and came back thirty seconds later. */
const DROPPED = NOW - 300_000;
const RESUMED = DROPPED + 30_000;

/**
 * One meeting recorded, dropped at `DROPPED`, and picked up again.
 *
 * `source` is what the capture was carrying — one microphone, or a microphone
 * plus the Mac's own audio, which is the case the "on every stream" half of
 * this is about.
 */
function droppedAndResumed(
  dir: string,
  opts: { source?: 'mic' | 'mic+system'; heldMs?: number } = {},
): MeetingGap[] {
  const store = new MeetingStore(dir, { docInfo: () => ({ title: 'Weekly sync' }) });
  const first = store.start({
    docId: 'd1',
    engine: 'mock',
    sampleRate: 16_000,
    mode: 'conversation',
    ...(opts.source ? { source: opts.source } : {}),
    now: STARTED,
  });
  if (!first) throw new Error('the doc was already recording');
  first.recordTurn(0, 'Before the socket dropped.');
  const meetingId = first.meetingId;
  first.stop();
  // `stop()` stamps the real clock; the fixture needs the drop in the past.
  appendFileSync(
    meetingIndexPath(dir, 'd1'),
    `${JSON.stringify({ meetingId, endedAt: DROPPED })}\n`,
  );
  const again = store.resume({
    docId: 'd1',
    meetingId,
    engine: 'mock',
    sampleRate: 16_000,
    mode: 'conversation',
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.heldMs !== undefined ? { heldMs: opts.heldMs } : {}),
    now: RESUMED,
  });
  if (!again) throw new Error('the resume was refused');
  return listMeetings(dir, 'd1').find((m) => m.meetingId === meetingId)?.gaps ?? [];
}

describe('a reconnect records the stretch it lost', () => {
  it('writes a gap matching the outage', () => {
    const gaps = droppedAndResumed(dataDir());
    expect(gaps).toEqual([{ stream: 'mic', from: DROPPED, to: RESUMED, reason: 'reconnect' }]);
  });

  it('writes one on every stream the meeting was carrying', () => {
    const gaps = droppedAndResumed(dataDir(), { source: 'mic+system' });
    expect(gaps.map((g) => g.stream).sort()).toEqual(['mic', 'system']);
    for (const gap of gaps) {
      expect(gap.from).toBe(DROPPED);
      expect(gap.to).toBe(RESUMED);
    }
  });

  it('shortens the gap by the audio the browser carried across', () => {
    // The client banked the last ten seconds of the outage and replayed them,
    // so only the twenty seconds before that were never heard.
    const gaps = droppedAndResumed(dataDir(), { heldMs: 10_000 });
    expect(gaps).toEqual([
      { stream: 'mic', from: DROPPED, to: RESUMED - 10_000, reason: 'reconnect' },
    ]);
  });

  it('writes no gap at all when the hold covered the whole outage', () => {
    // Nothing was lost, so the record must not claim a hole. A gap of zero
    // length would read as "the microphone stopped for 0s" in the companion.
    expect(droppedAndResumed(dataDir(), { heldMs: 60_000 })).toEqual([]);
  });

  it('leaves a capture that was already down alone', () => {
    // A stream the browser reported dead before the drop is STILL dead, and
    // its gap is still open. The reconnect's own gap must not be mistaken for
    // that one's closing half — which is what would happen if the close line
    // found the wrong open gap on the same stream.
    const dir = dataDir();
    const store = new MeetingStore(dir, { docInfo: () => ({ title: 'Weekly sync' }) });
    const first = store.start({
      docId: 'd1',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'conversation',
      source: 'mic+system',
      now: STARTED,
    });
    if (!first) throw new Error('the doc was already recording');
    first.recordTurn(0, 'Before the Mac audio died.');
    first.recordGap('system', 'lost', 'ended');
    const meetingId = first.meetingId;
    first.stop();
    appendFileSync(
      meetingIndexPath(dir, 'd1'),
      `${JSON.stringify({ meetingId, endedAt: DROPPED })}\n`,
    );
    const again = store.resume({
      docId: 'd1',
      meetingId,
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'conversation',
      source: 'mic+system',
      now: RESUMED,
    });
    if (!again) throw new Error('the resume was refused');
    const gaps = listMeetings(dir, 'd1').find((m) => m.meetingId === meetingId)?.gaps ?? [];
    // The capture that died is still open; both reconnect gaps are closed.
    const stillOpen = gaps.filter((g) => g.to === null);
    expect(stillOpen.length).toBe(1);
    expect(stillOpen[0]?.stream).toBe('system');
    expect(stillOpen[0]?.reason).toBe('ended');
    expect(gaps.filter((g) => g.reason === 'reconnect').length).toBe(2);
  });
});

/**
 * The instant the outage STARTS at, when the meeting ends the slow way.
 *
 * `MeetingStore.stop()` stamps the clock at the moment it is called, and the
 * relay calls it last: the engine session is closed and the notes are flushed
 * first, both awaited, so the meeting's own record can be stamped seconds
 * after the socket it was recording went away. Every one of those seconds is
 * audio the browser has already lost — it has nowhere to send it — and a gap
 * measured from the stamp claims they were recorded. With a bounded hold
 * replaying the tail, a teardown as long as the hold erases the gap entirely.
 *
 * So the relay carries the instant the socket closed down to the record.
 */
describe('the outage starts when the socket closed', () => {
  /** How long the engine and notes take to flush after the socket is gone. */
  const TEARDOWN_MS = 5_000;

  /** Give an awaited handshake or teardown continuation a chance to run. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  function client(docId: string): MeetingClient {
    return { data: { docId }, send() {} };
  }

  it('measures from the close, not from the end of teardown', async () => {
    const dir = dataDir();
    // Timing IS the behaviour here, so the clock is injected and advanced by
    // the teardown itself rather than read off the machine.
    let clock = STARTED;
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const release: { fire: (() => void) | null } = { fire: null };
      const slowEngine: TranscriptionEngine = {
        name: 'mock',
        open: () =>
          Promise.resolve({
            send: () => {},
            close: () =>
              new Promise<void>((resolve) => {
                release.fire = () => {
                  clock += TEARDOWN_MS;
                  resolve();
                };
              }),
          }),
      };
      const relay = new MeetingRelay({
        store: new MeetingStore(dir),
        engines: [slowEngine],
        notes: null,
        broadcast: () => {},
        log: () => {},
      });
      const first = client('d2');
      relay.onOpen(first);
      relay.onText(
        first,
        JSON.stringify({ type: 'start', sampleRate: 16_000, encoding: 'pcm_s16le' }),
      );
      await settle();
      const meetingId = listMeetings(dir, 'd2')[0]?.meetingId;
      expect(meetingId).toBeDefined();

      clock = DROPPED;
      relay.onClose(first, 1006);
      await settle();
      expect(release.fire).not.toBeNull();
      release.fire?.();
      await settle();

      clock = RESUMED;
      const second = client('d2');
      relay.onOpen(second);
      relay.onText(
        second,
        JSON.stringify({
          type: 'start',
          sampleRate: 16_000,
          encoding: 'pcm_s16le',
          resume: meetingId,
        }),
      );
      await settle();

      const gaps = listMeetings(dir, 'd2').find((m) => m.meetingId === meetingId)?.gaps ?? [];
      expect(gaps).toEqual([{ stream: 'mic', from: DROPPED, to: RESUMED, reason: 'reconnect' }]);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
