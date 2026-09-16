/**
 * A heading the talk has outgrown is RENAMED BY ASKING.
 *
 * Half an hour into a meeting the heading a topic opened under is often
 * wrong: the room started on "Pricing" and spent forty minutes on packaging
 * tiers. Leaving it is a page filed under a name nobody would search for;
 * rewriting it silently reorganises, under a different name, a page somebody
 * is reading — and the note-taker owns the heading, so nothing in the write
 * path would have stopped it.
 *
 * So a rename is a SUGGESTION, always, whoever owns the heading, and this is
 * the file that pins it. `propose` on the edit is what makes that a property
 * of the write path rather than of a prompt.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { prose, type prose as proseTypes, suggestOps } from '@claude-workspaces/core';
import { headingRename } from '../src/notes-heading-rename.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

const OUTLINE: readonly proseTypes.OutlineEntry[] = [
  { id: 'h1', kind: 'heading', nodeName: 'heading', level: 2, text: 'Pricing', author: 'notes' },
  { id: 'b1', kind: 'listItem', nodeName: 'listItem', text: 'tiers', underHeadingId: 'h1' },
] as unknown as readonly proseTypes.OutlineEntry[];

describe('headingRename', () => {
  it('turns a replace on a heading into a proposal, whoever owns it', () => {
    const out = headingRename(
      { op: 'replace_block', blockId: 'h1', markdown: '## Pricing and packaging tiers' },
      OUTLINE,
    );
    expect(out).toEqual({
      edit: {
        op: 'replace_block',
        blockId: 'h1',
        markdown: '## Pricing and packaging tiers',
        propose: true,
      },
    });
  });

  it('says nothing about a replace on a bullet, which is an ordinary revision', () => {
    expect(
      headingRename({ op: 'replace_block', blockId: 'b1', markdown: '- three tiers' }, OUTLINE),
    ).toBeNull();
  });

  it('says nothing about an insert, or a delete', () => {
    expect(headingRename({ op: 'delete_block', blockId: 'h1' }, OUTLINE)).toBeNull();
    expect(headingRename({ op: 'insert_at_end', markdown: '## New' }, OUTLINE)).toBeNull();
  });

  it('refuses a replacement that is not a heading — that is a restructure', () => {
    const out = headingRename(
      { op: 'replace_block', blockId: 'h1', markdown: '- pricing, and also tiers' },
      OUTLINE,
    );
    expect(out).toMatchObject({ refused: expect.stringContaining('heading') });
  });

  it('refuses a replacement at a different level, which would re-file the doc', () => {
    // A `##` becoming a `###` puts the whole section inside whatever sits
    // above it — every line under it moves without one of them being edited.
    const out = headingRename(
      { op: 'replace_block', blockId: 'h1', markdown: '### Pricing and packaging' },
      OUTLINE,
    );
    expect(out).toMatchObject({ refused: expect.stringContaining('level') });
  });

  it('refuses a rename to the same words, which asks the reader for nothing', () => {
    const out = headingRename(
      { op: 'replace_block', blockId: 'h1', markdown: '## Pricing' },
      OUTLINE,
    );
    expect(out).toMatchObject({ refused: expect.stringContaining('same') });
  });

  it('says nothing about a block the outline has never heard of', () => {
    expect(
      headingRename({ op: 'replace_block', blockId: 'gone', markdown: '## X' }, OUTLINE),
    ).toBeNull();
  });
});

/**
 * THE MEETING THAT OUTGREW ITS HEADING, end to end.
 *
 * Tick one opens a topic on what the room started on. By tick three the room
 * has been on something wider for twenty minutes, and the note-taker sends
 * the better name. What must come out of the far end is a SUGGESTION: the
 * doc a reader's file still says the old words, and the rename is sitting
 * there to be accepted.
 */
describe('a meeting that talks past its own heading', () => {
  it('files the better name as a suggestion, and the doc still reads the old one', async () => {
    const harness = createNotesTickHarness({
      compose: (input, tick) => {
        if (tick === 1) return addNotes(input, '- three tiers on the table', 'Pricing');
        const heading = input.outline.find((e) => e.kind === 'heading');
        if (tick === 2 || heading === undefined) {
          return addNotes(input, '- support hours split out of the top tier');
        }
        return [
          { op: 'replace_block', blockId: heading.id, markdown: '## Pricing and packaging' },
          ...addNotes(input, '- and onboarding moves with it'),
        ];
      },
    });
    await harness.speak('three tiers on the table');
    await harness.speak('support hours come out of the top tier');
    await harness.speak('and onboarding moves with it');
    await harness.end();

    // WHAT A READER'S FILE SAYS is unchanged: the heading was never rewritten.
    expect(harness.headings()).toContain('Pricing');
    expect(harness.headings()).not.toContain('Pricing and packaging');
    // And the rename is waiting for them.
    const pending = suggestOps.listSuggestions(harness.ydoc);
    expect(pending).toHaveLength(1);
    // The proposed words are in the live doc, beside the struck ones.
    const live = prose
      .walkProse(prose.getProseFragment(harness.ydoc))
      .segments.map((s) => s.node.toString())
      .join('\n');
    expect(live).toContain('Pricing and packaging');
    expect(harness.errors).toEqual([]);
  });

  it('MUTATION CONTROL: the same edit on a BULLET is written straight in', async () => {
    // Identical op, identical batch position — only the target changes. If
    // this also came back as a suggestion, the case above would be measuring
    // "the note-taker cannot rewrite anything" rather than "a heading is
    // renamed by asking".
    const harness = createNotesTickHarness({
      compose: (input, tick) => {
        if (tick === 1) return addNotes(input, '- three tiers on the table', 'Pricing');
        const bullet = input.outline.find((e) => e.kind === 'listItem');
        if (bullet === undefined) return [];
        return [{ op: 'replace_block', blockId: bullet.id, markdown: '- four tiers, not three' }];
      },
    });
    await harness.speak('three tiers on the table');
    await harness.speak('make that four tiers, not three');
    await harness.end();
    expect(suggestOps.listSuggestions(harness.ydoc)).toHaveLength(0);
    expect(harness.markdown()).toContain('four tiers, not three');
  });
});

/**
 * WHAT THE MEETING KNOWS AFTER THE READER SAYS YES.
 *
 * A proposal replaces the block: the struck text goes, the offered element
 * stays, and the offered element is a NEW element with a new id. The meeting's
 * claim and its `NotesHeadingMemory` hold the OLD id. If accepting a rename
 * orphans the claim, the meeting silently loses the section it has been
 * writing into — which is the failure this whole PR exists to remove, arriving
 * by another door. Raised by an independent review, tested here rather than
 * reasoned about.
 */
describe('a rename the reader accepts', () => {
  it('leaves the meeting still writing under the heading it renamed', async () => {
    const harness = createNotesTickHarness({
      compose: (input, tick) => {
        if (tick === 1) return addNotes(input, '- three tiers on the table', 'Pricing');
        const heading = input.outline.find((e) => e.kind === 'heading');
        if (tick === 2 && heading !== undefined) {
          return [
            { op: 'replace_block', blockId: heading.id, markdown: '## Pricing and packaging' },
          ];
        }
        return addNotes(input, '- and onboarding moves with it');
      },
    });
    await harness.speak('three tiers on the table');
    await harness.speak('support hours come out of the top tier');

    const pending = suggestOps.listSuggestions(harness.ydoc);
    expect(pending).toHaveLength(1);
    const was = prose.readOutline(harness.ydoc).find((e) => e.kind === 'heading');
    // THE READER SAYS YES, mid-meeting.
    expect(suggestOps.acceptSuggestion(harness.ydoc, pending[0]!.sid)).toEqual({ ok: true });
    expect(harness.headings()).toEqual(['Pricing and packaging']);
    // THE ID IS THE SAME ID. An accept that minted a new block would orphan
    // the meeting's claim and its heading memory, both of which hold this one,
    // and the meeting would open a second topic beside the heading it just
    // renamed. Raised by an independent review; measured here.
    const now = prose.readOutline(harness.ydoc).find((e) => e.kind === 'heading');
    expect(now?.id).toBe(was?.id as string);

    // The meeting keeps going, and its next note has to land under that same
    // heading rather than opening a second topic beside it.
    await harness.speak('and onboarding moves with it');
    await harness.end();
    expect(harness.headings()).toHaveLength(1);
    expect(harness.markdown()).toContain('onboarding moves with it');
    expect(harness.errors).toEqual([]);
  });
});
