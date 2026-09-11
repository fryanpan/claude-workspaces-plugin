/**
 * What a project chose to keep, applied where the words are written.
 *
 * Retention here is "never written", not "deleted afterwards": soft delete is
 * project-wide and a transcript is the least reconstructible thing this server
 * holds, so a project that wants no words gets a meeting that never wrote
 * them. That makes the assertions the strong kind — a file that does not
 * exist, an audio sink that was never opened — rather than a count of what
 * survived a sweep.
 *
 * The record still says a meeting happened, for how long, and how many turns
 * it settled. That is metadata about the meeting, not a record of what was
 * said in it, and a project that keeps nothing still gets its Library row.
 *
 * All fixtures invented. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MeetingRetention } from '../src/meeting-home.ts';
import {
  MeetingStore,
  listMeetings,
  meetingDirPath,
  meetingTranscriptPath,
  readTranscript,
} from '../src/meetings.ts';

describe('a project that keeps less', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-retention-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** One whole meeting: two turns and a frame of audio, then stopped. */
  function hold(docId: string, retention: MeetingRetention) {
    const store = new MeetingStore(dataDir, { retention: () => retention });
    const meeting = store.start({ docId, engine: 'mock', sampleRate: 16_000, mode: 'solo' });
    if (!meeting) throw new Error('the doc was already recording');
    meeting.recordTurn(0, 'The tide gauge reads low at noon.');
    meeting.recordTurn(1, 'Then we move the Saltmarsh walk an hour.');
    meeting.recordAudio(new Uint8Array(640));
    const record = meeting.stop();
    const dir = meetingDirPath(dataDir, docId);
    return {
      record,
      transcriptPath: meetingTranscriptPath(dataDir, docId, record.meetingId),
      audioFiles: existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.pcm')) : [],
    };
  }

  it('keeps the words and the audio when the project keeps everything', () => {
    const held = hold('d-riverbend', 'transcripts-and-audio');
    expect(existsSync(held.transcriptPath)).toBe(true);
    expect(
      readTranscript(dataDir, 'd-riverbend', held.record.meetingId).map((t) => t.text),
    ).toEqual(['The tide gauge reads low at noon.', 'Then we move the Saltmarsh walk an hour.']);
    expect(held.audioFiles).toHaveLength(1);
  });

  it('keeps the words and opens no audio file when the project keeps transcripts only', () => {
    const held = hold('d-harbor', 'transcripts');
    expect(readTranscript(dataDir, 'd-harbor', held.record.meetingId)).toHaveLength(2);
    // Never opened, not opened and emptied: an audio sink that ran would
    // leave a file here whatever was written into it.
    expect(held.audioFiles).toEqual([]);
  });

  it('writes neither when the project keeps nothing, and still says a meeting was held', () => {
    const held = hold('d-saltmarsh', 'none');
    expect(existsSync(held.transcriptPath)).toBe(false);
    expect(held.audioFiles).toEqual([]);
    expect(readTranscript(dataDir, 'd-saltmarsh', held.record.meetingId)).toEqual([]);

    // The meeting itself is still on the record — when it ran, how long for,
    // how many turns it settled, and what the project was keeping at the time.
    const [row] = listMeetings(dataDir, 'd-saltmarsh');
    expect(row?.meetingId).toBe(held.record.meetingId);
    expect(row?.retention).toBe('none');
    expect(row?.endedAt).toBeGreaterThanOrEqual(row?.startedAt ?? 0);
    expect(held.record.turns).toBe(2);
  });

  it("carries each meeting's own choice, so changing it does not rewrite the last one", () => {
    const first = hold('d-two-ways', 'none');
    const second = hold('d-two-ways', 'transcripts');
    expect(existsSync(first.transcriptPath)).toBe(false);
    expect(existsSync(second.transcriptPath)).toBe(true);
    expect(listMeetings(dataDir, 'd-two-ways').map((m) => m.retention)).toEqual([
      'none',
      'transcripts',
    ]);
  });

  it('keeps everything when the project cannot be asked', () => {
    const store = new MeetingStore(dataDir, {
      retention: () => {
        throw new Error('the mount registry is unreadable');
      },
    });
    const meeting = store.start({
      docId: 'd-unasked',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
    });
    if (!meeting) throw new Error('the doc was already recording');
    meeting.recordTurn(0, 'Nobody could be asked, so nothing was lost.');
    const record = meeting.stop();
    expect(readTranscript(dataDir, 'd-unasked', record.meetingId)).toHaveLength(1);
  });
});
