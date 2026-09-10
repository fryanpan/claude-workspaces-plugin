/**
 * Does the tidy-up pass actually leave good notes alone?
 *
 * THE HARD CRITERION IS RESTRAINT. A pass that improves poor notes and also
 * rewrites good ones is worse than no pass at all: the notes have been on
 * screen for the length of a meeting, people have read them, and a doc that
 * churns under them is the disruption the feature exists to avoid. So the
 * number that says whether this is finished is not "did it help" — it is
 * HOW MANY BLOCKS IT TOUCHED ON NOTES THAT NEEDED NO HELP, and it has to be
 * at or near zero.
 *
 * A zero alone proves nothing: a composer that answered `[]` to everything
 * would score perfectly. So this runs two arms against the same model, the
 * same prompt and the same gate:
 *
 *   RESTRAINT — a good record of the meeting. Expect 0 blocks touched.
 *   CONTROL   — thin, disordered notes of the SAME meeting, missing two
 *               things that were decided. Expect more than 0.
 *
 * The control failing is the more interesting failure of the two: it means
 * the measurement above is vacuous.
 *
 * IT COSTS MODEL CALLS. `--arms n` repeats each arm n times, because one
 * sample of a sampled model is an anecdote. Nothing here touches a real
 * meeting or a real doc — the notes, the transcript and every name in them
 * are invented, and the doc is an in-memory Y.Doc.
 *
 *   bun run packages/server/scripts/notes-cleanup-check.ts            # one of each
 *   bun run packages/server/scripts/notes-cleanup-check.ts --arms 3
 *   bun run packages/server/scripts/notes-cleanup-check.ts --stub     # no model, no bill
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { createHaikuNotesComposer } from '../src/meeting-notes-composer.ts';
import {
  type NotesComposer,
  createStubNotesComposer,
} from '../src/meeting-notes.ts';
import {
  meetingDirPath,
  meetingIndexPath,
  meetingTranscriptPath,
} from '../src/meetings.ts';
import { runNotesCleanupPass } from '../src/notes-cleanup-pass.ts';
import { NOTES_AUTHOR_ID, type NotesDocStore } from '../src/notes-doc-access.ts';

const DOC = 'd-harbor';
const MEETING = 'm-harborlight-ferry';

/** The meeting, as it was heard. Entirely invented. */
const TRANSCRIPT: readonly { speaker: string; text: string }[] = [
  {
    speaker: 'A',
    text: 'Right — the Harborlight timetable. The half-hour service starts in April.',
  },
  { speaker: 'B', text: 'April the sixth, first sailing at six twenty from Riverbend.' },
  { speaker: 'A', text: 'And the slipway. It closes for maintenance the whole of October.' },
  { speaker: 'B', text: 'The whole month, yes. We run from the north pontoon while it is shut.' },
  { speaker: 'A', text: 'Who tells the season ticket holders?' },
  { speaker: 'B', text: 'I will. Letter goes out the first week of March, before people renew.' },
  {
    speaker: 'A',
    text: 'Winter crew — we said we would keep them on until April rather than let them go in February.',
  },
  {
    speaker: 'B',
    text: 'Agreed. That is four extra staff for two months, and it comes out of the maintenance budget.',
  },
  {
    speaker: 'A',
    text: 'One more thing. The Kestrel Lane stop. Do we keep it in the winter table?',
  },
  {
    speaker: 'B',
    text: 'Keep it. It is three sailings a day and it is the only stop on that side.',
  },
  { speaker: 'A', text: 'Then we are done. I will put the timetable draft round on Friday.' },
];

/**
 * Notes that need no help: every decision above, in the shape the live
 * note-taker writes them, under the heading it opened.
 *
 * THE SPEAKER TAGS ARE PART OF "GOOD", and finding that out is what this
 * harness is for. The first version of this fixture wrote the decisions
 * without them, and the pass rewrote all three bullets — every run, on both
 * the model's samples — to add nothing but the tag. It was not churning: the
 * note-taker's own instructions say a decision names who has it, so a bullet
 * without one is a bullet that breaks the house rules, and the pass was
 * right to fix it. What the measurement below can therefore say is narrower
 * and truer than "it leaves notes alone": it leaves alone notes that are
 * good BY THE RULES THE LIVE NOTE-TAKER WRITES BY. A doc whose notes were
 * written some other way will be brought into line with them.
 */
const GOOD = [
  '# Harborlight ferry',
  '',
  '## Meeting notes',
  '',
  '### Timetable',
  '',
  '- Half-hour service starts 6 April, first sailing 06:20 from Riverbend',
  '- Kestrel Lane stays in the winter table — three sailings a day, and the only stop on that side',
  '',
  '### Slipway',
  '',
  '- The slipway closes for maintenance for the whole of October',
  '- Sailings run from the north pontoon while it is shut',
  '',
  '### Decisions and who has them',
  '',
  '- [@Ivo](speaker:B) keeps the winter crew on until April rather than letting them go in February — four staff for two months, out of the maintenance budget',
  '- [@Ivo](speaker:B) sends the letter to season ticket holders in the first week of March, before renewals',
  '- [@Wren](speaker:A) circulates the timetable draft on Friday',
].join('\n');

/**
 * The same meeting, badly served: no structure, one wrong-headed lump, and
 * two decided things missing (the March letter, the winter crew's cost).
 */
const POOR = [
  '# Harborlight ferry',
  '',
  '## Meeting notes',
  '',
  '- talked about the timetable, half hour service, april',
  '- slipway closed october',
  '- kestrel lane discussion',
].join('\n');

interface Arm {
  name: string;
  markdown: string;
  /** What a pass that is working does to this arm. */
  expect: 'no change' | 'some change';
}

const ARMS: readonly Arm[] = [
  { name: 'RESTRAINT (good notes)', markdown: GOOD, expect: 'no change' },
  { name: 'CONTROL   (poor notes)', markdown: POOR, expect: 'some change' },
];

/** A doc store over one Y.Doc, with the notes section marked as the
 *  note-taker's own — the state a finished meeting leaves behind. */
function buildDoc(markdown: string): { store: NotesDocStore; ydoc: Y.Doc; headingId: string } {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  prose.applyMarkdownToFragment(fragment, markdown);
  prose.readOutline(ydoc);
  let owning = false;
  for (const el of prose.addressableBlocks(fragment)) {
    if (el.toString().includes('Meeting notes')) owning = true;
    if (owning) el.setAttribute('cwAuthor', NOTES_AUTHOR_ID);
  }
  const heading = prose.readOutline(ydoc).find((b) => b.text === 'Meeting notes');
  if (!heading) throw new Error('the fixture has no notes heading');
  const doc = { ydoc, meta: { type: 'markdown' as const } };
  return {
    ydoc,
    headingId: heading.id,
    store: {
      get: (id) => (id === DOC ? doc : undefined),
      readOutline: (id, opts) => (id === DOC ? { blocks: prose.readOutline(ydoc, opts) } : null),
      applyBlockEdits: (id, edits, who) => {
        if (id !== DOC) return { ok: false, error: 'not-found' };
        return {
          ok: true,
          ...prose.applyBlockEdits(ydoc, edits, {
            author: who.author,
            suggestionAuthor: { id: who.author, name: who.author, color: '#777' },
          }),
        };
      },
    },
  };
}

function writeTranscript(dataDir: string): void {
  mkdirSync(meetingDirPath(dataDir, DOC), { recursive: true });
  writeFileSync(
    meetingTranscriptPath(dataDir, DOC, MEETING),
    `${TRANSCRIPT.map((t, i) => JSON.stringify({ turn: i, text: t.text, speaker: t.speaker, ts: i })).join('\n')}\n`,
  );
  writeFileSync(
    meetingIndexPath(dataDir, DOC),
    `${[
      JSON.stringify({
        meetingId: MEETING,
        docId: DOC,
        startedAt: 1,
        engine: 'mock',
        sampleRate: 16000,
      }),
      JSON.stringify({ meetingId: MEETING, speakers: { A: 'Wren', B: 'Ivo' } }),
      JSON.stringify({ meetingId: MEETING, endedAt: 99, turns: TRANSCRIPT.length }),
    ].join('\n')}\n`,
  );
}

async function runArm(arm: Arm, composer: NotesComposer, dataDir: string) {
  const { store, ydoc, headingId } = buildDoc(arm.markdown);
  const before = prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
  const result = await runNotesCleanupPass(
    { docStore: () => store, composer, dataDir, headingIdOf: () => headingId },
    { docId: DOC, meetingId: MEETING },
  );
  const after = prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
  return { result, before, after, changed: before !== after };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arms = Number(argv[argv.indexOf('--arms') + 1]) || 1;
  const stub = argv.includes('--stub');
  const composer = stub ? createStubNotesComposer() : createHaikuNotesComposer();
  if (!composer) {
    console.error(
      'No composer: this machine has no dedicated summary credential, so there is\n' +
        'nothing to measure. Run with --stub to exercise the harness itself.',
    );
    process.exit(2);
  }
  console.log(`composer: ${composer.name}, ${arms} run(s) per arm\n`);

  const dataDir = mkdtempSync(join(tmpdir(), 'cw-cleanup-check-'));
  writeTranscript(dataDir);
  let vacuous = false;
  try {
    for (const arm of ARMS) {
      const touched: number[] = [];
      for (let i = 0; i < arms; i++) {
        const { result, after, changed } = await runArm(arm, composer, dataDir);
        touched.push(result.touched);
        console.log(
          `${arm.name}  run ${i + 1}: proposed ${result.proposed}, refused ${result.refused}, ` +
            `TOUCHED ${result.touched}, document ${changed ? 'CHANGED' : 'identical'}`,
        );
        if (changed && process.argv.includes('--show')) console.log(`\n${after}\n`);
      }
      const total = touched.reduce((a: number, b: number) => a + b, 0);
      const verdict =
        arm.expect === 'no change'
          ? total === 0
            ? 'PASS — it left good notes alone'
            : `LOOK — it touched ${total} block(s) that needed no help`
          : total > 0
            ? 'PASS — it improved thin notes'
            : 'VACUOUS — it changed nothing here either, so the number above proves nothing';
      if (arm.expect === 'some change' && total === 0) vacuous = true;
      console.log(`  → ${verdict}\n`);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  if (vacuous) process.exit(1);
}

await main();
