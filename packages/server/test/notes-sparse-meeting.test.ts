/**
 * A SPARSE MEETING: one short turn, then quiet, then one more — fourteen
 * times over. Two people thinking out loud, not a room in full flow.
 *
 * WHY THIS SHAPE HAS ITS OWN FILE. Every other script here settles several
 * turns into a tick, so each tick carries a paragraph of speech and the
 * note-taker answers it with a bullet of its own. A tick carrying ONE short
 * sentence is a different prompt: the doc already holds a bullet, the new
 * speech continues it, and "if the new speech corrects one of your notes,
 * replace that note" reads as the instruction that fits. The model then
 * answers with a `replace_block`, the doc does exactly as it is told, and the
 * earlier turn's words leave the meeting.
 *
 * Measured in production on 2026-09-11 and reproduced below: fourteen ticks,
 * every one of them composing and writing, no refusal and no failed edit
 * anywhere in the log, and a notes section that ended with two bullets.
 *
 * The composer here is scripted, so no test in this file calls a model.
 */

import { describe, expect, test } from 'bun:test';
import {
  type NotesTickHarness,
  addNotes,
  createNotesTickHarness,
  notesItems,
  replaceOwnBullet,
} from './notes-tick-harness.ts';

/**
 * Fourteen turns, one per tick, each about its own thing — a meeting whose
 * speech moves on rather than circling one point. Fictional names only.
 *
 * Every one of them is long enough to make a note the guard will judge: a
 * note of three content words or fewer is below the floor in
 * `notes-edit-guard.ts` and stays replaceable on purpose, which
 * `notes-edit-guard.test.ts` pins separately. A fixture that mixed the two
 * would be measuring the floor while claiming to measure the rule.
 */
const TURNS = [
  'we should move the Harborlight launch to the second week',
  'the Riverbend batch is running two days behind',
  'Saltmarsh wants the pricing sheet before Friday',
  'the packaging vendor raised the unit cost again',
  'we can absorb the extra cost if the order volume holds',
  'the second line needs a new operator',
  'training takes about three weeks',
  'I will ask the packaging contractor for a written quote',
  'the shipping window closes on the twentieth',
  'we lose the slot if the labels are late',
  'the label proof came back with the wrong weight',
  'reprinting costs about four hundred',
  'lets keep the old artwork for this run',
  'I will send the revised sheet tonight',
];

/** The note-taker as the log caught it: the first tick opens the section, and
 *  every tick after it rewrites the bullet it wrote last time with a note
 *  about the speech it has just heard. */
async function runSparseMeeting(): Promise<NotesTickHarness> {
  const h = meeting();
  for (const said of TURNS) await h.speak(said);
  await h.end();
  return h;
}

function meeting(): NotesTickHarness {
  return createNotesTickHarness({
    compose: (input, tick) => {
      const said = input.tick.turns.map((t) => t.text).join(' ');
      if (said.trim().length === 0) return [];
      const md = `- ${said}`;
      return tick === 1 ? addNotes(input, md) : replaceOwnBullet(input, md);
    },
  });
}

describe('a meeting carrying one turn per tick keeps every turn it noted', () => {
  test('fourteen ticks leave fourteen notes, not the last one', async () => {
    const h = await runSparseMeeting();
    expect(h.snapshots).toHaveLength(TURNS.length);
    // The whole symptom in one number: on the base commit this is 1.
    expect(notesItems(h.ydoc)).toHaveLength(TURNS.length);
  }, 30_000);

  test('the first tick’s words are still in the notes when the meeting ends', async () => {
    const h = await runSparseMeeting();
    expect(h.notes()).toContain('Harborlight launch to the second week');
    expect(h.notes()).toContain('Riverbend batch is running two days behind');
  }, 30_000);

  test('no tick failed, was refused, or lost a turn on the way', async () => {
    const h = await runSparseMeeting();
    // The production log said the same: the collapse leaves no trace in any
    // of the counters a reader would think to check.
    expect(h.errors).toEqual([]);
    expect(h.summary()?.composeFailures).toBe(0);
    expect(h.summary()?.turnsLost).toBe(0);
    expect(h.countHeadings('Meeting notes')).toBe(1);
  }, 30_000);
});
