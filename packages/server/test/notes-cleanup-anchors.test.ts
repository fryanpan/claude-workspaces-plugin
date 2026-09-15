/**
 * What a cleanup pass does to a bullet somebody has left a comment on.
 *
 * A `replace_block` swaps the block's text for a new one, so every relative
 * position inside it stops resolving and the thread anchored there has to be
 * recovered by the snippet sweep — on words that may no longer exist. During
 * a meeting that trade is worth making; at the end of one, when the notes
 * have been read and discussed, it is not. So these cases put a real thread
 * on a real bullet and ask what the anchor points at afterwards, rather than
 * asking the pass what it thinks it did.
 *
 * All notes and all speech here are invented and every name is fictional.
 * The repo is public.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { runNotesCleanupPass } from '../src/notes-cleanup-pass.ts';
import { boundByAuthorship, commentedBlockIds } from '../src/notes-cleanup-scope.ts';
import {
  DOC,
  MEETING,
  NOTES,
  depsFor,
  docStoreFrom,
  dropFreshDirs,
  freshDir,
  idOf,
  stubComposer,
  writeTranscript,
} from './notes-cleanup-fixture.ts';

afterEach(dropFreshDirs);

describe('a bullet somebody has commented on', () => {
  /** Anchor a thread over `needle` exactly as the editor does. */
  const commentOn = (ydoc: Y.Doc, needle: string): Y.Map<unknown> => {
    const walk = prose.walkProse(prose.getProseFragment(ydoc));
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
    return thread;
  };

  /** What the thread's own anchor resolves to right now. */
  const anchoredText = (ydoc: Y.Doc, thread: Y.Map<unknown>): string => {
    const anchor = thread.get('anchor') as { startRel: Uint8Array; endRel: Uint8Array };
    const start = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(anchor.startRel),
      ydoc,
    );
    const end = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(anchor.endRel),
      ydoc,
    );
    return String(start?.type).slice(start?.index, end?.index);
  };

  it('survives the pass MOVING it, once the snippet sweep has run', async () => {
    // WHAT A MOVE REALLY DOES TO AN ANCHOR, measured rather than asserted.
    // Yjs has no move primitive, so `nest_blocks` clones the element and
    // deletes the original (`prose-nest.ts`) — the relative position stops
    // resolving the instant it lands, and it is `autoReanchorDoc` that puts
    // the thread back on its own words, by a snippet that is still exactly
    // the text it was. The server runs that sweep on a debounce after every
    // prose transaction (`live-doc-fanout.ts`); this fixture has no fanout,
    // so it runs it by hand and asserts both halves.
    //
    // It is driven on a PERSON'S bullet on purpose. The gate has always let a
    // nest reach a commented block; since 2026-09-15 it lets one reach a
    // block the pass does not own, so the case that needs proving is both at
    // once.
    const { store, ydoc } = docStoreFrom(NOTES, ['Meeting notes'], ['Kestrel Lane']);
    const needle = 'Kestrel Lane keeps the winter crew';
    const thread = commentOn(ydoc, needle);
    expect(anchoredText(ydoc, thread)).toBe(needle);
    const dataDir = freshDir();
    writeTranscript(dataDir, [{ turn: 0, text: 'Kestrel Lane keeps the winter crew.' }]);
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          {
            op: 'nest_blocks',
            leadBlockId: idOf(store, 'harbour run'),
            blockIds: [idOf(store, 'Kestrel Lane')],
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );
    expect(result.refused).toBe(0);
    expect(result.applied).toBe(1);
    // The clone-and-delete really does break the position — this is the half
    // the comment above would be a guess without.
    expect(anchoredText(ydoc, thread)).not.toBe(needle);
    const swept = prose.autoReanchorDoc(ydoc);
    expect(swept.reanchored).toBe(1);
    expect(swept.stillOrphan).toBe(0);
    // And it points at their own words, which is the whole claim.
    expect(anchoredText(ydoc, thread)).toBe(needle);
  });

  it('is named by commentedBlockIds', () => {
    const { store, ydoc } = docStoreFrom(NOTES, ['Meeting notes']);
    commentOn(ydoc, 'harbour run moves');
    expect([...commentedBlockIds(ydoc)]).toEqual([idOf(store, 'harbour run')]);
  });

  it('reports nothing for a doc where nobody has commented', () => {
    const { ydoc } = docStoreFrom(NOTES, ['Meeting notes']);
    expect(commentedBlockIds(ydoc).size).toBe(0);
  });

  it('is out of reach of a rewrite, while a new bullet beside it is not', () => {
    const scope = {
      blocks: new Set(['h1', 'b1', 'b2']),
      headings: new Set(['h1']),
      listItems: new Set(['b1', 'b2']),
      owned: new Set(['b1', 'b2']),
      headingId: 'h1',
      commented: new Set(['b1']),
    };
    const { kept, refused } = boundByAuthorship(
      [
        { op: 'replace_block', blockId: 'b1', markdown: '- rewritten' },
        { op: 'delete_block', blockId: 'b1' },
        { op: 'replace_block', blockId: 'b2', markdown: '- also rewritten' },
        { op: 'insert_under_heading', headingId: 'h1', markdown: '- a new point' },
      ],
      scope,
    );
    expect(kept.map((e) => e.op)).toEqual(['replace_block', 'insert_under_heading']);
    expect(refused).toBe(2);
    // Nesting keeps each block's own text, so it rides along with the anchor.
    expect(
      boundByAuthorship([{ op: 'nest_blocks', leadBlockId: 'b1', blockIds: ['b2'] }], scope).kept,
    ).toHaveLength(1);
  });

  it('keeps its thread pointing at its own words through a whole pass', async () => {
    const { store, ydoc, markdownNow } = docStoreFrom(NOTES, ['Meeting notes']);
    const needle = 'The harbour run moves to the half hour from April';
    const thread = commentOn(ydoc, needle);
    expect(anchoredText(ydoc, thread)).toBe(needle);

    const dataDir = freshDir();
    writeTranscript(dataDir, [
      { turn: 0, text: 'The harbour run moves to the half hour from April.' },
      { turn: 1, text: 'The slipway closes for maintenance in October.' },
    ]);
    const result = await runNotesCleanupPass(
      depsFor(
        store,
        stubComposer([
          // The tidy-up the model would like to make, over the commented line.
          {
            op: 'replace_block',
            blockId: idOf(store, 'harbour run'),
            markdown: '- Harbour run: half-hourly from April',
          },
          // And a point it is right to add, in the same batch.
          {
            op: 'insert_under_heading',
            headingId: idOf(store, 'Ferry timetable'),
            markdown: '- The slipway closes for maintenance in October',
          },
        ]),
        dataDir,
        idOf(store, 'Meeting notes'),
      ),
      { docId: DOC, meetingId: MEETING },
    );

    expect(result.ok).toBe(true);
    expect(result.refused).toBe(1);
    const after = markdownNow();
    // The commented bullet reads exactly as it did …
    expect(after).toContain(needle);
    expect(after).not.toContain('half-hourly from April');
    // … its thread still points at its own words, with no re-anchor sweep
    // needed to recover it …
    expect(anchoredText(ydoc, thread)).toBe(needle);
    expect(prose.autoReanchorDoc(ydoc)).toMatchObject({ reanchored: 0, stillOrphan: 0 });
    // … and the pass still did the part of its job that was safe.
    expect(after).toContain('The slipway closes for maintenance in October');
  });
});
