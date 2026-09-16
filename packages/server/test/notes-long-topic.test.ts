/**
 * A MEETING THAT STAYS ON ONE SUBJECT FOR HALF AN HOUR, driven end to end.
 *
 * On 16 September one heading in a real meeting's notes carried twenty-nine
 * minutes of talk — sixty-five bullets in its longest unbroken run — while
 * `MAX_FLAT_RUN_BULLETS` was four and the server was counting the run on
 * every tick. Two things in `notes-regroup.ts` made that possible, and
 * neither of them is the model:
 *
 * 1. THE DIRECTIVE NEVER REACHED THE TOPIC. `sectionOf` scoped the scan to
 *    the meeting's section, and a section ENDS at the next heading of the
 *    same level — which is the second topic the meeting itself opens. So the
 *    ask fired for a meeting's FIRST topic and for nothing after it, and a
 *    meeting spends almost all of itself after it.
 * 2. THERE WAS ONE REMEDY. A run under a heading could only ever be asked to
 *    NEST. Nesting cannot repair a heading that has swallowed half an hour:
 *    the reader still meets one heading with thirty minutes under it, now in
 *    groups.
 *
 * THE NOTE-TAKER HERE OBEYS EVERY ASK IT IS GIVEN, exactly and immediately —
 * it reads the directive the server built and does what it says, and writes a
 * plain bullet when it is asked for nothing. That is the point of the shape:
 * what it leaves behind is what the SERVER's instructions are worth, with the
 * model's judgement taken out of the measurement entirely. A wall it builds
 * is a wall nobody asked it not to build.
 *
 * Every fixture name is invented. The repo is public.
 */

import { describe, expect, test } from 'bun:test';
import type { prose } from '@claude-workspaces/core';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { notesSubTopicHashes, notesTopicHashes } from '../src/notes-heading-level.ts';
import { buildNotesPrompt } from '../src/notes-prompt-build.ts';
import {
  MAX_FLAT_RUN_BULLETS,
  allBullets,
  duplicateTopics,
  flatBulletRuns,
  parseNotesTopics,
} from '../src/notes-quality.ts';
import { MAX_TOPIC_NOTES } from '../src/notes-regroup.ts';
import { createNotesTickHarness } from './notes-tick-harness.ts';

/**
 * The meeting: a short opening subject, then one the room does not leave.
 *
 * Sixty-four ticks under the second heading is what "twenty-nine minutes on
 * one subject" looks like on the tick clock, and it is the only property of
 * the script that matters — the words are filler because the note-taker here
 * is not judging them.
 */
const OPENING_TICKS = 5;
const LONG_RUN_TICKS = 64;

interface Turn {
  text: string;
  /** The first tick of a subject, and what the room is now talking about. */
  opens?: string;
}

function script(): Turn[] {
  const turns: Turn[] = [
    {
      text: 'The Harborlight survey starts the first Monday of March.',
      opens: 'Harborlight survey',
    },
  ];
  for (let i = 2; i <= OPENING_TICKS; i++) {
    turns.push({ text: `A further point about the survey window, number ${i}.` });
  }
  turns.push({
    text: 'Different subject. The slipway crane has to be booked this week.',
    opens: 'Slipway crane booking',
  });
  for (let i = 1; i <= LONG_RUN_TICKS; i++) {
    turns.push({ text: `Still on the crane: consideration number ${i} for the booking.` });
  }
  return turns;
}

/** The last heading in the outline — the topic the room is currently under. */
function currentHeading(outline: readonly prose.OutlineEntry[]): string | undefined {
  for (let i = outline.length - 1; i >= 0; i--) {
    if (outline[i]?.kind === 'heading') return outline[i]?.id;
  }
  return undefined;
}

/**
 * What the directive is asking for this tick, read off the text the model
 * reads. `null` when it is asking for nothing, which is the ordinary tick.
 *
 * The three asks are told apart by the line each one leads with, and the
 * nesting ask hands over a `nest_blocks` call to copy verbatim — so an
 * obedient note-taker needs no judgement to carry it out, which is what makes
 * this a measurement of the ask rather than of the model.
 */
function readAsk(
  prompt: string,
): { kind: 'nest'; edit: prose.BlockEdit } | { kind: 'heading' } | { kind: 'split' } | null {
  if (prompt.includes('UNDER NO HEADING')) return { kind: 'heading' };
  if (prompt.includes('HAS RUN PAST ONE HEADING')) return { kind: 'split' };
  const call = prompt.match(/\{"op":"nest_blocks"[^}]*\}/);
  if (call) return { kind: 'nest', edit: JSON.parse(call[0]) as prose.BlockEdit };
  return null;
}

/** A note-taker that does exactly what the prompt asks and nothing else. */
function obedient(turns: readonly Turn[]) {
  return (input: NotesComposeInput, tick: number): prose.BlockEdit[] => {
    const turn = turns[tick - 1];
    if (!turn) return [];
    const ask = readAsk(buildNotesPrompt(input).user);
    // An ask about the notes already written comes first: every one of them
    // says in as many words not to add another flat bullet this update.
    // NESTING AND THIS TICK'S NOTE, in one batch — which is what the ask now
    // says to do, and the reason it says so is in the numbers this test
    // prints: the ask used to forbid the note, and an obedient note-taker
    // wrote 56 notes over these 70 ticks instead of 70.
    if (ask?.kind === 'nest') {
      const headingId = currentHeading(input.outline);
      return headingId === undefined
        ? [ask.edit]
        : [ask.edit, { op: 'insert_under_heading', headingId, markdown: `- ${turn.text}` }];
    }
    // AN ASK THAT IS ALREADY SATISFIED IS NOT CARRIED OUT, and this clause is
    // what keeps the base measurement honest rather than absurd. Told its
    // notes sit under no heading while it is looking straight at the heading
    // they sit under, a note-taker writes its bullet; it does not open a
    // sixty-seventh copy of the same topic. Without this the base commit's
    // wall never forms — the run is destroyed every tick by a duplicate
    // heading, which is a different bug's symptom, not this one's.
    if (ask?.kind === 'heading' && currentHeading(input.outline) === undefined) {
      return [
        {
          op: 'insert_at_end',
          markdown: `${notesTopicHashes(input.outline)} ${turn.opens ?? 'The subject so far'}`,
        },
      ];
    }
    if (ask?.kind === 'split') {
      // Still the same subject, so the remedy that fits is a subheading for
      // the part of it the room has reached — carrying this speech's point
      // with it, which is what the ask hands over a call for.
      return [
        {
          op: 'insert_at_end',
          markdown: `${notesSubTopicHashes(input.outline)} Booking detail ${tick}\n\n- ${turn.text}`,
        },
      ];
    }
    if (turn.opens !== undefined) {
      return [
        {
          op: 'insert_at_end',
          markdown: `${notesTopicHashes(input.outline)} ${turn.opens}\n\n- ${turn.text}`,
        },
      ];
    }
    const headingId = currentHeading(input.outline);
    if (headingId === undefined) return [{ op: 'insert_at_end', markdown: `- ${turn.text}` }];
    return [{ op: 'insert_under_heading', headingId, markdown: `- ${turn.text}` }];
  };
}

/** The longest run of flat bullets anywhere in the notes. */
function longestRun(markdown: string): number {
  return flatBulletRuns(markdown).reduce((most, r) => Math.max(most, r.bullets.length), 0);
}

/** How many notes sit under the fullest single heading. */
function largestTopic(markdown: string): number {
  return parseNotesTopics(markdown).reduce((most, t) => Math.max(most, t.bullets.length), 0);
}

describe('a meeting that stays on one subject', () => {
  test('leaves no heading with a wall of flat bullets under it', async () => {
    const turns = script();
    const harness = createNotesTickHarness({ compose: obedient(turns) });
    for (const turn of turns) await harness.speak(turn.text);
    const notes = harness.markdown();

    const runs = flatBulletRuns(notes).map((r) => r.bullets.length);
    const topics = parseNotesTopics(notes).filter((t) => t.heading).length;
    console.log(
      `[long-topic] ${turns.length} ticks: longest run ${longestRun(notes)}, ` +
        `largest topic ${largestTopic(notes)}, ${topics} topics, ` +
        `${allBullets(notes).length} notes, ` +
        `${duplicateTopics(notes).length} duplicate headings, runs ${runs.join(',')}`,
    );

    expect(longestRun(notes)).toBeLessThanOrEqual(MAX_FLAT_RUN_BULLETS);
    expect(largestTopic(notes)).toBeLessThanOrEqual(MAX_TOPIC_NOTES);
    // AND NOT PAID FOR IN IDEAS. Every one of these ticks had something to
    // say, so every one of them should have left a note: a remedy that
    // takes a tick away from the speech is a remedy that loses what was
    // said, and the first version of this one lost fourteen of seventy.
    expect(allBullets(notes)).toHaveLength(turns.length);
    // AND NOT BY OPENING A HEADING A TICK. A note-taker that answered every
    // full topic with a new heading passes both lines above and leaves the
    // reader a table of contents — which is exactly what the first version
    // of the split ask produced, 51 headings over these 70 ticks, because
    // it went on asking a heading the room had already moved on from. So
    // the count of headings is a bar of its own: a meeting whose notes are
    // capped at twelve per heading needs about one heading per twelve
    // ticks, plus the two subjects the room actually has.
    expect(topics).toBeLessThanOrEqual(Math.ceil(turns.length / MAX_TOPIC_NOTES) + 2);
    expect(duplicateTopics(notes)).toEqual([]);
  }, 30_000);
});

/**
 * THE WALL THAT IS ALREADY THERE — the state the 16 September meeting was
 * actually in, and the one the first fix above never reaches.
 *
 * The test above proves the ask fires in time to stop a wall FORMING. It says
 * nothing about a wall that has already formed, and that is the case Bryan
 * asked about: sixty-five bullets were on the page, and no edit the note-taker
 * had could break them up. Every insert landed at an END — `insert_at_end` at
 * the end of the document, `insert_under_heading` at the end of the named
 * section — so a heading could be written but never PLACED, and the twenty-nine
 * minutes above it stayed one block whatever the model was told. That is a gap
 * in the EDITS, not in the prompt: no wording reaches a position the ops cannot
 * express.
 *
 * So this drives the two halves separately. The note-taker spends the first
 * sixty ticks ignoring every ask — which is what the old one did, and is the
 * only way to build the state under test — and the wall is MEASURED before
 * anything is asked to repair it. Then it starts obeying, and the question is
 * whether what it is now offered can take the wall apart.
 *
 * THE OBEDIENT HALF STILL EXERCISES NO JUDGEMENT. Told to put a heading in
 * front of the note a new part starts at, it applies a mechanical rule — the
 * new part starts after the first `MAX_FLAT_RUN_BULLETS` notes of the topic —
 * so what the numbers below measure is the reach of the op and the ask, with
 * the model's reading of the meeting taken out of it.
 */
describe('a meeting that has already built a wall', () => {
  test('breaks the wall up once the note-taker can place a heading', async () => {
    const WALL_TICKS = 60;
    const REPAIR_TICKS = 24;
    let obeying = false;

    /** The note the ask hands over: the first top-level bullet of the topic
     *  the room is under, `MAX_FLAT_RUN_BULLETS` in. */
    const newPartStartsAt = (outline: readonly prose.OutlineEntry[]): string | undefined => {
      const headingId = currentHeading(outline);
      const under = outline.filter(
        (e) => e.kind === 'listItem' && e.depth === 0 && e.underHeadingId === headingId,
      );
      return under[MAX_FLAT_RUN_BULLETS]?.id;
    };

    const harness = createNotesTickHarness({
      compose: (input, tick) => {
        const headingId = currentHeading(input.outline);
        const bullet = `- Crane booking consideration number ${tick}.`;
        if (tick === 1) {
          return [{ op: 'insert_at_end', markdown: `## Slipway crane booking\n\n${bullet}` }];
        }
        // THE OLD NOTE-TAKER, for as long as the wall is being built: every
        // ask ignored, a flat bullet every tick. Nothing here is a claim
        // about what a model does — it is the shape of the notes that were
        // on the page on 16 September, reproduced so it can be repaired.
        if (!obeying || headingId === undefined) {
          return [{ op: 'insert_under_heading', headingId: headingId ?? '', markdown: bullet }];
        }
        // BOTH ASKS, WHEN BOTH ARE THERE. The directive stopped forbidding the
        // nest once a heading could be PLACED rather than only appended, so a
        // note-taker that carries out one and drops the other is not obeying
        // it. Split first: placing a heading changes no id and no depth,
        // where nesting a bullet would move the one the split names out of
        // reach.
        const prompt = buildNotesPrompt(input).user;
        const edits: prose.BlockEdit[] = [];
        const splitAt = prompt.includes('HAS RUN PAST ONE HEADING')
          ? newPartStartsAt(input.outline)
          : undefined;
        if (splitAt !== undefined) {
          edits.push({
            op: 'insert_before_block',
            blockId: splitAt,
            markdown: `${notesSubTopicHashes(input.outline)} Booking detail from note ${tick}`,
          });
        }
        const nest = prompt.match(/\{"op":"nest_blocks"[^}]*\}/);
        if (nest) edits.push(JSON.parse(nest[0]) as prose.BlockEdit);
        // THIS SPEECH GOES UNDER THE PART THAT IS NOW LIVE, which is the one
        // the heading was just placed in front of — the end of the doc.
        // Sending it to the heading the split names puts it back on the
        // stretch being broken up, one bullet at a time.
        edits.push(
          splitAt === undefined
            ? { op: 'insert_under_heading', headingId, markdown: bullet }
            : { op: 'insert_at_end', markdown: bullet },
        );
        return edits;
      },
    });

    for (let i = 0; i < WALL_TICKS; i++) await harness.speak(`Crane point ${i}.`);
    const built = harness.markdown();
    const wall = longestRun(built);
    console.log(
      `[already-built] after ${WALL_TICKS} ticks: longest run ${wall}, ` +
        `largest topic ${largestTopic(built)}, ` +
        `${parseNotesTopics(built).filter((t) => t.heading).length} topics`,
    );
    // The state under test, asserted rather than assumed: one heading, and
    // everything the meeting said in one unbroken list beneath it.
    expect(wall).toBeGreaterThanOrEqual(WALL_TICKS - 1);
    expect(parseNotesTopics(built).filter((t) => t.heading)).toHaveLength(1);

    obeying = true;
    for (let i = 0; i < REPAIR_TICKS; i++) await harness.speak(`Further crane point ${i}.`);
    const fixed = harness.markdown();

    const runs = flatBulletRuns(fixed).map((r) => r.bullets.length);
    const topics = parseNotesTopics(fixed).filter((t) => t.heading).length;
    console.log(
      `[already-built] after ${REPAIR_TICKS} more: longest run ${longestRun(fixed)}, ` +
        `largest topic ${largestTopic(fixed)}, ${topics} topics, ` +
        `${allBullets(fixed).length} notes, ` +
        `${duplicateTopics(fixed).length} duplicate headings, runs ${runs.join(',')}`,
    );

    expect(longestRun(fixed)).toBeLessThanOrEqual(MAX_FLAT_RUN_BULLETS);
    // AND THE HEADING NO LONGER STANDS OVER THE STRETCH. This is the bar the
    // run alone does not carry: the control below brings the run down by
    // nesting and leaves all sixty notes under one heading, which is the
    // defect exactly. A topic within its own bar is the proof the stretch was
    // broken rather than folded.
    expect(largestTopic(fixed)).toBeLessThanOrEqual(MAX_TOPIC_NOTES);
    // BROKEN BY HEADINGS, not by nesting: the wall was flat, so a run that
    // has come down while the heading count has not is a run that was folded
    // out of sight rather than named.
    expect(topics).toBeGreaterThan(1);
    // AND NOTHING WAS LOST DOING IT. The repair moves no text — a heading
    // placed in front of a note re-parents it by arriving — so every bullet
    // the meeting wrote is still a bullet in the notes.
    expect(allBullets(fixed)).toHaveLength(WALL_TICKS + REPAIR_TICKS);
    expect(duplicateTopics(fixed)).toEqual([]);
    // AND NOT BY TURNING THE NOTES INTO A TABLE OF CONTENTS. Breaking a wall
    // sixty bullets long needs a lot of headings — it cannot need more than
    // one per bar's worth of notes, or the repair has traded a stretch nobody
    // can read for a list of headings nobody can read.
    expect(topics).toBeLessThanOrEqual(allBullets(fixed).length / MAX_FLAT_RUN_BULLETS);
  }, 60_000);

  /**
   * THE CONTROL, and the reason it is in this file rather than in a note: the
   * same wall, the same directive, the same obedient note-taker — and the
   * only heading placement the old vocabulary had. `insert_at_end` appends,
   * so the heading lands BELOW the stretch it was meant to head and the sixty
   * bullets above it stay one run for the rest of the meeting, whatever the
   * model is told. Without this the test above proves only that the notes
   * came out tidy; with it, it proves what made them tidy.
   */
  test('CONTROL: appending the heading leaves the wall exactly where it was', async () => {
    const WALL_TICKS = 60;
    const REPAIR_TICKS = 24;
    let obeying = false;

    const harness = createNotesTickHarness({
      compose: (input, tick) => {
        const headingId = currentHeading(input.outline);
        const bullet = `- Crane booking consideration number ${tick}.`;
        if (tick === 1) {
          return [{ op: 'insert_at_end', markdown: `## Slipway crane booking\n\n${bullet}` }];
        }
        if (!obeying || headingId === undefined) {
          return [{ op: 'insert_under_heading', headingId: headingId ?? '', markdown: bullet }];
        }
        const prompt = buildNotesPrompt(input).user;
        const edits: prose.BlockEdit[] = [];
        if (prompt.includes('HAS RUN PAST ONE HEADING')) {
          edits.push({
            op: 'insert_at_end',
            markdown: `${notesSubTopicHashes(input.outline)} Booking detail from note ${tick}`,
          });
        }
        const nest = prompt.match(/\{"op":"nest_blocks"[^}]*\}/);
        if (nest) edits.push(JSON.parse(nest[0]) as prose.BlockEdit);
        edits.push({ op: 'insert_at_end', markdown: bullet });
        return edits;
      },
    });

    for (let i = 0; i < WALL_TICKS; i++) await harness.speak(`Crane point ${i}.`);
    const wall = longestRun(harness.markdown());
    obeying = true;
    for (let i = 0; i < REPAIR_TICKS; i++) await harness.speak(`Further crane point ${i}.`);
    const after = harness.markdown();

    console.log(
      `[already-built CONTROL] wall ${wall} -> longest run ${longestRun(after)}, ` +
        `largest topic ${largestTopic(after)}, ` +
        `${parseNotesTopics(after).filter((t) => t.heading).length} topics`,
    );

    // AND WHAT IT PROVES IS SHARPER THAN EXPECTED. Nesting does bring the
    // flat RUN down — the old vocabulary could fold sixty bullets into groups
    // — so a test that watched only the run would have called this fixed.
    // What it cannot do is move the heading: all sixty notes are still under
    // the one the meeting opened, which is the defect in Bryan's words, "one
    // heading swallowed half an hour". The reader meets the same stretch, now
    // in groups. That is why the bar this branch adds is the TOPIC size and
    // not only the run.
    expect(largestTopic(after)).toBeGreaterThanOrEqual(WALL_TICKS);
    expect(parseNotesTopics(after).filter((t) => t.heading).length).toBeLessThanOrEqual(2);
  }, 60_000);
});
