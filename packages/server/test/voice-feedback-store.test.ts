/**
 * Where a voice feedback session keeps what was said: the log beside the mock,
 * one WAV per recording, and a purge that takes both.
 *
 * All fixtures are synthetic — the Riverbend register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendVoiceLog,
  deleteVoiceFeedback,
  nextSegment,
  openNextSegment,
  openWav,
  stamp,
  voiceAudioDir,
  voiceLogPath,
  voiceSegmentPath,
  wavHeader,
} from '../src/voice-feedback-store.ts';

const DOC = 'riverbend-mock';

describe('voice feedback store', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-voice-store-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('numbers recordings one past the highest on disk, ignoring other files', () => {
    expect(nextSegment(dataDir, DOC)).toBe(1);
    const dir = voiceAudioDir(dataDir, DOC);
    openWav(join(dir, 'seg-1.wav'), 16_000).close();
    openWav(join(dir, 'seg-7.wav'), 16_000).close();
    writeFileSync(join(dir, 'seg-99.txt'), 'not a recording');
    writeFileSync(join(dir, 'notes.wav'), 'not a recording');
    expect(nextSegment(dataDir, DOC)).toBe(8);
  });

  it('claims a recording another session already took by the next number, leaving it whole', () => {
    // Two sessions that scanned the same highest number: the first has
    // already claimed seg-1 and written into it.
    const first = openNextSegment(dataDir, DOC, 16_000);
    expect(first.segment).toBe(1);
    first.wav.write(new Uint8Array(640).fill(7));
    const second = openNextSegment(dataDir, DOC, 16_000, 1);
    expect(second.segment, 'the second takes the next number').toBe(2);
    first.wav.close();
    second.wav.close();
    expect(readFileSync(join(voiceAudioDir(dataDir, DOC), 'seg-1.wav')).byteLength).toBe(44 + 640);
  });

  it('resolves only seg-<digits>.wav names to a path inside the doc folder', () => {
    expect(voiceSegmentPath(dataDir, DOC, 'seg-3.wav')).toBe(
      join(voiceAudioDir(dataDir, DOC), 'seg-3.wav'),
    );
    for (const bad of ['seg-x.wav', '../seg-1.wav', 'seg-1.wav/..', '..%2F..%2Fetc', 'seg-1.mp3']) {
      expect(voiceSegmentPath(dataDir, DOC, bad)).toBeNull();
    }
  });

  it('writes a valid PCM16 mono header whose lengths track the data as it grows', () => {
    const path = join(voiceAudioDir(dataDir, DOC), 'seg-1.wav');
    const wav = openWav(path, 16_000);
    const readHeader = () => {
      const buf = readFileSync(path);
      const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      return {
        size: buf.byteLength,
        riff: buf.subarray(0, 4).toString('ascii'),
        wave: buf.subarray(8, 12).toString('ascii'),
        riffLen: v.getUint32(4, true),
        rate: v.getUint32(24, true),
        channels: v.getUint16(22, true),
        bits: v.getUint16(34, true),
        dataLen: v.getUint32(40, true),
      };
    };
    expect(readHeader()).toMatchObject({ size: 44, riff: 'RIFF', wave: 'WAVE', dataLen: 0 });

    wav.write(new Uint8Array(640).fill(7));
    wav.write(new Uint8Array(0));
    wav.write(new Uint8Array(320).fill(9));
    expect(wav.bytes).toBe(960);
    // Read while still open: a clip played mid-session must see a whole file.
    expect(readHeader()).toMatchObject({
      size: 44 + 960,
      riffLen: 36 + 960,
      dataLen: 960,
      rate: 16_000,
      channels: 1,
      bits: 16,
    });
    wav.close();
    wav.write(new Uint8Array(640));
    expect(statSync(path).size).toBe(44 + 960);
  });

  it('builds the same header for a known length', () => {
    const h = new DataView(wavHeader(16_000, 1000).buffer);
    expect(h.getUint32(4, true)).toBe(1036);
    expect(h.getUint32(28, true)).toBe(32_000);
    expect(h.getUint32(40, true)).toBe(1000);
  });

  it('creates the log with its heading once, then appends', () => {
    appendVoiceLog(dataDir, DOC, '\n## Recording 1\n');
    appendVoiceLog(dataDir, DOC, '- [00:03] the header is too tall\n');
    const log = readFileSync(voiceLogPath(dataDir, DOC), 'utf8');
    expect(log.match(/^# Voice feedback/gm)).toHaveLength(1);
    expect(log).toContain('## Recording 1\n- [00:03] the header is too tall\n');
  });

  it('stamps milliseconds as [mm:ss]', () => {
    expect(stamp(0)).toBe('[00:00]');
    expect(stamp(61_999)).toBe('[01:01]');
    expect(stamp(-5)).toBe('[00:00]');
  });

  it('a purge removes both the log and the recordings folder, and only this doc’s', () => {
    appendVoiceLog(dataDir, DOC, 'words\n');
    openWav(join(voiceAudioDir(dataDir, DOC), 'seg-1.wav'), 16_000).close();
    appendVoiceLog(dataDir, 'harborlight-mock', 'other words\n');

    deleteVoiceFeedback(dataDir, DOC);

    expect(existsSync(voiceLogPath(dataDir, DOC))).toBe(false);
    expect(existsSync(voiceAudioDir(dataDir, DOC))).toBe(false);
    expect(existsSync(voiceLogPath(dataDir, 'harborlight-mock'))).toBe(true);
    // Nothing there to remove is not an error.
    expect(() => deleteVoiceFeedback(dataDir, DOC)).not.toThrow();
  });
});
