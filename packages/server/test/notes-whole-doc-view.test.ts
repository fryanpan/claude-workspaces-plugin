/**
 * WHAT THE NOTE-TAKER CAN SEE OF A DOCUMENT IT DOES NOT OWN.
 *
 * The claim these tests were written to check is that the tick's view of the
 * doc is a SLICE of the section the meeting believes it owns, and that this
 * is why notes a person typed during a meeting never reached the note-taker.
 * The first test is that claim, written as directly as it can be: a person
 * types a bullet outside the meeting's section while the meeting is running,
 * and the next tick's compose input is asked whether it carries their words.
 *
 * It passes on the code as it stands, so the claim is false as stated —
 * `readNotesOutlineForTick` reads the WHOLE doc. What USED to be sliced was
 * the recency window, which counted body blocks from the end of the document
 * and knew nothing about sections or about who wrote what: a person's line
 * was visible while the doc was short and gone once the note-taker's own
 * bullets had pushed it past eighty. That window is gone, and the second and
 * third tests are what say so — the same block, in the same place, in a doc
 * far longer than the window ever allowed, is still in the tick's view.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { type DocType, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { readNotesOutlineForTick } from '../src/meeting-notes-doc.ts';
import { sectionIds } from '../src/notes-cleanup-scope.ts';
import { asPerson, oneDocStore } from './notes-doc-helpers.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

/** What a person typed, on a line nothing else in these fixtures says. */
const THEIR_LINE = 'My own note: the harbour run needs its own budget line.';

/** Put a bullet in the doc as a person would, immediately ABOVE the meeting's
 *  section — the placement the claim is about. Returns its block id. */
function typeAboveTheSection(ydoc: Y.Doc, text: string): string {
  asPerson(ydoc, () => {
    const fragment = prose.getProseFragment(ydoc);
    const top = fragment.toArray() as Y.XmlElement[];
    const at = top.findIndex((el) => el.nodeName === 'heading' && prose.headingLevelOf(el) === 2);
    fragment.insert(at < 0 ? fragment.length : at, prose.parseMarkdownBlocks(`- ${text}`));
  });
  // Read the id back off the doc rather than minting one: `readOutline` mints
  // ids for blocks that lack them, which is how a person's fresh block gets
  // one at all.
  const entry = prose.readOutline(ydoc).find((e) => e.text === text);
  if (entry === undefined) throw new Error('the person’s block is not in the doc');
  return entry.id;
}

describe('the note-taker’s view of a document it shares with a person', () => {
  it('carries a bullet a person typed outside the meeting’s section, mid-meeting', async () => {
    const harness = createNotesTickHarness({
      doc: '# Project doc\n\nStanding context that was here before the meeting.\n',
      compose: (input, tick) => addNotes(input, `- Point ${tick} from the floor.`),
    });

    const first = await harness.speak('The sync is the bottleneck.');
    // CONTROL, HALF ONE — MID-MEETING. Their words are in no view yet,
    // because they have not typed them yet. A test that seeded the block
    // before the meeting could not tell "the view is whole-doc" from "the
    // view was built once at the start".
    expect(first.input?.outline.some((e) => e.text === THEIR_LINE)).toBe(false);

    const theirId = typeAboveTheSection(harness.ydoc, THEIR_LINE);

    const second = await harness.speak('Measure before rewriting.');
    const outline = second.input?.outline ?? [];
    const headingId = second.input?.notesHeadingId;
    expect(headingId).toBeDefined();

    // CONTROL, HALF TWO — GENUINELY OUTSIDE THE SECTION. `sectionIds` is the
    // same walk the cleanup gate uses to decide what is inside the meeting's
    // notes; if it claimed this block, the test below would pass for the
    // wrong reason.
    const section = sectionIds(outline, headingId as string);
    expect(section.blocks.size).toBeGreaterThan(0);
    expect(section.blocks.has(theirId)).toBe(false);

    // THE CLAIM ITSELF.
    expect(outline.some((e) => e.id === theirId && e.text === THEIR_LINE)).toBe(true);
    // And the doc records it as a person's: no author mark on it, while the
    // note-taker's own bullets carry one.
    expect(outline.find((e) => e.id === theirId)?.author).toBeUndefined();
    expect(outline.some((e) => e.kind === 'listItem' && e.author !== undefined)).toBe(true);
  }, 20_000);

  it('keeps that same bullet however many notes the note-taker writes after it', () => {
    // The window this replaces held eighty body blocks and let go of forty at
    // a time, so it bit at a hundred and twenty. Both sides of where it bit
    // are measured here, and a doc ten times longer after them.
    const short = docWithNotes(10);
    const pastTheOldWindow = docWithNotes(120);
    const muchLonger = docWithNotes(1_200);

    // CONTROL: a doc the old window never bit on. Visible then, visible now.
    expect(seesTheirLine(short)).toBe(true);
    // THE MEASUREMENT: nothing about the section changed — only the number of
    // the note-taker's own bullets after it — and the line is still there.
    expect(seesTheirLine(pastTheOldWindow)).toBe(true);
    expect(seesTheirLine(muchLonger)).toBe(true);
  });

  it('shows the tick every block of the doc, not a tail of it', () => {
    const long = docWithNotes(1_200);
    const whole = prose.readOutline(long);
    const tick = readNotesOutlineForTick(
      oneDocStore('d', { ydoc: long, meta: { type: 'markdown' as DocType } }),
      'd',
    );
    // Every id in the doc, in the doc's own order. A tail — however generous
    // — would be short of the front, and a reordering would break a prefix
    // cache even when nothing was missing.
    expect(tick.map((e) => e.id)).toEqual(whole.map((e) => e.id));
    expect(tick.some((e) => e.kind === 'heading' && e.text === 'Meeting notes')).toBe(true);
    expect(tick.some((e) => e.text === THEIR_LINE)).toBe(true);
  });
});

/** A doc with a person's bullet above a meeting's section, and `n` of the
 *  note-taker's own bullets under it. */
function docWithNotes(n: number): Y.Doc {
  const ydoc = new Y.Doc();
  const bullets = Array.from({ length: n }, (_, i) => `- Point ${i} from the floor.`).join('\n');
  prose.applyMarkdownToFragment(
    prose.getProseFragment(ydoc),
    `# Project doc\n\nStanding context that was here before the meeting.\n\n- ${THEIR_LINE}\n\n## Meeting notes\n\n${bullets}\n`,
  );
  return ydoc;
}

/** Whether the tick's view of `ydoc` carries the person's line. */
function seesTheirLine(ydoc: Y.Doc): boolean {
  const store = oneDocStore('d', { ydoc, meta: { type: 'markdown' as DocType } });
  return readNotesOutlineForTick(store, 'd').some((e) => e.text === THEIR_LINE);
}
