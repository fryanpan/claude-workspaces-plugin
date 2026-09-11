/**
 * The eval's at-stop speaker check, and the wiring that decides what it can
 * see.
 *
 * THE FAILURE THIS FILE IS ABOUT. `notes-eval.ts` built its tick harness with
 * no data dir, so the at-stop quality pass read an empty transcript, `voicesOf`
 * came back with no labels, and `unknownVoices` reported EVERY genuine speaker
 * tag as a voice the meeting never had — the label test is asked before the
 * placeholder-name exemption that would otherwise clear `Speaker A`. The count
 * therefore equalled the number of distinct labels the notes used, on every run
 * of every method, and it was read as evidence that the note-taker invents
 * speakers. A bar that fires every run carries no signal.
 *
 * The three speaker cases are one measurement and its two controls, over one
 * set of notes: scored through the wiring the eval now uses (zero), scored with
 * a phantom planted in the same notes (one — proof the check can still speak),
 * and scored the way the eval used to wire it (three — the bug, reproduced
 * rather than asserted).
 *
 * Driven through `evalMeetingHarness`, which is the eval's own meeting setup,
 * so removing either half of the fix — the transcript, or the data dir — fails
 * a case here. The line is read off the console because the line IS the
 * product: a run prints one per meeting, and that is where the number was read
 * from.
 *
 * The speech comes from the committed AMI fixture, whose speakers are letters;
 * the notes and the planted voice are invented. The repo is public.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { prose } from '../packages/core/src/index.ts';
import type { NotesComposeInput } from '../packages/server/src/meeting-notes.ts';
import { addNotes, createNotesTickHarness } from '../packages/server/test/notes-tick-harness.ts';
import { FIXTURE_DIR, type NotesEvalFixture } from './notes-eval-fixtures.ts';
import { evalMeetingHarness, writeEvalTranscript } from './notes-eval.ts';

/** The committed fixture the reported runs were measured over. */
const fixture = JSON.parse(
  readFileSync(join(FIXTURE_DIR, 'ES2002a.json'), 'utf8'),
) as NotesEvalFixture;

/** The ids `evalMeetingHarness` gives this fixture's meeting. */
const DOC_ID = `d-${fixture.meeting}`;
const MEETING_ID = `m-${fixture.meeting}`;

/** Three of the voices this meeting really carried. */
const REAL = ['A', 'B', 'D'] as const;
/** A voice it did not: the planted phantom. */
const PHANTOM = 'Z';

/**
 * One real turn per voice, taken from the fixture itself.
 *
 * Derived rather than written out, so the speech under test is speech the
 * corpus really contains — and so a fixture that stopped carrying one of these
 * voices fails here loudly instead of quietly making the counts below mean
 * something else.
 */
const SPOKEN = REAL.map((label) => {
  const turn = fixture.ticks
    .flatMap((tick) => tick.turns)
    .find((t) => t.speaker === label && t.text.trim().length > 0);
  if (!turn) throw new Error(`fixture ${fixture.meeting} carries no turn for speaker ${label}`);
  return { speaker: label, text: turn.text };
});

/** The transcript those turns amount to: one tick, the one the harness plays. */
const TICKS: NotesEvalFixture['ticks'] = [{ turns: SPOKEN }];

/**
 * A saved run's notes: a bullet per voice, under the placeholder name the
 * note-taker is told to write until somebody names that voice. This is the
 * shape every dumped run has, and the shape that scored three.
 */
const POINTS = ['wants the remote kept small', 'asked about the battery', 'noted the case colour'];
const SAVED_NOTES = REAL.map(
  (label, i) => `- [@Speaker ${label}](speaker:${label}) ${POINTS[i]}`,
).join('\n');

/** The same notes with one tag for a voice the transcript does not carry. */
const NOTES_WITH_PHANTOM = `${SAVED_NOTES}\n- [@Speaker ${PHANTOM}](speaker:${PHANTOM}) closed it`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-eval-voices-'));
  dirs.push(dir);
  return dir;
};

/**
 * Run one meeting and hand back the line it ended with.
 *
 * `wiring: 'eval'` goes through `evalMeetingHarness` — the transcript on disk
 * and the data dir wired to it. `wiring: 'blind'` rebuilds what the eval did
 * before: the same doc, the same speech, the same notes, and no data dir.
 *
 * `ticks` is both the speech and the transcript — one list, so the words on
 * disk and the words the session heard cannot drift apart, which is the state
 * the phantom control below builds deliberately and nothing else should.
 *
 * `alsoSpeaks` is how the phantom gets INTO the notes. The in-flight gate
 * unwraps a tag for a voice the live session never heard, so a phantom the
 * composer simply invents never reaches the notes the pass scores. A voice the
 * session heard but the saved transcript does not carry does — and that is
 * exactly the state `unknownVoices` exists to report.
 */
async function meetingLine(opts: {
  wiring: 'eval' | 'blind';
  notes: string;
  ticks?: NotesEvalFixture['ticks'];
  alsoSpeaks?: { speaker: string; text: string };
}): Promise<string> {
  const ticks = opts.ticks ?? TICKS;
  const spoken = ticks.flatMap((tick) => tick.turns);
  const compose = (input: NotesComposeInput): readonly prose.BlockEdit[] =>
    addNotes(input, opts.notes);
  const harness =
    opts.wiring === 'eval'
      ? evalMeetingHarness(fixture, ticks, freshDir(), compose)
      : createNotesTickHarness({
          docId: DOC_ID,
          meetingId: MEETING_ID,
          doc: '## Meeting notes\n\n- my own note: check this against the brief\n',
          docTitle: `${fixture.meeting} (AMI)`,
          workspaceId: 'w-eval',
          compose,
        });
  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const take = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  console.log = take;
  console.error = take;
  try {
    await harness.speak(...spoken, ...(opts.alsoSpeaks ? [opts.alsoSpeaks] : []));
    await harness.end();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return lines.find((l) => l.includes(`meeting ${MEETING_ID}:`)) ?? '(no end-of-meeting line)';
}

describe("the eval's at-stop speaker check", () => {
  it('reports no unknown speakers once the meeting has its own transcript', async () => {
    const line = await meetingLine({ wiring: 'eval', notes: SAVED_NOTES });
    expect(line).toContain('0 unknown speakers');
    expect(line).not.toContain('the meeting never had');
  });

  it('CONTROL: a phantom tag in the same notes is still reported', async () => {
    const line = await meetingLine({
      wiring: 'eval',
      notes: NOTES_WITH_PHANTOM,
      alsoSpeaks: { speaker: PHANTOM, text: 'And that is where we left it.' },
    });
    expect(line).toContain('1 unknown speakers');
    expect(line).toContain('1 speaker the meeting never had');
  });

  it('CONTROL: with no data dir every genuine voice is reported invented', async () => {
    const line = await meetingLine({ wiring: 'blind', notes: SAVED_NOTES });
    expect(line).toContain(`${REAL.length} unknown speakers`);
    expect(line).toContain(`${REAL.length} speakers the meeting never had`);
  });

  it('reads the coverage and lateness halves of the same line off the data dir too', async () => {
    // The voices were not the only count the missing data dir took out. With
    // no transcript the line said "no ideas heard" about a meeting that had
    // said plenty, and "lateness unknown" because the per-tick timings are
    // written into the same dir. Both are numbers a reader would act on.
    // A whole tick of the fixture rather than the three turns above: the
    // coverage half needs a meeting with enough ideas in it to score, and
    // three utterances is under that floor whichever way it is wired.
    const said = fixture.ticks.slice(0, 1);
    const blind = await meetingLine({ wiring: 'blind', notes: SAVED_NOTES, ticks: said });
    expect(blind).toContain('no ideas heard');
    expect(blind).toContain('lateness unknown');
    const seeing = await meetingLine({ wiring: 'eval', notes: SAVED_NOTES, ticks: said });
    expect(seeing).not.toContain('no ideas heard');
    expect(seeing).toContain('ideas in no note');
    expect(seeing).toContain('notes late');
  });
});

describe("the eval's per-meeting latency line", () => {
  it('finds its numbers on the summary, because the harness log is bypassed', async () => {
    // Wiring the data dir in has a side effect worth pinning: the notes sinks
    // replace the timing log the harness handed them with a file-backed one,
    // so `harness.timing()` records nothing. The eval prints the median and
    // the worst from the summary for that reason, and a future reader who
    // "simplifies" it back to the log would silence the line rather than
    // break a test. This is that test.
    const harness = evalMeetingHarness(fixture, TICKS, freshDir(), (input) =>
      addNotes(input, SAVED_NOTES),
    );
    const realLog = console.log;
    const realError = console.error;
    console.log = (): void => {};
    console.error = (): void => {};
    try {
      await harness.speak(...SPOKEN);
      await harness.end();
    } finally {
      console.log = realLog;
      console.error = realError;
    }
    expect(harness.timing().rows()).toHaveLength(0);
    expect(typeof harness.summary()?.latencyMedianMs).toBe('number');
    expect(typeof harness.summary()?.latencyWorstMs).toBe('number');
  });
});

describe('writeEvalTranscript', () => {
  it('writes the turns in order, numbered as the harness speaks them', () => {
    const path = writeEvalTranscript(freshDir(), DOC_ID, MEETING_ID, [
      {
        turns: [
          { speaker: 'A', text: 'first' },
          { speaker: 'B', text: 'second' },
        ],
      },
      { turns: [{ speaker: 'C', text: 'third' }] },
    ]);
    const rows = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { turn: number; speaker?: string; text: string });
    expect(rows.map((r) => r.turn)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.speaker)).toEqual(['A', 'B', 'C']);
    expect(rows.map((r) => r.text)).toEqual(['first', 'second', 'third']);
  });

  it('writes an empty file for a run with no ticks rather than a torn one', () => {
    expect(readFileSync(writeEvalTranscript(freshDir(), DOC_ID, MEETING_ID, []), 'utf8')).toBe('');
  });
});
