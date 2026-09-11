/**
 * A stretch of a meeting nobody heard, in the durable record.
 *
 * The bug: a capture dies, the socket stays healthy, and the transcript's
 * turns run from before the outage straight into the ones after it. That
 * record is indistinguishable from a true one, so nothing ever prompts anybody
 * to go looking for the words that were lost. These drive the loss down the
 * real socket path and read the files back off disk.
 *
 * All fixtures are synthetic; the repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MeetingClient, MeetingRelay } from '../src/meeting-protocol.ts';
import {
  formatGapDuration,
  formatRawSegment,
  rawTranscriptPath,
  readMeetingJson,
} from '../src/meeting-raw.ts';
import { MeetingStore, listMeetings, meetingIndexPath } from '../src/meetings.ts';
import { createMockTranscriptionEngine } from '../src/transcribe.ts';

const dirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-gaps-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function begin(dir: string, docId = 'd1') {
  const store = new MeetingStore(dir, { docInfo: () => ({ title: 'Weekly sync' }) });
  const meeting = store.start({ docId, engine: 'mock', sampleRate: 16_000, mode: 'conversation' });
  if (!meeting) throw new Error('the doc was already recording');
  return { store, meeting };
}

describe('a capture that stops delivering', () => {
  it('opens a gap in the index and closes it when the stream comes back', () => {
    const dir = dataDir();
    const { meeting } = begin(dir);
    meeting.recordTurn(0, 'Before the share started.');
    meeting.recordGap('system', 'lost', 'ended');
    meeting.recordGap('system', 'restored');
    meeting.recordTurn(1, 'And after it came back.');
    const record = meeting.stop();

    expect(record.gaps).toHaveLength(1);
    const gap = record.gaps?.[0];
    expect(gap?.stream).toBe('system');
    expect(gap?.reason).toBe('ended');
    expect(gap?.to).not.toBeNull();
  });

  it('leaves a gap OPEN when the capture never came back', () => {
    // The difference between "it came back" and "it never did" is the whole
    // point: one is an interruption, the other is the rest of the meeting.
    const dir = dataDir();
    const { meeting } = begin(dir);
    meeting.recordGap('mic', 'lost', 'ended');
    const record = meeting.stop();
    expect(record.gaps?.[0]?.to).toBeNull();
  });

  it('opens no second gap when the same loss is reported twice', () => {
    const dir = dataDir();
    const { meeting } = begin(dir);
    meeting.recordGap('system', 'lost', 'ended');
    meeting.recordGap('system', 'lost', 'ended');
    expect(meeting.stop().gaps).toHaveLength(1);
  });

  it('writes nothing for a restore of a stream that was never down', () => {
    const dir = dataDir();
    const { meeting } = begin(dir);
    meeting.recordGap('system', 'restored');
    expect(meeting.stop().gaps).toBeUndefined();
  });

  it('keeps two streams’ outages apart', () => {
    const dir = dataDir();
    const { meeting } = begin(dir);
    meeting.recordGap('mic', 'lost', 'ended');
    meeting.recordGap('system', 'lost', 'muted');
    meeting.recordGap('mic', 'restored');
    const gaps = meeting.stop().gaps ?? [];
    expect(gaps.map((g) => g.stream).sort()).toEqual(['mic', 'system']);
    expect(gaps.find((g) => g.stream === 'mic')?.to).not.toBeNull();
    expect(gaps.find((g) => g.stream === 'system')?.to).toBeNull();
  });

  it('records a second, separate outage on a stream that died twice', () => {
    const dir = dataDir();
    const { meeting } = begin(dir);
    meeting.recordGap('system', 'lost', 'ended');
    meeting.recordGap('system', 'restored');
    meeting.recordGap('system', 'lost', 'ended');
    meeting.recordGap('system', 'restored');
    const gaps = meeting.stop().gaps ?? [];
    expect(gaps).toHaveLength(2);
    expect(gaps.every((g) => g.to !== null)).toBe(true);
  });

  it('says nothing about gaps on a meeting that never lost a stream', () => {
    const dir = dataDir();
    const { meeting } = begin(dir);
    meeting.recordTurn(0, 'Nothing went wrong.');
    expect(meeting.stop().gaps).toBeUndefined();
    expect(listMeetings(dir, 'd1')[0]?.gaps).toBeUndefined();
  });
});

describe('the gap where a person reads it', () => {
  it('sits between the words either side of it, naming the stream and how long', () => {
    // The interleave, at the unit that does it, with times a real meeting
    // would produce. The end-to-end case below stamps everything inside one
    // millisecond, which is a tie this record deliberately does not break.
    const start = Date.UTC(2026, 8, 10, 9, 0, 0);
    const block = formatRawSegment({
      n: 1,
      startedAt: start,
      endedAt: start + 300_000,
      engine: 'mock',
      mode: 'conversation',
      source: 'mic+system',
      audio: [],
      names: {},
      participant: 'Jordan',
      turns: [
        { turn: 0, text: 'Let me share my screen.', ts: start + 10_000 },
        { turn: 1, text: 'Can you hear me again?', ts: start + 210_000 },
      ],
      gaps: [{ stream: 'system', from: start + 12_000, to: start + 204_000, reason: 'ended' }],
    });
    const lines = block.split('\n').filter((l) => l.startsWith('- ['));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Let me share my screen.');
    expect(lines[1]).toBe(
      "- [09:00:12Z] — this Mac's audio stopped for 3m 12s; nothing from it was recorded —",
    );
    expect(lines[2]).toContain('Can you hear me again?');
  });

  it('reaches the file a person opens, through the real store', () => {
    const dir = dataDir();
    const { meeting } = begin(dir);
    meeting.recordTurn(0, 'Let me share my screen.');
    meeting.recordGap('system', 'lost', 'ended');
    meeting.recordGap('system', 'restored');
    meeting.recordTurn(1, 'Can you hear me again?');
    meeting.stop();

    const text = readFileSync(rawTranscriptPath(dir, 'd1', 'weekly-sync'), 'utf8');
    expect(text).toContain("this Mac's audio stopped for");
    expect(text).toContain('nothing from it was recorded');
    expect(text).toContain('Let me share my screen.');
    expect(text).toContain('Can you hear me again?');
  });

  it('says a capture never came back rather than inventing an end for it', () => {
    const dir = dataDir();
    const { meeting } = begin(dir);
    meeting.recordTurn(0, 'Starting the share now.');
    meeting.recordGap('mic', 'lost', 'ended');
    meeting.stop();
    const text = readFileSync(rawTranscriptPath(dir, 'd1', 'weekly-sync'), 'utf8');
    expect(text).toContain('did not come back before the meeting ended');
    expect(text).not.toContain('stopped for');
  });

  it('writes the gap even when the outage swallowed every word', () => {
    // The case that matters most: no turns at all. Without the gap line the
    // segment would read `_(no settled turns)_` — "nobody spoke" — for a
    // meeting in which people were talking the whole time.
    const dir = dataDir();
    const { meeting } = begin(dir);
    meeting.recordGap('mic', 'lost', 'ended');
    meeting.stop();
    const text = readFileSync(rawTranscriptPath(dir, 'd1', 'weekly-sync'), 'utf8');
    expect(text).not.toContain('_(no settled turns)_');
    expect(text).toContain('the microphone stopped here and did not come back');
  });

  it('carries the gaps into meeting.json, where a replay lines audio up', () => {
    const dir = dataDir();
    const { meeting } = begin(dir);
    meeting.recordGap('system', 'lost', 'ended');
    meeting.recordGap('system', 'restored');
    meeting.stop();
    const json = readMeetingJson(dir, 'd1');
    expect(json?.segments[0]?.gaps).toHaveLength(1);
    expect(json?.segments[0]?.gaps?.[0]?.stream).toBe('system');
  });

  it('leaves a meeting that lost nothing exactly as it always read', () => {
    const dir = dataDir();
    const { meeting } = begin(dir);
    meeting.recordTurn(0, 'All fine.');
    meeting.stop();
    const text = readFileSync(rawTranscriptPath(dir, 'd1', 'weekly-sync'), 'utf8');
    expect(text).not.toContain('nothing from it was recorded');
    expect(readMeetingJson(dir, 'd1')?.segments[0]?.gaps).toBeUndefined();
  });
});

describe('a meeting picked up again after its socket dropped', () => {
  it('does not open a second gap over the one already open', () => {
    // The client re-announces every stream still down on the new socket, and
    // `recordGap` has to read that as the SAME outage — a second open would
    // never be closed and the record would claim two losses.
    const dir = dataDir();
    const { store, meeting } = begin(dir);
    meeting.recordGap('system', 'lost', 'ended');
    const id = meeting.meetingId;
    meeting.stop();

    const again = store.resume({
      docId: 'd1',
      meetingId: id,
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'conversation',
    });
    if (!again) throw new Error('the resume was refused');
    again.recordGap('system', 'lost', 'ended');
    again.recordGap('system', 'restored');
    const gaps = again.stop().gaps ?? [];
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.to).not.toBeNull();
  });
});

describe('a gap that crossed the reconnect', () => {
  it('has its recovery stated in the continuation, since the block above cannot say it', () => {
    // The block written before the restart reported this loss as still open,
    // because at the time it was, and an append-only file cannot go back and
    // add the ending. Filtering the gap out of the continuation left the file
    // permanently claiming the capture never came back.
    const start = Date.UTC(2026, 8, 10, 9, 0, 0);
    const block = formatRawSegment({
      n: 1,
      startedAt: start,
      resumedAt: start + 200_000,
      endedAt: start + 400_000,
      engine: 'mock',
      mode: 'conversation',
      source: 'mic+system',
      audio: [],
      names: {},
      turns: [{ turn: 4, text: 'Are we back?', ts: start + 260_000 }],
      gaps: [],
      carriedGaps: [{ stream: 'system', from: start + 12_000, to: start + 240_000 }],
    });
    const lines = block.split('\n').filter((l) => l.startsWith('- ['));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "- [09:04:00Z] — this Mac's audio came back after 3m 48s; the loss it ends is the one the block above reports as still open —",
    );
    expect(lines[1]).toContain('Are we back?');
  });

  it('is written even when the resumed leg settled no turns at all', () => {
    // The meeting a gap matters most on: the capture was dead for the whole
    // leg, which is exactly WHY there are no turns to print. The block used to
    // be skipped on the turn count alone, taking the gap with it.
    const start = Date.UTC(2026, 8, 10, 9, 0, 0);
    const block = formatRawSegment({
      n: 1,
      startedAt: start,
      resumedAt: start + 200_000,
      endedAt: start + 400_000,
      engine: 'mock',
      mode: 'conversation',
      source: 'mic+system',
      audio: [],
      names: {},
      turns: [],
      gaps: [{ stream: 'mic', from: start + 210_000, to: null }],
    });
    expect(block).toContain('the microphone stopped here and did not come back');
    expect(block).not.toContain('_(no settled turns)_');
  });
});

/**
 * The outages a resumed leg has to work out for ITSELF.
 *
 * The block above drives `formatRawSegment` with the gaps handed to it ready
 * made, which proves the WORDS and nothing about who chose them. Choosing is
 * the part that was wrong: which of a meeting's outages belong to the leg
 * being appended, which recovery the block before the restart could not know
 * about, and whether the index gets the gap when the leg settled no turns at
 * all. Those three answers live in `flushRawSegments`, and all three could be
 * deleted with the whole server suite still green. These drive a real resume
 * and read both files back.
 *
 * The timestamps are chosen rather than clocked. `recordGap` reads `Date.now()`
 * with no way in, and every case here is about which SIDE of the restart a gap
 * fell on — so the gap lines go onto the append-only index directly, in the
 * shape `recordGap` writes, at times this test picked. `start` and `resume`
 * take the same clock, so the whole fixture is one arithmetic.
 */
describe('the outages a resumed leg has to work out for itself', () => {
  /** Anchored in the past so a real `stop()` always lands after the fixture. */
  const STARTED = Date.now() - 600_000;
  const RESUMED = STARTED + 300_000;

  /** A gap line exactly as `recordGap` appends one, at a time we chose. */
  function writeGapLine(dir: string, meetingId: string, row: Record<string, unknown>): void {
    appendFileSync(meetingIndexPath(dir, 'd1'), `${JSON.stringify({ meetingId, ...row })}\n`);
  }

  /** The leg before the socket dropped: one turn, so there is a file to resume onto. */
  function legOne(dir: string) {
    const store = new MeetingStore(dir, { docInfo: () => ({ title: 'Weekly sync' }) });
    const meeting = store.start({
      docId: 'd1',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'conversation',
      now: STARTED,
    });
    if (!meeting) throw new Error('the doc was already recording');
    meeting.recordTurn(0, 'Before the socket dropped.');
    return { store, meeting, meetingId: meeting.meetingId };
  }

  /** Pick the meeting up again on the chosen clock. */
  function legTwo(store: MeetingStore, meetingId: string) {
    const again = store.resume({
      docId: 'd1',
      meetingId,
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'conversation',
      now: RESUMED,
    });
    if (!again) throw new Error('the resume was refused');
    return again;
  }

  const transcript = (dir: string) =>
    readFileSync(rawTranscriptPath(dir, 'd1', 'weekly-sync'), 'utf8');

  it('writes a turnless leg’s outage to the index the record is folded from', () => {
    // The meeting a gap matters most on: the capture was dead for the whole
    // leg, which is WHY there are no turns. The index update used to sit past
    // the early return that the turn count alone decided.
    const dir = dataDir();
    const { store, meeting, meetingId } = legOne(dir);
    meeting.stop();
    writeGapLine(dir, meetingId, {
      gapStream: 'mic',
      gapFrom: RESUMED + 1_000,
      gapReason: 'ended',
    });
    legTwo(store, meetingId).stop();

    const seg = readMeetingJson(dir, 'd1')?.segments.find((s) => s.meetingId === meetingId);
    expect(seg?.gaps?.map((g) => g.stream)).toEqual(['mic']);
    expect(seg?.gaps?.[0]?.to).toBeNull();
  });

  it('appends a continuation block for a leg whose only news is the outage', () => {
    const dir = dataDir();
    const { store, meeting, meetingId } = legOne(dir);
    meeting.stop();
    writeGapLine(dir, meetingId, {
      gapStream: 'mic',
      gapFrom: RESUMED + 1_000,
      gapReason: 'ended',
    });
    legTwo(store, meetingId).stop();

    expect(transcript(dir)).toContain('the microphone stopped here and did not come back');
  });

  it('states the recovery the block before the restart could not know about', () => {
    // That block reported the loss as still open, because it was, and an
    // append-only file cannot go back and add the ending.
    const dir = dataDir();
    const { store, meeting, meetingId } = legOne(dir);
    writeGapLine(dir, meetingId, {
      gapStream: 'system',
      gapFrom: RESUMED - 120_000,
      gapReason: 'ended',
    });
    meeting.stop();
    const again = legTwo(store, meetingId);
    writeGapLine(dir, meetingId, { gapStream: 'system', gapTo: RESUMED + 30_000 });
    again.recordTurn(1, 'Are we back?');
    again.stop();

    expect(transcript(dir)).toContain(
      'the loss it ends is the one the block above reports as still open',
    );
  });

  it('does not reprint an outage the block before the restart already closed', () => {
    // Printed twice, one outage reads as two — and the second one is a loss
    // the meeting never had.
    const dir = dataDir();
    const { store, meeting, meetingId } = legOne(dir);
    writeGapLine(dir, meetingId, {
      gapStream: 'system',
      gapFrom: RESUMED - 120_000,
      gapReason: 'ended',
    });
    writeGapLine(dir, meetingId, { gapStream: 'system', gapTo: RESUMED - 60_000 });
    meeting.stop();
    const again = legTwo(store, meetingId);
    again.recordTurn(1, 'Carrying on.');
    again.stop();

    const text = transcript(dir);
    expect(text.split('nothing from it was recorded').length - 1).toBe(1);
  });
});

describe('how long an outage is reported to have lasted', () => {
  it('reads in the units a person would say', () => {
    expect(formatGapDuration(45_000)).toBe('45s');
    expect(formatGapDuration(192_000)).toBe('3m 12s');
    expect(formatGapDuration(7_500_000)).toBe('2h 5m');
    expect(formatGapDuration(0)).toBe('0s');
  });
});

describe('the frame that carries a loss off the wire', () => {
  /** One meeting driven through the relay, as a browser drives it. */
  async function throughTheSocket(
    dir: string,
    frames: Array<Record<string, unknown>>,
  ): Promise<ReturnType<typeof listMeetings>[number] | undefined> {
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    const relay = new MeetingRelay({
      store: new MeetingStore(dir),
      engines: [createMockTranscriptionEngine()],
      notes: null,
      broadcast: () => {},
    });
    const ws: MeetingClient = { data: { docId: 'wired' }, send: () => {} };
    relay.onOpen(ws);
    relay.onText(
      ws,
      JSON.stringify({
        type: 'start',
        sampleRate: 16_000,
        encoding: 'pcm_s16le',
        mode: 'conversation',
        source: 'mic+system',
      }),
    );
    await settle();
    for (const frame of frames) relay.onText(ws, JSON.stringify(frame));
    await settle();
    relay.onText(ws, JSON.stringify({ type: 'stop' }));
    await settle();
    return listMeetings(dir, 'wired')[0];
  }

  it('opens and closes a gap from the browser’s own report', async () => {
    const dir = dataDir();
    const record = await throughTheSocket(dir, [
      { type: 'stream_state', stream: 'system', state: 'lost', reason: 'ended' },
      { type: 'stream_state', stream: 'system', state: 'restored' },
    ]);
    expect(record?.gaps).toHaveLength(1);
    expect(record?.gaps?.[0]?.stream).toBe('system');
    expect(record?.gaps?.[0]?.to).not.toBeNull();
  });

  it('ignores a frame naming a stream this server writes no file for', async () => {
    // The value reaches a file name; an unreadable one in the record is worse
    // than no gap line at all.
    const dir = dataDir();
    const record = await throughTheSocket(dir, [
      { type: 'stream_state', stream: '../escape', state: 'lost' },
      { type: 'stream_state', stream: 'mic', state: 'sideways' },
    ]);
    expect(record?.gaps).toBeUndefined();
  });
});
