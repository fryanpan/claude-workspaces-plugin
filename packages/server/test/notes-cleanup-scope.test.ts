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
import { claimForCleanup, confineToSection, sectionIds } from '../src/notes-cleanup-scope.ts';
import { type NotesDocStore } from '../src/notes-doc-access.ts';
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

  it("drops an edit aimed at a person's block while the doc's marks are live", () => {
    const { kept, refused } = confineToSection(
      [{ op: 'replace_block', blockId: 'b2', markdown: '- rewritten' }],
      scope,
    );
    expect(kept).toEqual([]);
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

    it("refuses it while a mark of the note-taker's survives — it is a person's", () => {
      expect(confineToSection(rewriteB2, { ...scope, marksLive: true }).kept).toEqual([]);
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
      expect(confineToSection(rewriteB2, lost).kept).toEqual(rewriteB2);
    });

    it("still refuses another agent's block on a doc whose marks are gone", () => {
      // A release names ONE author, so a second agent's mark outlives the
      // note-taker's. A block it is maintaining is not this pass's to rewrite.
      const lost = {
        ...scope,
        owned: new Set<string>(),
        attributed: new Set(['b2']),
        marksLive: false,
      };
      expect(confineToSection(rewriteB2, lost).kept).toEqual([]);
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
      expect(confineToSection(rewriteB2, lost).kept).toEqual([]);
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
  it('claims only what an admitted edit names, and nothing while the marks live', () => {
    const rewriteOne = (store: NotesDocStore): prose.BlockEdit[] => [
      { op: 'replace_block', blockId: idOf(store, 'harbour run'), markdown: '- tightened' },
    ];
    // Marks gone: the one block the edit names is claimed, and only it.
    const lost = docStoreFrom(NOTES, []);
    expect(claimForCleanup(lost.ydoc, rewriteOne(lost.store))).toBe(1);
    expect(prose.readOutline(lost.ydoc).filter((b) => b.author !== undefined)).toHaveLength(1);
    // Marks live: the gate only ever admits blocks already marked ours, so
    // there is nothing left to claim and the doc is not written to.
    const live = docStoreFrom(NOTES, ['Meeting notes']);
    expect(claimForCleanup(live.ydoc, rewriteOne(live.store))).toBe(0);
  });
});
