/**
 * What `applyBlockEdits` does with an edit it cannot carry out.
 *
 * The happy paths are `prose-outline.test.ts`. This file is the other half,
 * and it is worth its own runtime because of who writes these edits: a
 * language model, addressing blocks by id, in a live meeting. Every refusal
 * below is a shape a model has produced or will — an empty string, a
 * heading id that has since been deleted, markdown that parses to nothing —
 * and the contract is the same for all of them: name the failure in the
 * outcome, change nothing, and let the rest of the batch land. A batch that
 * threw, or that half-applied and reported success, would cost a meeting its
 * notes on one bad entry.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyBlockEdits, blocksAuthoredBy, releaseAuthorship } from './prose-batch.ts';
import { getProseFragment } from './prose-fragment.ts';
import { parseMarkdownBlocks, serializeFragmentToMarkdown } from './prose-markdown.ts';
import { readOutline } from './prose-outline.ts';

const AGENT = 'meeting-notes';
const SUGGESTER = { id: AGENT, name: 'Meeting Assistant', color: '#7c5cff' };

function docOf(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  const fragment = getProseFragment(doc);
  fragment.insert(0, parseMarkdownBlocks(markdown));
  return doc;
}

const md = (doc: Y.Doc): string => serializeFragmentToMarkdown(getProseFragment(doc)).trimEnd();

const apply = (doc: Y.Doc, edits: Parameters<typeof applyBlockEdits>[1]) =>
  applyBlockEdits(doc, edits, { author: AGENT, suggestionAuthor: SUGGESTER });

/** The id of the block whose text contains `needle`. */
const idOf = (doc: Y.Doc, needle: string): string => {
  const found = readOutline(doc).find((e) => e.text.includes(needle));
  if (!found) throw new Error(`no block reading ${needle}`);
  return found.id;
};

describe('an edit that carries no words', () => {
  it('an insert of whitespace is `empty`, and writes nothing', () => {
    const doc = docOf('## Topic\n');
    const res = apply(doc, [
      { op: 'insert_at_end', markdown: '   \n  ' },
      { op: 'insert_at_end', markdown: '- landed anyway' },
    ]);
    expect(res.outcomes[0]).toMatchObject({ status: 'failed', error: 'empty' });
    expect(res.applied).toBe(1);
    expect(md(doc)).toBe('## Topic\n\n- landed anyway');
  });

  it('a replace with nothing to put there is `empty`, and the block survives', () => {
    // Emptying a block is `delete_block`, said out loud. A replace that
    // silently deleted would lose a note to a model returning "".
    const doc = docOf('## Topic\n');
    apply(doc, [{ op: 'insert_at_end', markdown: '- a real note' }]);
    const res = apply(doc, [
      { op: 'replace_block', blockId: idOf(doc, 'a real note'), markdown: ' ' },
    ]);
    expect(res.outcomes[0]).toMatchObject({ status: 'failed', error: 'empty' });
    expect(md(doc)).toContain('- a real note');
  });
});

describe('an edit naming a block that is not there', () => {
  // Both blocks below are DELETED BY THE AGENT ITSELF first. A block the
  // agent does not own is not deletable at all — the delete becomes a
  // suggestion — so an agent-authored fixture is the only way to reach the
  // gone-block branch, and it is also the real sequence: a tick deletes a
  // note it wrote, and a later tick still holds the stale id.
  it('an insert under a heading id that is gone fails without opening a section', () => {
    const doc = docOf('# Huddle\n');
    apply(doc, [{ op: 'insert_at_end', markdown: '## Topic' }]);
    const headingId = idOf(doc, 'Topic');
    expect(apply(doc, [{ op: 'delete_block', blockId: headingId }]).applied).toBe(1);

    const res = apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '- orphan' }]);
    expect(res.outcomes[0]).toMatchObject({ status: 'failed', error: 'unknown-block' });
    // And it does NOT fall back to the end of the doc, which would file a
    // note under whatever section happens to be last.
    expect(md(doc)).not.toContain('orphan');
  });

  it('a delete of a block already deleted fails rather than deleting a neighbour', () => {
    const doc = docOf('# Huddle\n');
    apply(doc, [{ op: 'insert_at_end', markdown: '- one\n- two' }]);
    const oneId = idOf(doc, 'one');
    expect(apply(doc, [{ op: 'delete_block', blockId: oneId }]).applied).toBe(1);

    const again = apply(doc, [{ op: 'delete_block', blockId: oneId }]);
    expect(again.outcomes[0]).toMatchObject({ status: 'failed', error: 'unknown-block' });
    expect(md(doc)).toBe('# Huddle\n\n- two');
  });

  it('an insert under a block that is not a heading is refused by name', () => {
    const doc = docOf('# Huddle\n');
    apply(doc, [{ op: 'insert_at_end', markdown: '- a bullet' }]);
    const res = apply(doc, [
      { op: 'insert_under_heading', headingId: idOf(doc, 'a bullet'), markdown: '- under it' },
    ]);
    expect(res.outcomes[0]).toMatchObject({ status: 'failed', error: 'not-a-heading' });
    expect(md(doc)).not.toContain('under it');
  });
});

describe('replacing a block that is not a list item', () => {
  it('rewrites a paragraph the agent wrote, in place', () => {
    // The list-item path has its own branch (a bullet must go back into its
    // list); this is the other one, and it is what a topic heading and a
    // paragraph of notes both take.
    const doc = docOf('# Huddle\n');
    apply(doc, [{ op: 'insert_at_end', markdown: 'The sync wakes too often.' }]);
    const res = apply(doc, [
      {
        op: 'replace_block',
        blockId: idOf(doc, 'wakes too often'),
        markdown: 'The sync wakes every ninety seconds.',
      },
    ]);
    expect(res.applied).toBe(1);
    expect(md(doc)).toBe('# Huddle\n\nThe sync wakes every ninety seconds.');
  });

  it('claims what it wrote, so the block is still the agent’s afterwards', () => {
    const doc = docOf('# Huddle\n');
    apply(doc, [{ op: 'insert_at_end', markdown: '## Export range' }]);
    apply(doc, [
      {
        op: 'replace_block',
        blockId: idOf(doc, 'Export range'),
        markdown: '## Export range, and the dialog',
      },
    ]);
    expect(blocksAuthoredBy(doc, AGENT)).toHaveLength(1);
    // And the replacement is addressable — a block with no id could not be
    // named by the next tick's edits.
    expect(idOf(doc, 'and the dialog')).toBeTruthy();
  });

  it('one block may become several, and all of them are the agent’s', () => {
    const doc = docOf('# Huddle\n');
    apply(doc, [{ op: 'insert_at_end', markdown: 'A single paragraph.' }]);
    const res = apply(doc, [
      {
        op: 'replace_block',
        blockId: idOf(doc, 'A single paragraph'),
        markdown: '## Risks\n\n- the queue backs up',
      },
    ]);
    expect(res.applied).toBe(1);
    expect(md(doc)).toBe('# Huddle\n\n## Risks\n\n- the queue backs up');
    expect(blocksAuthoredBy(doc, AGENT).length).toBeGreaterThan(1);
  });
});

describe('releaseAuthorship', () => {
  it('drops every claim, so the agent must propose from then on', () => {
    const doc = docOf('# Huddle\n');
    apply(doc, [{ op: 'insert_at_end', markdown: '- one\n- two' }]);
    expect(blocksAuthoredBy(doc, AGENT).length).toBeGreaterThan(0);

    const released = releaseAuthorship(doc, AGENT);
    expect(released).toBeGreaterThan(0);
    expect(blocksAuthoredBy(doc, AGENT)).toEqual([]);

    // The behavioural consequence, which is the point of the call: a replace
    // of a block it no longer holds becomes a suggestion, and the accepted
    // text is unchanged.
    const res = apply(doc, [{ op: 'replace_block', blockId: idOf(doc, 'one'), markdown: '- ONE' }]);
    expect(res.suggested).toBe(1);
    expect(md(doc)).toContain('- one');
  });

  it('releasing what is not held is zero, and touches nothing', () => {
    const doc = docOf('# Huddle\n\n- a line a person typed\n');
    const before = md(doc);
    expect(releaseAuthorship(doc, AGENT)).toBe(0);
    expect(md(doc)).toBe(before);
  });
});
