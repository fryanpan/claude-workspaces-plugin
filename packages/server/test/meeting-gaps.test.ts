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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MeetingClient, MeetingRelay } from '../src/meeting-protocol.ts';
import {
  formatGapDuration,
  formatRawSegment,
  rawTranscriptPath,
  readMeetingJson,
} from '../src/meeting-raw.ts';
import { MeetingStore, listMeetings } from '../src/meetings.ts';
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
