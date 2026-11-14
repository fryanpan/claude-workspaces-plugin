/**
 * The last thing said reaches the notes even when the edit that carried it
 * was a placement the doc refused.
 *
 * WHAT WENT MISSING. A huddle's notes cut a point off mid-sentence: the end
 * of one spoken note never arrived. The meeting's log had six ticks whose
 * batch carried an `insert_before_block` the doc refused (`nested-item`),
 * each reported as "carried no words this pipeline could put back", and the
 * summary counted every settled turn as composed while one idea was in no
 * note. Both readings were wrong for one shape of reply: a model that opens
 * a subheading in front of a bullet and writes the new note under it in the
 * SAME markdown. The note rides the placement, the placement is refused, and
 * the repair path left refused placements alone because re-homing "the
 * subheading" would put it at the section end. The note went with it.
 *
 * Each case ends speech just before a pause or a stop, which is where a
 * point's tail lands: the last compose before quiet. Hermetic: a scripted
 * model, the real write path, fixture speakers Alice and Bob.
 */

import { describe, expect, it } from 'bun:test';
import type { prose } from '@claude-workspaces/core';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { notesSubTopicHashes } from '../src/notes-heading-level.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

const LEAD = 'Alice wants the export to keep its date range';
const SUB = 'Bob saw it reset on the second visit';
const TAIL = 'Alice will ship the fix by Friday, because support is swamped';

/** A note under the section with one sub-bullet, so the doc holds a nested
 *  item a later placement can name. */
const opening = (input: NotesComposeInput): prose.BlockEdit[] =>
  addNotes(input, `- ${LEAD}\n  - ${SUB}`);

/** The id of the sub-bullet, as the outline lists it. */
function nestedId(input: NotesComposeInput): string {
  const nested = input.outline.find((e) => e.kind === 'listItem' && (e.depth ?? 0) > 0);
  if (nested === undefined) throw new Error('no nested bullet in the outline');
  return nested.id;
}

/** A subheading opened in front of the sub-bullet, with the new note under
 *  it in the same markdown — the reply the doc refuses as `nested-item`. */
const placedOnNested = (input: NotesComposeInput, note: string): prose.BlockEdit[] => [
  {
    op: 'insert_before_block',
    blockId: nestedId(input),
    markdown: `${notesSubTopicHashes(input.outline)} Shipping the fix\n\n- ${note}`,
  },
];

describe('a note carried by a refused placement', () => {
  it('reaches the notes when the speech ends just before a pause', async () => {
    const h = createNotesTickHarness({
      compose: (input, tick) => (tick === 1 ? opening(input) : placedOnNested(input, TAIL)),
    });
    await h.speak({ speaker: 'A', text: `${LEAD}.` }, { speaker: 'B', text: `${SUB}.` });
    await h.speak({
      speaker: 'A',
      text: 'And I will ship the fix by Friday, because support is swamped.',
    });
    expect(h.notes()).toContain(TAIL);
    expect(h.notes()).toContain(LEAD);
  });

  it('reaches the notes when the speech ends just before a stop', async () => {
    const h = createNotesTickHarness({
      compose: (input, tick) => (tick === 1 ? opening(input) : placedOnNested(input, TAIL)),
    });
    await h.speak({ speaker: 'A', text: `${LEAD}.` }, { speaker: 'B', text: `${SUB}.` });
    h.say({ speaker: 'A', text: 'And I will ship the fix by Friday, because support is swamped.' });
    await h.end();
    expect(h.notes()).toContain(TAIL);
  });

  it('a plain insert at the stop lands without any repair (the stop path itself keeps the tail)', async () => {
    const h = createNotesTickHarness({
      compose: (input, tick) => (tick === 1 ? opening(input) : addNotes(input, `- ${TAIL}`)),
    });
    await h.speak({ speaker: 'A', text: `${LEAD}.` }, { speaker: 'B', text: `${SUB}.` });
    h.sayPartial('and I will ship the fix by Friday because support is', 'A');
    await h.end();
    expect(h.notes()).toContain(TAIL);
    expect(h.summary()?.turnsLost).toBe(0);
  });

  it('writes no stray subheading when the placement carried only a heading', async () => {
    const h = createNotesTickHarness({
      compose: (input, tick) =>
        tick === 1
          ? opening(input)
          : [
              {
                op: 'insert_before_block',
                blockId: nestedId(input),
                markdown: `${notesSubTopicHashes(input.outline)} Shipping the fix`,
              },
              ...addNotes(input, `- ${TAIL}`),
            ],
    });
    await h.speak({ speaker: 'A', text: `${LEAD}.` }, { speaker: 'B', text: `${SUB}.` });
    await h.speak({
      speaker: 'A',
      text: 'And I will ship the fix by Friday, because support is swamped.',
    });
    expect(h.notes()).toContain(TAIL);
    expect(h.notes()).not.toContain('Shipping the fix');
    expect(h.errors).toEqual([]);
  });
});
