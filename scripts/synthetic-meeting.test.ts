/**
 * The meeting folder the harness is developed against.
 *
 * NO SPEECH IS MADE HERE. `say` takes the best part of a minute for the full
 * script, and what needs pinning is not the audio: it is that every file in
 * the folder describes the SAME recording, which is the thing a `--lines` run
 * quietly broke.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveReplayTarget } from './replay-meeting-lib.ts';
import { SYNTHETIC_SCRIPT, writeMeetingFiles } from './synthetic-meeting.ts';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-synthetic-test-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = (file: string): string => readFileSync(join(dir, file), 'utf8');

describe('writeMeetingFiles', () => {
  it('writes a mock script of the lines that are in the audio, and no more', () => {
    // The mock reveals a word per audio chunk rather than hearing anything, so
    // a script longer than the recording puts dialogue in the transcript that
    // nobody said — and a short `--lines` run is exactly where that happens.
    const four = SYNTHETIC_SCRIPT.slice(0, 4);
    writeMeetingFiles(dir, four, Buffer.alloc(32_000));
    const script = JSON.parse(read('mock-script.json')) as Array<{ settled: string }>;
    expect(script).toHaveLength(4);
    expect(script.map((t) => t.settled)).toEqual(four.map((l) => l.text));
  });

  it('describes the audio it was given, so the replay can resolve it', () => {
    writeMeetingFiles(dir, SYNTHETIC_SCRIPT, Buffer.alloc(64_000));
    const target = resolveReplayTarget(dir);
    expect(target.inputs).toHaveLength(1);
    expect(target.inputs[0]?.sampleRate).toBe(16_000);
    expect(target.inputs[0]?.mode).toBe('conversation');
    const meeting = JSON.parse(read('meeting.json')) as {
      segments: Array<{ audio: Array<{ bytes: number }> }>;
    };
    expect(meeting.segments[0]?.audio[0]?.bytes).toBe(64_000);
  });

  it('writes the prep outline and its mid-run edits as the harness reads them', () => {
    writeMeetingFiles(dir, SYNTHETIC_SCRIPT, Buffer.alloc(32_000));
    expect(read('prep-outline.md')).toContain('Harbour survey planning');
    const edits = JSON.parse(read('prep-outline-edits.json')) as {
      markdown: string;
      edits: Array<{ atMs: number; find: string }>;
    };
    expect(edits.markdown).toBe(read('prep-outline.md'));
    // Every edit has to land inside the recording, or it never arrives.
    for (const edit of edits.edits) {
      expect(edits.markdown).toContain(edit.find);
      expect(edit.atMs).toBeGreaterThan(0);
    }
  });
});
