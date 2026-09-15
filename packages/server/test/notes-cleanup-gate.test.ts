/**
 * A refused edit changes nothing — the invariant the gate/dedupe order holds.
 *
 * WHAT WENT WRONG, AND WHY A COUNT COULD NOT SAY SO. The dedupe reads a note
 * the section already carries under a different topic as the note-taker
 * MOVING its own bullet, so it emits a `delete_block` on the earlier copy
 * beside the insert that replaces it. Handed the model's answer before the
 * gate saw it, it did that for an insert the gate was going to refuse: the
 * gate then refused the insert, kept the delete — a perfectly ordinary delete
 * of the pass's own uncommented bullet — and the section's only copy of the
 * note was gone. The run logged "1 refused, 1 blocks touched", which reads
 * like restraint.
 *
 * THE REFUSAL THAT DRIVES THE CASE CHANGED, AND THE INVARIANT DID NOT. It
 * used to be "the destination heading is outside the meeting's section";
 * since the gate became a boundary on authorship rather than on location
 * (`boundByAuthorship`), that is no longer a refusal at all. An insert naming
 * a block that is not a heading still is, and it reaches the dedupe as a
 * destination exactly the same way — which is the point: the invariant is
 * about the ORDER of the two passes, not about which rule refused.
 *
 * Both cases below drive the whole pass, because the bug lives in the
 * composition and not in either half: `boundByAuthorship` and
 * `dedupeNotesEdits` each did exactly what they are for.
 *
 * All notes and all speech are invented and every name is fictional. The repo
 * is public.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { runNotesCleanupPass } from '../src/notes-cleanup-pass.ts';
import {
  DOC,
  MEETING,
  depsFor,
  docStoreFrom,
  dropFreshDirs,
  freshDir,
  idOf,
  stubComposer,
  writeTranscript,
} from './notes-cleanup-fixture.ts';

afterEach(dropFreshDirs);

const NOTE = 'The harbour run moves to the half hour from April';

/** A section holding one note, and a heading after it that the section does
 *  not reach — the doc's own later business. */
const NOTES = [
  '# Riverbend ferry review',
  '',
  '## Meeting notes',
  '',
  '### Ferry timetable',
  '',
  `- ${NOTE}`,
  '',
  '## Other business',
  '',
  '- A line that lives outside the meeting section',
].join('\n');

const copies = (markdown: string): number => markdown.split(NOTE).length - 1;

describe('an edit the gate will refuse', () => {
  it('takes no note with it when it is refused', async () => {
    const { store, markdownNow } = docStoreFrom(NOTES, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: `We said ${NOTE.toLowerCase()}.` }]);
    // A destination the gate will refuse: a BULLET, not a heading.
    const outside = idOf(store, 'A line that lives outside');
    const before = markdownNow();
    expect(copies(before)).toBe(1);
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([{ op: 'insert_under_heading', headingId: outside, markdown: `- ${NOTE}` }]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    // The edit is refused...
    expect(result.ok).toBe(true);
    expect(result.refused).toBe(1);
    // ...and refusing it leaves the document exactly as it was. The note the
    // dedupe would have "moved" is still under its own topic.
    expect(result.touched).toBe(0);
    expect(copies(markdownNow())).toBe(1);
    expect(markdownNow()).toBe(before);
  });

  it('still lets a note the section already carries move under its topic', async () => {
    // The control on the fix: gating first must not cost the dedupe the move
    // it exists to make. Same shape, but the destination is a topic heading
    // INSIDE the section, so the move is the pass's to make and the note ends
    // up once, under the topic the model filed it under.
    const withTopic = NOTES.replace(
      '## Other business',
      ['### Crew rota', '', '- Kestrel Lane keeps the winter crew', '', '## Other business'].join(
        '\n',
      ),
    );
    const { store, markdownNow } = docStoreFrom(withTopic, ['Meeting notes']);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: `We said ${NOTE.toLowerCase()}.` }]);
    const inside = idOf(store, 'Crew rota');
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([{ op: 'insert_under_heading', headingId: inside, markdown: `- ${NOTE}` }]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.ok).toBe(true);
    expect(result.refused).toBe(0);
    const after = markdownNow();
    expect(copies(after)).toBe(1);
    expect(after.indexOf(NOTE)).toBeGreaterThan(after.indexOf('### Crew rota'));
  });
});
