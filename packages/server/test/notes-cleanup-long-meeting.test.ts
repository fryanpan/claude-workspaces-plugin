/**
 * A tidy-up over a meeting whose notes run PAST the outline window.
 *
 * WHAT THIS IS ABOUT. The pass shows the model `CLEANUP_OUTLINE_BLOCKS` body
 * blocks, counted from the end of the doc. Past that, the section's own
 * earliest bullets are not in the prompt at all — and the directive asks the
 * model to "ADD what is missing: an idea this meeting carried that no note
 * mentions". A model doing exactly as it is told therefore writes a note the
 * document already carries, and `confineToSection` cannot refuse it: the edit
 * names no block, so there is no block outside the section, no comment and no
 * ownership to weigh. It is an insert under a heading the pass owns.
 *
 * SO THE COMPOSER HERE IS NOT A CANNED DUPLICATE. It answers the way the
 * prompt asks: it looks at the outline it was HANDED, and writes up the one
 * idea in the transcript that no entry there mentions. Over a short section it
 * proposes nothing, because it can see the note; over a long one it proposes
 * the duplicate, because it cannot. The two cases share every line of setup
 * but the number of bullets, which is what makes the long case a reproduction
 * rather than an assertion about a stub.
 *
 * AND THE WINDOW IS MEASURED, not assumed. Both cases assert the body-block
 * count of the outline the composer was given against the doc's own, so a
 * fixture that quietly stopped exceeding the cap fails here instead of
 * passing as a clean run.
 *
 * All notes and all speech are invented and every name is fictional. The repo
 * is public.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { prose } from '@claude-workspaces/core';
import type { NotesComposeInput, NotesComposer } from '../src/meeting-notes.ts';
import { CLEANUP_OUTLINE_BLOCKS, runNotesCleanupPass } from '../src/notes-cleanup-pass.ts';
import {
  DOC,
  MEETING,
  depsFor,
  docStoreFrom,
  dropFreshDirs,
  freshDir,
  idOf,
  writeTranscript,
} from './notes-cleanup-fixture.ts';

afterEach(dropFreshDirs);

/** The note written at the very TOP of the section — the first thing this
 *  meeting recorded, and the first thing the window drops. */
const EARLY_NOTE = 'The harbour run moves to the half hour from April';

/** Long enough that the section alone clears the cap with room to spare. */
const PAST_THE_WINDOW = CLEANUP_OUTLINE_BLOCKS + 120;

/** A doc whose notes section holds `bullets` bullets, the first of them the
 *  note this meeting opened with. */
function notesOf(bullets: number): string {
  const lines = [
    '# Riverbend ferry review',
    '',
    'My own line about the slipway, which nobody may rewrite.',
    '',
    '## Meeting notes',
    '',
    '### Ferry timetable',
    '',
    `- ${EARLY_NOTE}`,
  ];
  for (let i = 1; i < bullets; i++) lines.push(`- Filler point ${i} from the Saltmarsh run`);
  return lines.join('\n');
}

/**
 * A composer that follows the directive: whatever idea the transcript carries
 * and the outline it was handed does not, it writes up under the topic
 * heading. It proposes nothing when the note is already in front of it.
 */
function directiveFollowingComposer(
  headingId: string,
): NotesComposer & { seen: NotesComposeInput[] } {
  const seen: NotesComposeInput[] = [];
  return {
    name: 'directive-following',
    seen,
    compose(input) {
      seen.push(input);
      const covered = input.outline.some((e) => e.text.includes(EARLY_NOTE));
      return Promise.resolve(
        covered
          ? []
          : [{ op: 'insert_under_heading' as const, headingId, markdown: `- ${EARLY_NOTE}` }],
      );
    },
  };
}

const bodyBlocks = (outline: readonly prose.OutlineEntry[]): number =>
  outline.filter((e) => e.kind !== 'heading').length;

/** How many times the note stands in the document. */
const copiesOf = (markdown: string): number => markdown.split(EARLY_NOTE).length - 1;

async function runOver(bullets: number) {
  const { store, markdownNow } = docStoreFrom(notesOf(bullets), ['Meeting notes']);
  const dataDir = freshDir();
  writeTranscript(dataDir, [
    { turn: 0, text: `Right, from April ${EARLY_NOTE.toLowerCase()}.` },
    { turn: 1, text: 'And the Kestrel Lane crew stays as it is over the winter.' },
  ]);
  const composer = directiveFollowingComposer(idOf(store, 'Ferry timetable'));
  const before = copiesOf(markdownNow());
  const result = await runNotesCleanupPass(
    depsFor(store, composer, dataDir, idOf(store, 'Meeting notes')),
    { docId: DOC, meetingId: MEETING },
  );
  const doc = store.get(DOC);
  if (!doc) throw new Error('the fixture lost its doc');
  const shown = composer.seen[0]?.outline ?? [];
  return {
    result,
    before,
    after: copiesOf(markdownNow()),
    shownBody: bodyBlocks(shown),
    docBody: bodyBlocks(prose.readOutline(doc.ydoc)),
    sawTheNote: shown.some((e) => e.text.includes(EARLY_NOTE)),
  };
}

describe('a meeting whose notes run past the outline window', () => {
  it('leaves the section carrying its opening note exactly once', async () => {
    const run = await runOver(PAST_THE_WINDOW);
    // THE CONTROL: the window was genuinely exceeded, and the note this case
    // is about is one of the entries it dropped. Without these two the run
    // below proves nothing at all.
    expect(run.docBody).toBeGreaterThan(CLEANUP_OUTLINE_BLOCKS);
    expect(run.shownBody).toBe(CLEANUP_OUTLINE_BLOCKS);
    expect(run.sawTheNote).toBe(false);
    // So the model proposes the note it cannot see, and the document still
    // ends up carrying it once.
    expect(run.result.ok).toBe(true);
    expect(run.result.proposed).toBe(1);
    expect(run.result.alreadyWritten).toBe(1);
    expect(run.before).toBe(1);
    expect(run.after).toBe(1);
    expect(run.result.line).toContain('1 notes the section already carried');
  });

  it('proposes nothing at all when the same notes fit inside the window', async () => {
    const run = await runOver(12);
    // The positive control on the composer: handed an outline that carries
    // the note, it asks for nothing — so the case above is about the window
    // and not about a stub that always duplicates.
    expect(run.docBody).toBeLessThan(CLEANUP_OUTLINE_BLOCKS);
    expect(run.sawTheNote).toBe(true);
    expect(run.result.proposed).toBe(0);
    expect(run.result.alreadyWritten).toBe(0);
    expect(run.before).toBe(1);
    expect(run.after).toBe(1);
  });
});
