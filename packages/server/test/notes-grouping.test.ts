/**
 * A topic that grows past the flat-bullet bar, driven through the real tick
 * pipeline — the doc store, the guard, the applier and the outline the next
 * tick is built from.
 *
 * The unit tests beside this one prove the directive names the right blocks
 * and that `nest_blocks` moves them. This one asks the question the eval asks:
 * after a meeting that would have built a wall, does `longFlatRuns` read zero,
 * and is every point still there.
 */
import { describe, expect, test } from 'bun:test';
import { type prose, prose as proseNs } from '@claude-workspaces/core';
import * as Y from 'yjs';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { NOTES_AUTHOR_ID } from '../src/notes-doc-access.ts';
import { parseNotesEdits } from '../src/notes-edit-parse.ts';
import { MAX_FLAT_RUN_BULLETS, allBullets, longFlatRuns } from '../src/notes-quality.ts';
import { regroupTargets } from '../src/notes-regroup.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

/** The point each tick of the scripted meeting contributes. */
const POINTS = [
  'People lose the remote between the cushions',
  'A locator beep would need a speaker in the case',
  'The beeper cost is not known yet',
  'The case has to survive a drop onto tile',
  'Rubber edging was floated and nobody costed it',
  'A hard shell was preferred over rubber',
];

/**
 * A note-taker that does what the directive asks: when the server reports a
 * topic has filled up, it regroups THAT topic with the ids it was handed
 * before adding this tick's point; otherwise it just adds the point.
 */
function groupingComposer(input: NotesComposeInput, tick: number): prose.BlockEdit[] {
  const point = POINTS[tick - 1];
  const targets = regroupTargets(input.outline, {
    author: NOTES_AUTHOR_ID,
    notesHeadingId: input.notesHeadingId,
  });
  const edits: prose.BlockEdit[] = [];
  const target = targets[0];
  const [lead, ...rest] = target?.movable ?? [];
  // Regroup FIRST, then write this tick's point. Grouping instead of writing
  // would drop a point, which is the one thing the rule never trades for.
  if (target && lead && rest.length > 0) {
    edits.push({
      op: 'nest_blocks',
      leadBlockId: lead.id,
      blockIds: rest.slice(0, 2).map((b) => b.id),
    });
  }
  if (!point) return edits;
  const headingId = input.outline.find((e) => e.text === 'Remote control usability')?.id;
  if (headingId === undefined) {
    return [...edits, ...addNotes(input, `### Remote control usability\n\n- ${point}`)];
  }
  return [...edits, { op: 'insert_under_heading', headingId, markdown: `- ${point}` }];
}

describe('a topic that fills up', () => {
  test('never runs past the bar, and keeps every point', async () => {
    const harness = createNotesTickHarness({ compose: groupingComposer });
    for (const point of POINTS) {
      const shot = await harness.speak({ speaker: 'Dana', text: point });
      // The bar, tick by tick — the same reading the eval takes.
      expect(longFlatRuns(shot.notes)).toEqual([]);
    }
    // Every point said is still a bullet, wherever it now sits.
    const written = allBullets(harness.notes());
    for (const point of POINTS) expect(written).toContain(point);
    expect(harness.errors).toEqual([]);
  });

  test('the notes end up nested rather than merely short', async () => {
    const harness = createNotesTickHarness({ compose: groupingComposer });
    for (const point of POINTS) await harness.speak({ speaker: 'Dana', text: point });
    expect(harness.notes()).toContain('\n  - ');
  });

  test('stops asking once the topic is grouped, reading the doc it built', async () => {
    const ydoc = new Y.Doc();
    const harness = createNotesTickHarness({ ydoc, compose: groupingComposer });
    for (const point of POINTS) await harness.speak({ speaker: 'Dana', text: point });
    // Off the REAL outline, not a hand-built one: this is the round trip that
    // proves a group the pipeline wrote reads back as a group. Told otherwise,
    // the note-taker would regroup the same topic every tick forever.
    const outline = proseNs.readOutline(ydoc);
    expect(outline.some((e) => (e.depth ?? 0) > 0)).toBe(true);
    expect(regroupTargets(outline, { author: NOTES_AUTHOR_ID })).toEqual([]);
  });

  test('a comment on a regrouped bullet keeps pointing at its own words', async () => {
    const ydoc = new Y.Doc();
    const harness = createNotesTickHarness({ ydoc, compose: groupingComposer });
    // Say enough to put a topic one point short of the bar, then have a
    // person comment on one of the bullets that is about to be moved.
    for (const point of POINTS.slice(0, MAX_FLAT_RUN_BULLETS - 1)) {
      await harness.speak({ speaker: 'Dana', text: point });
    }
    const needle = POINTS[1] as string;
    const walk = proseNs.walkProse(proseNs.getProseFragment(ydoc));
    const at = walk.plainText.indexOf(needle);
    expect(at).toBeGreaterThanOrEqual(0);
    const seg = walk.segments.find((s) => at >= s.docOffset && at < s.docOffset + s.length);
    if (!seg) throw new Error('the bullet has no text segment');
    const thread = new Y.Map<unknown>();
    thread.set('anchor', {
      kind: 'text-range',
      startRel: Y.encodeRelativePosition(
        Y.createRelativePositionFromTypeIndex(seg.node, at - seg.docOffset),
      ),
      endRel: Y.encodeRelativePosition(
        Y.createRelativePositionFromTypeIndex(seg.node, at - seg.docOffset + needle.length),
      ),
      snippet: { text: needle },
    });
    (ydoc.getMap('threads') as Y.Map<Y.Map<unknown>>).set('t1', thread);

    // Now cross the bar, which regroups the topic and moves that bullet.
    for (const point of POINTS.slice(MAX_FLAT_RUN_BULLETS - 1)) {
      await harness.speak({ speaker: 'Dana', text: point });
    }
    expect(harness.notes()).toContain(`  - ${needle}`);

    expect(proseNs.autoReanchorDoc(ydoc)).toMatchObject({ stillOrphan: 0 });
    const anchor = thread.get('anchor') as {
      kind: string;
      startRel: Uint8Array;
      endRel: Uint8Array;
    };
    expect(anchor.kind).toBe('text-range');
    const start = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(anchor.startRel),
      ydoc,
    );
    const end = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(anchor.endRel),
      ydoc,
    );
    expect(String(start?.type).slice(start?.index, end?.index)).toBe(needle);
  });

  test('a short meeting is left flat — the control', async () => {
    const harness = createNotesTickHarness({ compose: groupingComposer });
    for (const point of POINTS.slice(0, MAX_FLAT_RUN_BULLETS - 1)) {
      await harness.speak({ speaker: 'Dana', text: point });
    }
    expect(harness.notes()).not.toContain('\n  - ');
    expect(allBullets(harness.notes())).toHaveLength(MAX_FLAT_RUN_BULLETS - 1);
    expect(longFlatRuns(harness.notes())).toEqual([]);
  });
});

describe('reading a nest_blocks out of a model reply', () => {
  test('takes the lead and the blocks it names', () => {
    const { edits, dropped } = parseNotesEdits(
      '[{"op":"nest_blocks","leadBlockId":"b1","blockIds":["b2","b3"]}]',
    );
    expect(dropped).toEqual([]);
    expect(edits).toEqual([{ op: 'nest_blocks', leadBlockId: 'b1', blockIds: ['b2', 'b3'] }]);
  });

  test('drops the lead out of its own list rather than moving a bullet under itself', () => {
    const { edits } = parseNotesEdits(
      '[{"op":"nest_blocks","leadBlockId":"b1","blockIds":["b1","b2"]}]',
    );
    expect(edits).toEqual([{ op: 'nest_blocks', leadBlockId: 'b1', blockIds: ['b2'] }]);
  });

  test('discards one with nothing left to move, and says why', () => {
    const { edits, dropped } = parseNotesEdits(
      '[{"op":"nest_blocks","leadBlockId":"b1","blockIds":["b1"]}]',
    );
    expect(edits).toEqual([]);
    expect(dropped[0]).toContain('no blocks to move');
  });

  test('discards one with no lead', () => {
    const { edits, dropped } = parseNotesEdits('[{"op":"nest_blocks","blockIds":["b2"]}]');
    expect(edits).toEqual([]);
    expect(dropped[0]).toContain('without a lead id');
  });
});
