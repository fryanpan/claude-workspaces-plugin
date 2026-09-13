/**
 * Where a voice feedback session's words and audio are kept: beside the mock,
 * in the data dir, under the mock's own doc id.
 *
 *   <dataDir>/<docId>.voice-feedback.md        what was heard, with times
 *   <dataDir>/<docId>.voice-feedback/seg-N.wav one recording per session
 *
 * The data dir rather than beside the agent's source file, for the reason the
 * mock's own capture lives there: a mock's source is usually agent scratch
 * that gets cleaned up, and this log is the durable record of what a person
 * said. The first session creates the log; each later one appends a
 * "Recording N" section and a new audio file.
 *
 * The suffix is NOT `.mock.*`: `deleteMockupVersions` removes every file that
 * starts `<docId>.mock.v`, and a name under that prefix would go with a purge
 * of the mock's rounds without anyone asking for the words to be gone.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

export const VOICE_LOG_SUFFIX = '.voice-feedback.md';
export const VOICE_AUDIO_SUFFIX = '.voice-feedback';
const SEG_RE = /^seg-(\d{1,6})\.wav$/;

export function voiceLogPath(dataDir: string, docId: string): string {
  return join(dataDir, `${docId}${VOICE_LOG_SUFFIX}`);
}

export function voiceAudioDir(dataDir: string, docId: string): string {
  return join(dataDir, `${docId}${VOICE_AUDIO_SUFFIX}`);
}

/** The recording `seg-N.wav` for this doc, or null for a name that is not one. */
export function voiceSegmentPath(dataDir: string, docId: string, name: string): string | null {
  return SEG_RE.test(name) ? join(voiceAudioDir(dataDir, docId), name) : null;
}

/** The next recording number: one past the highest already on disk. */
export function nextSegment(dataDir: string, docId: string): number {
  const dir = voiceAudioDir(dataDir, docId);
  if (!existsSync(dir)) return 1;
  let max = 0;
  for (const f of readdirSync(dir)) {
    const n = Number(SEG_RE.exec(f)?.[1] ?? 0);
    if (n > max) max = n;
  }
  return max + 1;
}

/** `[mm:ss]` from milliseconds into a recording. */
export function stamp(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `[${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}]`;
}

/** Append to the log, creating it with its heading the first time. */
export function appendVoiceLog(dataDir: string, docId: string, text: string): void {
  const p = voiceLogPath(dataDir, docId);
  if (!existsSync(p)) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      p,
      `# Voice feedback — ${docId}\n\nWhat was said while giving voice feedback on this page, ` +
        'as heard. Each recording has its own audio file.\n',
    );
  }
  appendFileSync(p, text);
}

/**
 * One recording's log, in the order things were said. A heard line is ready
 * the moment its turn settles, but the comment made from those words is only
 * written when it settles — usually once the next topic has started — so
 * written as they arrived, a comment landed below words said after it. Heard
 * lines wait here until a comment that ends at or after them settles, or the
 * recording ends, and go out ahead of it. The recording is the durable copy
 * of the words in the meantime.
 */
export class VoiceLog {
  private heard: Array<{ ms: number; line: string }> = [];

  constructor(
    private readonly dataDir: string,
    private readonly docId: string,
  ) {}

  write(text: string): void {
    appendVoiceLog(this.dataDir, this.docId, text);
  }

  /** A settled turn, `ms` into the recording. */
  heardAt(ms: number, text: string): void {
    this.heard.push({ ms, line: `- ${stamp(ms)} ${text}\n` });
  }

  /** A settled comment's line, after every word heard up to its end. */
  comment(endMs: number, line: string): void {
    this.flush(endMs);
    this.write(line);
  }

  /** Every waiting heard line up to `upTo`, written. */
  flush(upTo = Number.POSITIVE_INFINITY): void {
    const ready = this.heard.filter((h) => h.ms <= upTo);
    if (ready.length === 0) return;
    this.heard = this.heard.filter((h) => h.ms > upTo);
    this.write(ready.map((h) => h.line).join(''));
  }
}

/** A 44-byte WAV header for PCM16 mono of `dataBytes` bytes. */
export function wavHeader(sampleRate: number, dataBytes: number): Uint8Array {
  const b = new DataView(new ArrayBuffer(44));
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) b.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  b.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true);
  b.setUint16(22, 1, true);
  b.setUint32(24, sampleRate, true);
  b.setUint32(28, sampleRate * 2, true);
  b.setUint16(32, 2, true);
  b.setUint16(34, 16, true);
  ascii(36, 'data');
  b.setUint32(40, dataBytes, true);
  return new Uint8Array(b.buffer);
}

/**
 * One recording, written as it arrives. The header's two lengths are
 * rewritten after every chunk, so a clip played while the person is still
 * talking reads a whole, valid file rather than one that claims zero bytes.
 */
export interface WavWriter {
  write(pcm: Uint8Array): void;
  close(): void;
  readonly bytes: number;
}

/**
 * The next recording, claimed: its number and its open writer. The file is
 * created exclusively, so two sessions that read the same highest number (two
 * servers on one data dir, say) cannot both write `seg-N.wav` — the second
 * takes N+1. `from` is where the claim starts; it is the scan by default.
 */
export function openNextSegment(
  dataDir: string,
  docId: string,
  sampleRate: number,
  from = nextSegment(dataDir, docId),
): { segment: number; wav: WavWriter } {
  for (let segment = from; ; segment++) {
    try {
      const wav = openWav(join(voiceAudioDir(dataDir, docId), `seg-${segment}.wav`), sampleRate, {
        exclusive: true,
      });
      return { segment, wav };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

export function openWav(
  path: string,
  sampleRate: number,
  opts: { exclusive?: boolean } = {},
): WavWriter {
  mkdirSync(join(path, '..'), { recursive: true });
  const fd = openSync(path, opts.exclusive ? 'wx' : 'w');
  writeSync(fd, wavHeader(sampleRate, 0));
  let bytes = 0;
  let closed = false;
  const size = new DataView(new ArrayBuffer(4));
  const patch = (at: number, v: number) => {
    size.setUint32(0, v, true);
    writeSync(fd, new Uint8Array(size.buffer), 0, 4, at);
  };
  return {
    write(pcm) {
      if (closed || pcm.byteLength === 0) return;
      writeSync(fd, pcm, 0, pcm.byteLength, 44 + bytes);
      bytes += pcm.byteLength;
      patch(4, 36 + bytes);
      patch(40, bytes);
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
    get bytes() {
      return bytes;
    },
  };
}

/** A purge of the doc takes its voice log and recordings with it. */
export function deleteVoiceFeedback(dataDir: string, docId: string): void {
  rmSync(voiceLogPath(dataDir, docId), { force: true });
  rmSync(voiceAudioDir(dataDir, docId), { recursive: true, force: true });
}
