/**
 * What a cleanup pass may address: the section it is confined to, the blocks
 * a comment points into, and whose material each block is.
 *
 * Driven directly, with no composer and no transcript, because none of these
 * questions is about a model. They are about what happens to an edit list
 * once it comes back — an edit aimed at a person's paragraph, at another
 * meeting's notes, or at the end of the document.
 *
 * All notes and all names here are invented. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { prose } from '@claude-workspaces/core';
import {
  claimForCleanup,
  confineToSection,
  releaseClaims,
  sectionIds,
} from '../src/notes-cleanup-scope.ts';
import { NOTES_AUTHOR_ID, type NotesDocStore } from '../src/notes-doc-access.ts';
import { DOC, NOTES, docStoreFrom, idOf } from './notes-cleanup-fixture.ts';

describe('the section a cleanup may touch', () => {
  it('runs from the meeting heading to the next section, and no further', () => {
    const { store } = docStoreFrom(
      ['## Meeting notes', '### Topic', '- one', '## Other section', '- outside'].join('\n'),
      ['Meeting notes'],
    );
    const outline = store.readOutline(DOC)?.blocks ?? [];
    const heading = outline.find((b) => b.text === 'Meeting notes');
    const ids = sectionIds(outline, heading?.id ?? '');
    expect([...ids.blocks].map((id) => outline.find((b) => b.id === id)?.text)).toEqual([
      'Meeting notes',
      'Topic',
      'one',
    ]);
    expect(ids.headings.size).toBe(2);
  });
});

describe('what the gate refuses', () => {
  // `h1` is OWNED as well as being the section heading — that is the real
  // state a meeting leaves behind, and the heading-delete case below is
  // vacuous without it: an unowned heading is refused by the ownership
  // check, so the guard it means to prove is never reached.
  //
  // `marksLive` is true and `b2` is unmarked: a doc still carrying the
  // note-taker's marks, with one block inside its section that a person wrote
  // or has since edited. That is the state criterion 2.3 protects.
  const scope = {
    blocks: new Set(['h1', 'b1', 'b2']),
    headings: new Set(['h1']),
    owned: new Set(['h1', 'b1']),
    attributed: new Set(['h1', 'b1']),
    marksLive: true,
    headingId: 'h1',
  };

  it("keeps a rewrite of a person's block as an OFFER, never as a rewrite", () => {
    const edit: prose.BlockEdit = { op: 'replace_block', blockId: 'b2', markdown: '- rewritten' };
    const { kept, proposeOnly, refused } = confineToSection([edit], scope);
    // Kept, so it reaches the write path — and named in `proposeOnly`, which
    // is what stops the pass claiming the block and turning the redline
    // `applyBlockEdits` would file into a rewrite of their line.
    expect(kept).toEqual([edit]);
    expect([...proposeOnly]).toEqual(['b2']);
    expect(refused).toBe(0);
    // The note-taker's own bullet is the control: same section, same op, and
    // it comes back with nothing to hold back.
    const own = confineToSection(
      [{ op: 'replace_block', blockId: 'b1', markdown: '- tightened' }],
      scope,
    );
    expect(own.kept).toHaveLength(1);
    expect([...own.proposeOnly]).toEqual([]);
  });

  it("makes no offer on a person's block somebody has commented on", () => {
    // BOTH gates, on one block. Marks live and `b2` unmarked makes it a
    // person's, so the rewrite path is already closed; the comment is what
    // closes the OFFER path too. Without a case where both hold at once, the
    // commented check on an offer is unreachable and untested — the
    // marks-gone case below cannot reach it, because there `b2` is the
    // pass's own to rewrite.
    const commented = { ...scope, commented: new Set(['b2']) };
    const { kept, proposeOnly, refused } = confineToSection(
      [{ op: 'replace_block', blockId: 'b2', markdown: '- rewritten' }],
      commented,
    );
    expect(kept).toEqual([]);
    expect([...proposeOnly]).toEqual([]);
    expect(refused).toBe(1);
    // Control: the identical block with no thread pointing into it IS offered
    // on, so the refusal above is the comment and not the ownership.
    expect([
      ...confineToSection([{ op: 'replace_block', blockId: 'b2', markdown: '- rewritten' }], scope)
        .proposeOnly,
    ]).toEqual(['b2']);
  });

  it("drops a DELETE of a person's block — a strikethrough is not an improvement", () => {
    const { kept, proposeOnly, refused } = confineToSection(
      [{ op: 'delete_block', blockId: 'b2' }],
      scope,
    );
    expect(kept).toEqual([]);
    expect([...proposeOnly]).toEqual([]);
    expect(refused).toBe(1);
  });

  it('drops an edit aimed outside the section', () => {
    const { kept } = confineToSection([{ op: 'delete_block', blockId: 'elsewhere' }], scope);
    expect(kept).toEqual([]);
  });

  it('refuses insert_at_end, which is how a second section gets opened', () => {
    const { kept } = confineToSection(
      [{ op: 'insert_at_end', markdown: '## Meeting notes' }],
      scope,
    );
    expect(kept).toEqual([]);
  });

  it('refuses a delete of the section heading itself — it orphans every note under it', () => {
    const { kept } = confineToSection([{ op: 'delete_block', blockId: 'h1' }], scope);
    expect(kept).toEqual([]);
    // And a rewrite of it, for the same reason: the heading is the address
    // the meeting's own notes are found at.
    expect(
      confineToSection([{ op: 'replace_block', blockId: 'h1', markdown: '## Notes' }], scope).kept,
    ).toEqual([]);
  });

  it("keeps a rewrite of the note-taker's own bullet, and an insert under its heading", () => {
    const { kept, refused } = confineToSection(
      [
        { op: 'replace_block', blockId: 'b1', markdown: '- tightened' },
        { op: 'insert_under_heading', headingId: 'h1', markdown: '- added' },
      ],
      scope,
    );
    expect(kept).toHaveLength(2);
    expect(refused).toBe(0);
  });

  it("refuses a nest whose members are not all the note-taker's", () => {
    const { kept } = confineToSection(
      [{ op: 'nest_blocks', leadBlockId: 'b1', blockIds: ['b2'] }],
      scope,
    );
    expect(kept).toEqual([]);
  });

  /**
   * THE ONE THING THE LOOSENED GATE CHANGED, at the level it was changed.
   *
   * The same unmarked block, the same edit, the same section — and the only
   * difference is whether the doc still carries a mark of the note-taker's
   * anywhere. `b2` is what an unmarked block looks like in both states, and
   * the point of `claimable` is that they are not the same state.
   */
  describe('an unmarked block, in the two states a doc can be in', () => {
    const rewriteB2: prose.BlockEdit[] = [
      { op: 'replace_block', blockId: 'b2', markdown: '- brought into line' },
    ];

    it("offers rather than rewrites while a mark of the note-taker's survives", () => {
      const { kept, proposeOnly } = confineToSection(rewriteB2, { ...scope, marksLive: true });
      expect(kept).toEqual(rewriteB2);
      expect([...proposeOnly]).toEqual(['b2']);
    });

    it('admits it once every mark is gone — nothing there is recorded as anyone’s', () => {
      // A reparse from disk, or the next recording's release: no owner is
      // provable, so nothing in the doc is attributable to a person either.
      const lost = {
        ...scope,
        owned: new Set<string>(),
        attributed: new Set<string>(),
        marksLive: false,
      };
      const { kept, proposeOnly } = confineToSection(rewriteB2, lost);
      expect(kept).toEqual(rewriteB2);
      // Nothing held back: this one is a rewrite, which is the whole point of
      // the marks-gone mode.
      expect([...proposeOnly]).toEqual([]);
    });

    it("still refuses to REWRITE another agent's block on a doc whose marks are gone", () => {
      // A release names ONE author, so a second agent's mark outlives the
      // note-taker's. A block it is maintaining is not this pass's to rewrite
      // — it is offered to whoever holds it, on the same terms as a person's.
      const lost = {
        ...scope,
        owned: new Set<string>(),
        attributed: new Set(['b2']),
        marksLive: false,
      };
      const { kept, proposeOnly } = confineToSection(rewriteB2, lost);
      expect(kept).toEqual(rewriteB2);
      expect([...proposeOnly]).toEqual(['b2']);
    });

    it('still refuses it when a comment points into it, in either state', () => {
      const commented = new Set(['b2']);
      const lost = {
        ...scope,
        owned: new Set<string>(),
        attributed: new Set<string>(),
        marksLive: false,
        commented,
      };
      // Out of reach BOTH ways: not rewritten, and not even offered on. The
      // pass adds beside a bullet somebody is already discussing.
      const { kept, proposeOnly } = confineToSection(rewriteB2, lost);
      expect(kept).toEqual([]);
      expect([...proposeOnly]).toEqual([]);
      // And nesting one is still allowed, because it re-creates no text.
      expect(
        confineToSection([{ op: 'nest_blocks', leadBlockId: 'b2', blockIds: ['b1'] }], lost).kept,
      ).toHaveLength(1);
    });

    it('still refuses the section heading itself once the marks are gone', () => {
      const lost = {
        ...scope,
        owned: new Set<string>(),
        attributed: new Set<string>(),
        marksLive: false,
      };
      expect(confineToSection([{ op: 'delete_block', blockId: 'h1' }], lost).kept).toEqual([]);
    });

    it('still refuses anything outside the section once the marks are gone', () => {
      const lost = {
        ...scope,
        owned: new Set<string>(),
        attributed: new Set<string>(),
        marksLive: false,
      };
      expect(confineToSection([{ op: 'delete_block', blockId: 'elsewhere' }], lost).kept).toEqual(
        [],
      );
    });
  });
});

describe('claiming what an admitted edit names', () => {
  const rewriteOne = (store: NotesDocStore, needle: string): prose.BlockEdit[] => [
    { op: 'replace_block', blockId: idOf(store, needle), markdown: '- tightened' },
  ];

  it('claims only what an admitted edit names, and nothing while the marks live', () => {
    // Marks gone: the one block the edit names is claimed, and only it.
    const lost = docStoreFrom(NOTES, []);
    expect(claimForCleanup(lost.ydoc, rewriteOne(lost.store, 'harbour run'))).toEqual([
      idOf(lost.store, 'harbour run'),
    ]);
    expect(prose.readOutline(lost.ydoc).filter((b) => b.author !== undefined)).toHaveLength(1);
    // Marks live: the gate only ever admits blocks already marked ours, so
    // there is nothing left to claim and the doc is not written to.
    const live = docStoreFrom(NOTES, ['Meeting notes']);
    expect(claimForCleanup(live.ydoc, rewriteOne(live.store, 'harbour run'))).toEqual([]);
  });

  it('claims nothing on a block the gate admitted only as an offer', () => {
    // THE HALF THAT KEEPS A SUGGESTION A SUGGESTION. Same doc, same edit,
    // same block — the only difference is whether the block's id is in
    // `proposeOnly`, and a claim here would hand the block to the write path
    // as the pass's own and rewrite somebody's line.
    const { ydoc, store } = docStoreFrom(NOTES, ['Meeting notes'], ['Kestrel Lane']);
    const edits = rewriteOne(store, 'Kestrel Lane');
    const theirs = idOf(store, 'Kestrel Lane');
    expect(claimForCleanup(ydoc, edits, new Set([theirs]))).toEqual([]);
    expect(prose.readOutline(ydoc).find((b) => b.id === theirs)?.author).toBeUndefined();
    // Positive control: without the set, this very block IS claimed — so the
    // zero above is the exclusion working, not an unclaimable block.
    expect(claimForCleanup(ydoc, edits)).toEqual([theirs]);
    expect(prose.readOutline(ydoc).find((b) => b.id === theirs)?.author).toBe(NOTES_AUTHOR_ID);
  });

  it('hands a claim back, and hands back only its own', () => {
    // A claim made for an edit that then failed has to be undone, or the next
    // pass reads it as permission to rewrite a line this one never changed.
    const { ydoc, store } = docStoreFrom(NOTES, []);
    const mine = idOf(store, 'harbour run');
    expect(claimForCleanup(ydoc, rewriteOne(store, 'harbour run'))).toEqual([mine]);
    expect(releaseClaims(ydoc, [mine])).toBe(1);
    expect(prose.readOutline(ydoc).find((b) => b.id === mine)?.author).toBeUndefined();

    // Somebody else's mark is not this pass's to remove — releasing an id it
    // never claimed changes nothing, and says so.
    const held = idOf(store, 'Kestrel Lane');
    const el = prose.findBlockById(prose.getProseFragment(ydoc), held);
    if (el) prose.setBlockAuthor(el, 'some-other-agent');
    expect(releaseClaims(ydoc, [held])).toBe(0);
    expect(prose.readOutline(ydoc).find((b) => b.id === held)?.author).toBe('some-other-agent');
  });
});
