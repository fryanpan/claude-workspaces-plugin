/**
 * A rerun started with `--cast` writes bullets that say the NAMES.
 *
 * WHAT THIS CLOSES. `scripts/rerun-meeting-cast.test.ts` proves the flag as
 * far as the composer's INPUT: `--cast` → `seedCast` → `docSpeakerNames`,
 * which is the map `MeetingStore.startMeeting` folds into `carried`. Nothing
 * proved that a name which reached `carried` comes out the OTHER end — in the
 * speaker tag of a bullet a reader opens. That is the whole claim the
 * speaker-continuity work is judged on, and `unnamedVoiceBullets` (the
 * report's own row) is the instrument it is judged with, so it is the one
 * used here.
 *
 * TWO ARMS, ONE STUB, ONE DIFFERENCE. The same recording, the same composer
 * and the same engine run twice; only `--cast` moves. With it every bullet's
 * tag reads Riverbend / Harborlight and `unnamedVoiceBullets` counts none;
 * without it every bullet's tag reads the engine's placeholder and it counts
 * them all, naming the labels A and B. A test with only the first arm would
 * pass on a build that hard-coded a name into the tag.
 *
 * THE STUB CANNOT INVENT A NAME, which is what makes the control mean
 * something. `bulletFor` builds the tag out of the two halves the pipeline
 * put on the turn — `speaker`, which the session resolved through
 * `speakerDisplayName`, and `speakerLabel`, the engine's own — so the only
 * name it can write is the one it was handed. When the session resolved no
 * name the placeholder is what it was handed, and when it carried no voice at
 * all the bullet gets no tag, which the control arm's assertion refuses.
 *
 * NO MODEL, NO NETWORK, NO BROWSER. The engine is the mock (one word per
 * audio frame), the note-taker is the stub below, the capture pass is off,
 * and the audio is 0.6s of silence — the mock reads the frames, not the
 * samples. It is here in the SERVER suite and not beside the harness in
 * `scripts/` because `runRerun` stands up a real `Bun.serve` server and
 * vitest runs on node, where `Bun` does not exist.
 *
 * Every name is from the house fixture set. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { prose } from '@claude-workspaces/core';
import type { ReplayTarget } from '../../../scripts/replay-meeting-lib.ts';
import type { RerunArgs } from '../../../scripts/rerun-meeting-args.ts';
import type { SeededCast } from '../../../scripts/rerun-meeting-cast.ts';
import { unnamedVoiceBullets } from '../../../scripts/rerun-meeting-report.ts';
import { type RerunOutcome, runRerun } from '../../../scripts/rerun-meeting-run.ts';
import type { NotesComposeInput, NotesComposer, NotesTurn } from '../src/meeting-notes.ts';
import { notesTopicHashes } from '../src/notes-heading-level.ts';
import { type MockScriptTurn, createMockTranscriptionEngine } from '../src/transcribe.ts';

/** Two voices, three words each, so the engine hands out two labels and the
 *  cast has two names to carry. The mock reveals one word per audio frame. */
const SCRIPT: readonly MockScriptTurn[] = [
  { words: ['the', 'ferry', 'timetable'], settled: 'The ferry timetable.', speaker: 'A' },
  { words: ['two', 'sailings', 'daily'], settled: 'Two sailings daily.', speaker: 'B' },
];

/** 16 kHz PCM16 is 32 bytes a millisecond; 0.6s is twelve 50ms frames, which
 *  is four more than the eight sends the script needs to settle both turns. */
const SAMPLE_RATE = 16_000;
const CHUNK_MS = 50;
const AUDIO_BYTES = 19_200;

/** The cast an earlier meeting on this doc gave, for the arm that has one. */
const CAST: SeededCast = { A: 'Riverbend', B: 'Harborlight' };

/**
 * One bullet, tagged out of what the tick actually carried.
 *
 * The name is `turn.speaker` and nothing else: by the time a composer sees a
 * turn the session has already resolved the label through
 * `speakerDisplayName`, so this writes the carried name when there was one
 * and the engine's placeholder when there was not. A stub that wrote
 * "Riverbend" from a constant would read the same on both arms and prove
 * nothing; a turn carrying no voice at all gets no tag, which is a third
 * outcome the control arm's assertion tells apart from the placeholder.
 */
function bulletFor(turn: NotesTurn): string {
  const name = turn.speaker;
  const label = turn.speakerLabel;
  if (name === undefined || label === undefined) return `- ${turn.text}`;
  return `- [@${name}](speaker:${label}): ${turn.text}`;
}

/** The deterministic note-taker: this tick's turns as tagged bullets, under
 *  the meeting's own heading once it has one. Shaped after
 *  `createStubNotesComposer`, which writes the speaker as bare prose. */
function taggingComposer(): NotesComposer {
  return {
    name: 'stub-tagging',
    compose(input: NotesComposeInput): Promise<readonly prose.BlockEdit[]> {
      const bullets = input.tick.turns.map(bulletFor).join('\n');
      if (bullets.length === 0) return Promise.resolve([]);
      const headingId = input.notesHeadingId;
      return Promise.resolve(
        headingId === undefined
          ? [
              {
                op: 'insert_at_end',
                markdown: `${notesTopicHashes(input.outline)} Ferry timetable\n\n${bullets}`,
              } satisfies prose.BlockEdit,
            ]
          : [
              {
                op: 'insert_under_heading',
                headingId,
                markdown: bullets,
              } satisfies prose.BlockEdit,
            ],
      );
    },
  };
}

/** A one-segment recording of silence on disk — the mock hears frames. */
function recording(dir: string): ReplayTarget {
  const path = join(dir, 'segment-1-mic.pcm');
  writeFileSync(path, Buffer.alloc(AUDIO_BYTES));
  return {
    dir,
    docId: 'd-riverbend',
    docName: 'Riverbend ferry review',
    inputs: [
      {
        segment: 1,
        stream: 'mic',
        path,
        sampleRate: SAMPLE_RATE,
        startedAt: 0,
        // Conversation, because the solo path strips the label off every turn
        // and there would be no voice to name.
        mode: 'conversation',
        source: 'mic',
      },
    ],
  };
}

/** The whole rerun, with the cast or without it — the single difference. */
async function rerun(cast?: SeededCast): Promise<RerunOutcome> {
  const dir = mkdtempSync(join(tmpdir(), 'cw-rerun-cast-carry-'));
  const out = join(dir, 'out');
  mkdirSync(out, { recursive: true });
  const args: RerunArgs = {
    target: dir,
    method: 'original',
    engine: 'mock',
    doc: 'empty',
    out,
    spendUsd: 1,
    chunkMs: CHUNK_MS,
    port: 0,
    keep: false,
    engineSpendOk: false,
    ...(cast !== undefined ? { cast } : {}),
  };
  return runRerun(
    args,
    recording(dir),
    { shape: 'empty', markdown: '', edits: [] },
    {
      composer: () => taggingComposer(),
      transcription: createMockTranscriptionEngine(SCRIPT),
      // The capture pass bills Haiku per tick and has nothing to do with who a
      // voice is called; off, so this test reaches no model at all.
      taskExtractor: null,
      titleNamer: null,
      log: () => {},
    },
  );
}

/** What the run left in the notes this meeting wrote. */
function writtenNotes(outcome: RerunOutcome): string {
  return readFileSync(outcome.report.writtenNotesPath, 'utf8');
}

/**
 * The engine label the tag reading `name` points at, or nothing.
 *
 * Provenance is stripped: the pipeline stamps each tag with the turns it
 * speaks for (`speaker:A?t=0`), which is a different contract from this one
 * and would make these assertions fail on a change that kept every name
 * right. The label BEFORE the question mark is what carries a voice through
 * a rename, and is what this test is about.
 */
function labelTagged(notes: string, name: string): string | undefined {
  for (const [, text, label] of notes.matchAll(/\[@([^\]]+)\]\(speaker:([^)\s]+)\)/g)) {
    if (text === name) return (label ?? '').split('?')[0];
  }
  return undefined;
}

/** Every label `unnamedVoiceBullets` named, provenance stripped. */
const bareLabels = (labels: readonly string[]): string[] => labels.map((l) => l.split('?')[0] ?? l);

describe('a rerun whose doc already had a cast', () => {
  it('writes the names into the bullets, and the same run without one writes the labels', async () => {
    const named = await rerun(CAST);
    const anonymous = await rerun();

    // BOTH ARMS WROTE SOMETHING. A run whose note-taker wrote no bullet at
    // all reads as zero unnamed bullets, which is the pass this test must not
    // be able to give itself.
    expect(named.report.bullets).toBeGreaterThan(0);
    expect(anonymous.report.bullets).toBeGreaterThan(0);

    // THE CONTROL. No cast: every tagged bullet points at a voice nobody
    // named, and the labels it names are the engine's own.
    const anonymousNotes = writtenNotes(anonymous);
    expect(anonymous.report.unnamedVoiceBullets).toBeGreaterThan(0);
    expect(bareLabels(anonymous.report.unnamedVoiceLabels)).toEqual(['A', 'B']);
    expect(labelTagged(anonymousNotes, 'Speaker A')).toBe('A');
    expect(labelTagged(anonymousNotes, 'Speaker B')).toBe('B');

    // THE ARM UNDER TEST. The cast an earlier meeting gave reached the tags,
    // each name on the label it was seeded against.
    const notes = writtenNotes(named);
    expect(named.report.unnamedVoiceBullets).toBe(0);
    expect(named.report.unnamedVoiceLabels).toEqual([]);
    expect(labelTagged(notes, 'Riverbend')).toBe('A');
    expect(labelTagged(notes, 'Harborlight')).toBe('B');
    expect(notes).not.toContain('Speaker A');

    // AND THE MEASURE READ OVER THE FILE AGREES WITH THE REPORT'S ROW, so the
    // number a person reads in report.md is the number these bullets support.
    expect(unnamedVoiceBullets(notes).bullets).toBe(0);
    expect(unnamedVoiceBullets(anonymousNotes).bullets).toBeGreaterThan(0);

    // The two arms are the same run otherwise: the cast is recorded on the
    // report that had one and absent from the one that did not.
    expect(named.report.cast).toEqual(CAST);
    expect(anonymous.report.cast).toBeUndefined();
  }, 120_000);
});
