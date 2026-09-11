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
import { confineToSection, sectionIds } from '../src/notes-cleanup-scope.ts';
import { DOC, docStoreFrom } from './notes-cleanup-fixture.ts';

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
  // `b2` is unmarked, inside the section: a block a person wrote there, or
  // one of the note-taker's they have since edited. The document records
  // those two the same way, and that is the state criterion 2.3 protects.
  //
  // WHAT THIS FILE CAN AND CANNOT SEE. The gate decides which edits reach the
  // document, not which of them land as rewrites — that is `applyBlockEdits`,
  // reading each block's own mark. So a `replace_block` on `b2` coming back
  // KEPT is the whole of what the gate promises; that it then reaches a person
  // as a redline and leaves their words byte-identical is asserted on a real
  // document in `notes-cleanup-suggestions.test.ts`. What the gate does decide
  // by itself is the DELETE and the NEST, and those are the assertions below
  // that bite.
  const scope = {
    blocks: new Set(['h1', 'b1', 'b2']),
    headings: new Set(['h1']),
    owned: new Set(['h1', 'b1']),
    headingId: 'h1',
  };

  it("keeps a rewrite of a person's block, rather than dropping it", () => {
    const edit: prose.BlockEdit = { op: 'replace_block', blockId: 'b2', markdown: '- rewritten' };
    const { kept, refused } = confineToSection([edit], scope);
    expect(kept).toEqual([edit]);
    expect(refused).toBe(0);
    // The note-taker's own bullet takes the same route through the gate —
    // which is the point: one predicate admits both, and the document decides
    // what happens to each.
    expect(
      confineToSection([{ op: 'replace_block', blockId: 'b1', markdown: '- tightened' }], scope)
        .kept,
    ).toHaveLength(1);
  });

  it("makes no offer on a person's block somebody has commented on", () => {
    // BOTH gates, on one block. `b2` unmarked already closes the rewrite;
    // the comment is what closes the OFFER too, and a suggestion re-creates
    // no text, so this is a stricter rule than the anchor argument needs.
    const commented = { ...scope, commented: new Set(['b2']) };
    const { kept, refused } = confineToSection(
      [{ op: 'replace_block', blockId: 'b2', markdown: '- rewritten' }],
      commented,
    );
    expect(kept).toEqual([]);
    expect(refused).toBe(1);
    // Control: the identical block with no thread pointing into it IS kept,
    // so the refusal above is the comment and not the ownership.
    expect(
      confineToSection([{ op: 'replace_block', blockId: 'b2', markdown: '- rewritten' }], scope)
        .kept,
    ).toHaveLength(1);
  });

  it("drops a DELETE of a person's block — a strikethrough is not an improvement", () => {
    const { kept, refused } = confineToSection([{ op: 'delete_block', blockId: 'b2' }], scope);
    expect(kept).toEqual([]);
    expect(refused).toBe(1);
    // Control: the same op on the note-taker's own bullet IS kept, so the
    // refusal is whose the block is and not the verb.
    expect(confineToSection([{ op: 'delete_block', blockId: 'b1' }], scope).kept).toHaveLength(1);
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
   * A BLOCK THE DOCUMENT RECORDS NO AUTHOR FOR.
   *
   * The gate used to ask a second question about the rest of the document: if
   * no mark of the note-taker's survived anywhere, an unmarked block was
   * nobody's and the pass could bring it into line. That test fails in the
   * direction that matters. A person editing the LAST marked block on a doc
   * clears that mark themselves, and the doc then reads exactly like one
   * reparsed from disk — so the line they had just finished writing, and every
   * other line in the section, would flip from protected to rewritable in the
   * instant they typed. The question is gone: the pass rewrites what the doc
   * records as its own and offers on everything else.
   *
   * `owned` empty is that state — a reparse from disk, or the release the next
   * recording performs. Every case here pairs with a control that puts the
   * mark back, so a refusal is the missing mark and not the verb.
   */
  describe('a block the document records no author for', () => {
    const lost = { ...scope, owned: new Set<string>() };
    const mineToo = { ...scope, owned: new Set(['h1', 'b1', 'b2']) };
    const rewriteB2: prose.BlockEdit[] = [
      { op: 'replace_block', blockId: 'b2', markdown: '- brought into line' },
    ];

    it('is kept for a REPLACE, so an improvement still reaches the reader', () => {
      // The offer path is the whole reason the pass is not simply mute on such
      // a doc. What it becomes once it lands is the document's answer, proved
      // in `notes-cleanup-suggestions.test.ts`.
      expect(confineToSection(rewriteB2, lost).kept).toEqual(rewriteB2);
    });

    it('is NOT deleted — the old gate deleted it', () => {
      // THE ASSERTION THAT SEPARATES THE TWO READINGS at this level. A delete
      // is admitted only for a block the pass owns, and here it owns nothing.
      const del: prose.BlockEdit[] = [{ op: 'delete_block', blockId: 'b2' }];
      expect(confineToSection(del, lost).kept).toEqual([]);
      expect(confineToSection(del, lost).refused).toBe(1);
      expect(confineToSection(del, mineToo).kept).toEqual(del);
    });

    it('is not moved under another bullet either', () => {
      const nest: prose.BlockEdit[] = [{ op: 'nest_blocks', leadBlockId: 'b1', blockIds: ['b2'] }];
      expect(confineToSection(nest, lost).kept).toEqual([]);
      expect(confineToSection(nest, mineToo).kept).toEqual(nest);
    });

    it('is out of reach BOTH ways once a comment points into it', () => {
      // Not rewritten, and not even offered on: the pass adds beside a bullet
      // somebody is already discussing.
      const commented = { ...lost, commented: new Set(['b2']) };
      expect(confineToSection(rewriteB2, commented).kept).toEqual([]);
      // And nesting a commented block is still allowed where the pass owns
      // it, because a move re-creates no text and the anchor rides along.
      expect(
        confineToSection([{ op: 'nest_blocks', leadBlockId: 'b2', blockIds: ['b1'] }], {
          ...mineToo,
          commented: new Set(['b2']),
        }).kept,
      ).toHaveLength(1);
    });

    it('does not make the section heading fair game', () => {
      expect(confineToSection([{ op: 'delete_block', blockId: 'h1' }], lost).kept).toEqual([]);
      // Nor with the mark back on: the heading is refused for being the
      // section's address, which ownership never had a say in.
      expect(confineToSection([{ op: 'delete_block', blockId: 'h1' }], mineToo).kept).toEqual([]);
    });

    it('does not open the rest of the document either', () => {
      expect(confineToSection([{ op: 'delete_block', blockId: 'elsewhere' }], lost).kept).toEqual(
        [],
      );
    });

    it('can still have a new bullet added beside it', () => {
      // The pass is not reduced to silence on such a doc: an insert names a
      // heading and no owner, and it always could.
      expect(
        confineToSection([{ op: 'insert_under_heading', headingId: 'h1', markdown: '- new' }], lost)
          .kept,
      ).toHaveLength(1);
    });
  });
});
