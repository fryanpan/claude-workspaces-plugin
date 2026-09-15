#!/usr/bin/env bun
/**
 * `bun run meeting:synthetic <dir>` — a retained meeting that never happened.
 *
 * WHY THIS EXISTS. `meeting:rerun` replays a meeting's kept audio, and the
 * meetings worth replaying are private. Nothing about the harness needs a
 * real one to be developed or reviewed: what it needs is a folder shaped like
 * a meeting record, holding PCM whose content is known in advance. So this
 * writes one, out of invented harbour-survey talk in invented place names,
 * and every run of the harness in this repo is driven from it.
 *
 * THE AUDIO IS REAL SPEECH, from macOS `say` at the meeting sample rate. A
 * tone would have been simpler and would have made `--engine mock` the only
 * engine this folder could ever be used with; spoken words mean a live engine
 * can be pointed at it too, which is the difference between testing the
 * harness and testing the whole seam.
 *
 * THE GAPS ARE THE STRUCTURE. A meeting's notes tick on a pause OR a cadence,
 * so the silence between turns is not padding: a short gap inside a topic
 * leaves the cadence clock to fire, and the long gap at a topic boundary is a
 * real pause for the pause ticker. A recording with no silence in it exercises
 * one of the two clocks and hides the other.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEETING_SAMPLE_RATE } from '../packages/core/src/meeting.ts';

/** One thing somebody says, and who says it. */
export interface Line {
  voice: string;
  text: string;
  /** First line of a new subject — takes the long pause in front of it. */
  opensTopic?: boolean;
}

/**
 * The meeting. Three subjects, some backchannel, a decision in each — the
 * shape a note-taker is supposed to turn into three topic headings rather
 * than one wall of bullets, which is the failure this whole harness is for.
 *
 * Invented throughout. The repo is public.
 */
const SCRIPT: readonly Line[] = [
  {
    voice: 'Samantha',
    text: 'Right, the Harborlight survey. We start on the first Monday of March.',
    opensTopic: true,
  },
  { voice: 'Daniel', text: 'That is tighter than last year. Do we have the boats for it?' },
  { voice: 'Samantha', text: 'Riverbend needs two more boats before the thaw, either way.' },
  { voice: 'Daniel', text: 'Mm. Right. Okay.' },
  {
    voice: 'Samantha',
    text: 'So the decision is we hire the two from Saltmarsh rather than buying.',
  },
  { voice: 'Daniel', text: 'Agreed. I will put the hire on the March budget line.' },

  {
    voice: 'Daniel',
    text: 'Next thing. The slipway quote came back under budget by nine percent.',
    opensTopic: true,
  },
  { voice: 'Samantha', text: 'Under? That is the first quote all year that has come in under.' },
  {
    voice: 'Daniel',
    text: 'It assumes the crane is free in the second week. We lose the tide window if the crane slips again.',
  },
  { voice: 'Samantha', text: 'Then we book the crane this week and hold the slipway date.' },
  { voice: 'Daniel', text: 'Yes. I will send the booking today and copy the harbour office.' },

  {
    voice: 'Samantha',
    text: 'Last one. Harborlight wants the draft timetable before the board meets again.',
    opensTopic: true,
  },
  { voice: 'Daniel', text: 'When does the board meet?' },
  {
    voice: 'Samantha',
    text: 'The twelfth. So the draft has to be with them by the ninth at the latest.',
  },
  { voice: 'Daniel', text: 'Saltmarsh covers the second week, and the week after that.' },
  {
    voice: 'Samantha',
    text: 'Good. Then I will write the draft timetable and send it on the eighth.',
  },
  { voice: 'Daniel', text: 'Sure. Yes. Okay, that is everything.' },
];

/** Silence inside a topic. Short enough that the cadence clock is what
 *  fires, which is most ticks in a real meeting. */
const GAP_MS = 1_200;
/** Silence at a subject change — longer than the notes pipeline's default
 *  quiet window, so the pause ticker fires on it. */
const TOPIC_GAP_MS = 5_000;

/** A prep outline somebody wrote before the meeting. The point of it is that
 *  it names two of the three subjects and not the third. */
const PREP_OUTLINE = `# Harbour survey planning

## Before the season

- Confirm the survey start date
- Boats: how many short, hire or buy

## Slipway

- Chase the quote
`;

/** The edit that arrives while the room is talking: somebody answering the
 *  outline's own question, on the line the outline already holds. */
const PREP_EDITS = [
  {
    atMs: 30_000,
    find: 'Boats: how many short, hire or buy',
    replace: 'Boats: two short — hiring from Saltmarsh',
  },
  { atMs: 62_000, find: 'Chase the quote', replace: 'Quote is in, under budget — book the crane' },
];

/** The words `--engine mock` reveals, one per audio chunk, so the mock hears
 *  what the speech actually says. */
function mockScript(script: readonly Line[]): unknown[] {
  return script.map((line) => ({
    words: line.text.replace(/[.,]/g, '').split(/\s+/),
    settled: line.text,
  }));
}

/** The PCM inside a `say`-produced WAV, without its header. */
function pcmOfWav(wav: Buffer): Buffer {
  // RIFF chunks: 4-byte id, 4-byte little-endian length, then the payload,
  // padded to even. `say` writes a JUNK chunk before `fmt `, so the data
  // chunk has to be walked to rather than assumed at a fixed offset.
  let at = 12;
  while (at + 8 <= wav.byteLength) {
    const id = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === 'data') return wav.subarray(at + 8, Math.min(at + 8 + size, wav.byteLength));
    at += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in the WAV that `say` wrote');
}

function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round((MEETING_SAMPLE_RATE * 2 * ms) / 1000));
}

function speak(line: Line, scratch: string): Buffer {
  const wav = join(scratch, 'line.wav');
  execFileSync('say', ['-v', line.voice, '-o', wav, '--data-format=LEI16@16000', line.text]);
  return pcmOfWav(readFileSync(wav));
}

export interface SyntheticOptions {
  dir: string;
  /** Only the first N lines, for a short run while iterating. */
  lines?: number;
}

function parseArgs(argv: readonly string[]): SyntheticOptions {
  let dir: string | undefined;
  let lines: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--lines') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error('--lines must be a positive integer');
      lines = n;
    } else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else if (dir === undefined) dir = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!dir) throw new Error('usage: bun run meeting:synthetic <dir> [--lines N]');
  return { dir, ...(lines !== undefined ? { lines } : {}) };
}

/** The lines the script names, so a test can shorten it without speaking. */
export const SYNTHETIC_SCRIPT: readonly Line[] = SCRIPT;

/**
 * Everything a meeting folder holds, written from audio already made.
 *
 * SEPARATE FROM THE SPEAKING so it can be tested at all: `say` takes the best
 * part of a minute for the full script, and what needs pinning here is not
 * the speech — it is that every file describes the SAME recording. A
 * `--lines 4` run whose mock script still carried seventeen would have put
 * thirteen lines of dialogue in the transcript that nobody ever said, and the
 * mock reveals words per audio chunk rather than hearing them, so nothing
 * downstream would have noticed.
 */
export function writeMeetingFiles(dir: string, script: readonly Line[], pcm: Buffer): void {
  const startedAt = Date.now();
  const file = 'segment-1-mic.pcm';
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), pcm);
  writeFileSync(
    join(dir, 'meeting.json'),
    `${JSON.stringify(
      {
        docId: 'synthetic-harbour-survey',
        docName: 'synthetic-harbour-survey',
        transcript: 'synthetic-harbour-survey.jsonl',
        updatedAt: startedAt,
        segments: [
          {
            n: 1,
            startedAt,
            endedAt: startedAt + (pcm.byteLength / (MEETING_SAMPLE_RATE * 2)) * 1000,
            engine: 'synthetic',
            mode: 'conversation',
            source: 'mic',
            audio: [
              {
                stream: 'mic',
                file,
                codec: 'pcm_s16le',
                sampleRate: MEETING_SAMPLE_RATE,
                channels: 1,
                bytes: pcm.byteLength,
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, 'mock-script.json'), `${JSON.stringify(mockScript(script), null, 2)}\n`);
  writeFileSync(join(dir, 'prep-outline.md'), PREP_OUTLINE);
  // ONLY THE EDITS THIS RECORDING REACHES. A `--lines 4` run is forty seconds
  // long and the second edit is scheduled at sixty-two: written out anyway it
  // describes a change the replay stops its timer on, so the fixture would
  // promise an edited document and quietly deliver an unedited one. The rerun
  // refuses such a pair outright (`checkDocEdits`), which would make the short
  // fixture unusable rather than merely wrong.
  const playMs = (pcm.byteLength / (MEETING_SAMPLE_RATE * 2)) * 1000;
  writeFileSync(
    join(dir, 'prep-outline-edits.json'),
    `${JSON.stringify(
      { markdown: PREP_OUTLINE, edits: PREP_EDITS.filter((e) => e.atMs < playMs) },
      null,
      2,
    )}\n`,
  );
}

function main(argv: string[]): number {
  const opts = parseArgs(argv);
  const script = opts.lines === undefined ? SCRIPT : SCRIPT.slice(0, opts.lines);
  mkdirSync(opts.dir, { recursive: true });
  const scratch = join(tmpdir(), `cw-synthetic-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  const parts: Buffer[] = [];
  try {
    for (const [i, line] of script.entries()) {
      if (i > 0) parts.push(silence(line.opensTopic ? TOPIC_GAP_MS : GAP_MS));
      parts.push(speak(line, scratch));
      process.stderr.write(`synthetic: ${i + 1}/${script.length} ${line.voice}\n`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const pcm = Buffer.concat(parts);
  writeMeetingFiles(opts.dir, script, pcm);
  const seconds = pcm.byteLength / (MEETING_SAMPLE_RATE * 2);
  process.stderr.write(
    `synthetic: ${script.length} line(s), ${seconds.toFixed(1)}s of audio → ${opts.dir}\n`,
  );
  console.log(opts.dir);
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
