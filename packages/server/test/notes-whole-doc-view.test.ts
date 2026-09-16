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
 * `readNotesOutlineForTick` reads the WHOLE doc. What is sliced is the
 * RECENCY WINDOW (`NOTES_OUTLINE_RECENT_BLOCKS`), which counts from the end
 * of the document and knows nothing about sections or about who wrote what.
 * The second and third tests measure that instead, and they are what makes
 * the first test's pass mean something: the same person's block, in the same
 * place, is visible while the doc is short and gone once the note-taker's own
 * bullets have pushed it past the window.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { type DocType, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { readNotesOutlineForTick } from '../src/meeting-notes-doc.ts';
import { sectionIds } from '../src/notes-cleanup-scope.ts';
import { NOTES_OUTLINE_DROP_STEP, NOTES_OUTLINE_RECENT_BLOCKS } from '../src/notes-prompt-build.ts';
import { asPerson, oneDocStore } from './notes-doc-helpers.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

/** What a person typed, on a line nothing else in these fixtures says. */
const THEIR_LINE = 'My own note: the harbour run needs its own budget line.';

/** Put a bullet in the doc as a person would, immediately ABOVE the meeting's
 *  section — the placement the claim is about. Returns its block id. */
function typeAboveTheSection(ydoc: Y.Doc, text: string): string {
  let id = '';
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
  id = entry.id;
  return id;
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

  it('drops that same bullet once the note-taker’s own notes push it past the recency window', () => {
    // The window counts BODY blocks from the end of the doc and drops in
    // whole steps, so it bites at `recent + step` rather than at `recent`.
    const pastTheWindow = NOTES_OUTLINE_RECENT_BLOCKS + NOTES_OUTLINE_DROP_STEP;
    const short = docWithNotes(10);
    const long = docWithNotes(pastTheWindow);

    // CONTROL: the same block, in the same place, in a doc the window does
    // not bite on. Visible.
    expect(seesTheirLine(short)).toBe(true);
    // THE MEASUREMENT: nothing about the section changed — only the number of
    // the note-taker's own bullets after it.
    expect(seesTheirLine(long)).toBe(false);
  });

  it('drops it however far from the meeting’s section it sits — the window is not a section walk', () => {
    const pastTheWindow = NOTES_OUTLINE_RECENT_BLOCKS + NOTES_OUTLINE_DROP_STEP;
    const long = docWithNotes(pastTheWindow);
    const outline = prose.readOutline(long);
    const heading = outline.find((e) => e.kind === 'heading' && e.text === 'Meeting notes');
    expect(heading).toBeDefined();
    // Every block the window dropped is a BODY block, and the first to go is
    // the one nearest the top of the doc — the person's. Headings survive
    // whatever their section, which is what says the window is a count and
    // not a walk.
    const tick = readNotesOutlineForTick(
      oneDocStore('d', { ydoc: long, meta: { type: 'markdown' as DocType } }),
      'd',
    );
    expect(tick.some((e) => e.kind === 'heading' && e.text === 'Meeting notes')).toBe(true);
    expect(tick.some((e) => e.text === THEIR_LINE)).toBe(false);
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
