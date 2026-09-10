import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyBlockEdits, blocksAuthoredBy, splitLeadingListItems } from './prose-batch.ts';
import { getProseFragment } from './prose-fragment.ts';
import { parseMarkdownBlocks, serializeFragmentToMarkdown } from './prose-markdown.ts';
import {
  clearAuthorshipOnPersonEdit,
  ensureBlockIds,
  findBlockById,
  isPersonOrigin,
  readBlockAuthor,
  readBlockId,
  readOutline,
} from './prose-outline.ts';
import { listSuggestions } from './suggest-ops.ts';

const AGENT = 'meeting-notes';
const SUGGESTER = { id: AGENT, name: 'Meeting Assistant', color: '#7c5cff' };

function docOf(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  const fragment = getProseFragment(doc);
  fragment.push(parseMarkdownBlocks(markdown));
  return doc;
}

function md(doc: Y.Doc): string {
  return serializeFragmentToMarkdown(getProseFragment(doc)).trimEnd();
}

function topKinds(doc: Y.Doc): string[] {
  return (getProseFragment(doc).toArray() as Y.XmlElement[]).map((el) => el.nodeName);
}

function apply(doc: Y.Doc, edits: Parameters<typeof applyBlockEdits>[1]) {
  return applyBlockEdits(doc, edits, { author: AGENT, suggestionAuthor: SUGGESTER });
}

describe('readOutline', () => {
  it('mints an id per addressable block and reports where each one sits', () => {
    const doc = docOf('# Title\n\n## Topic\n\n- one\n- two\n\nA paragraph.\n');
    const outline = readOutline(doc);
    const kinds = outline.map((e) => e.kind);
    expect(kinds).toEqual(['heading', 'heading', 'listItem', 'listItem', 'block']);
    expect(outline.map((e) => e.text)).toEqual(['Title', 'Topic', 'one', 'two', 'A paragraph.']);
    // Every entry is addressable, and no two share an address.
    const ids = outline.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const topic = outline[1];
    expect(outline[2]?.underHeadingId).toBe(topic?.id);
    expect(outline[4]?.underHeadingId).toBe(topic?.id);
    expect(topic?.level).toBe(2);
  });

  it('is idempotent — a second read mints nothing and returns the same ids', () => {
    const doc = docOf('## Topic\n\n- one\n');
    const first = readOutline(doc).map((e) => e.id);
    expect(ensureBlockIds(doc)).toBe(0);
    expect(readOutline(doc).map((e) => e.id)).toEqual(first);
  });

  it('keeps every heading but caps the body blocks at the recent end', () => {
    const doc = docOf('## Topic\n\n- one\n- two\n- three\n- four\n');
    const outline = readOutline(doc, { recentBlocks: 2 });
    expect(outline.map((e) => e.text)).toEqual(['Topic', 'three', 'four']);
  });

  it('with a step, the front of the window stands still while the doc grows', () => {
    // The behaviour a prompt cache is bought with: a caller reading this
    // outline every few seconds is billed on how much of the leading text is
    // unchanged, and a window that lets go of one entry per read changes its
    // first line every time. Growing to `cap + step` and dropping `step` at
    // once means the front is the same words for a step's worth of writes.
    const bullets = (n: number): string =>
      `## Topic\n\n${Array.from({ length: n }, (_, i) => `- item ${i}`).join('\n')}\n`;
    const front = (n: number): string[] =>
      readOutline(docOf(bullets(n)), { recentBlocks: 4, recentBlocksStep: 2 })
        .filter((e) => e.kind !== 'heading')
        .map((e) => e.text);

    // Under the cap and just over it: nothing is dropped yet.
    expect(front(4)).toEqual(['item 0', 'item 1', 'item 2', 'item 3']);
    expect(front(5)).toEqual(['item 0', 'item 1', 'item 2', 'item 3', 'item 4']);
    // The first drop takes a whole step, and then stands still for one more
    // write — which is the property, not the size.
    expect(front(6)[0]).toBe('item 2');
    expect(front(7)[0]).toBe('item 2');
    expect(front(8)[0]).toBe('item 4');
    // And it never shows less than the cap.
    for (let n = 4; n <= 20; n++) expect(front(n).length).toBeGreaterThanOrEqual(4);
  });

  it('without a step it still slides one at a time, as every other caller wants', () => {
    // The control: the stepped window is opt-in, so a caller that did not ask
    // for it must see exactly the old behaviour.
    const bullets = (n: number): string =>
      `## Topic\n\n${Array.from({ length: n }, (_, i) => `- item ${i}`).join('\n')}\n`;
    const front = (n: number): string =>
      readOutline(docOf(bullets(n)), { recentBlocks: 4 }).filter((e) => e.kind !== 'heading')[0]
        ?.text as string;
    expect(front(5)).toBe('item 1');
    expect(front(6)).toBe('item 2');
    expect(front(7)).toBe('item 3');
  });

  it('survives a Yjs round trip — the ids are in the CRDT, not in memory', () => {
    const doc = docOf('## Topic\n\n- one\n');
    const before = readOutline(doc).map((e) => e.id);
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));
    expect(readOutline(reloaded).map((e) => e.id)).toEqual(before);
  });

  it('an id outlives a rename of the heading above it', () => {
    const doc = docOf('## Topic\n\n- one\n');
    const outline = readOutline(doc);
    const bulletId = outline[1]?.id as string;
    const heading = getProseFragment(doc).get(0) as Y.XmlElement;
    doc.transact(() => {
      const text = heading.get(0) as Y.XmlText;
      text.delete(0, text.length);
      text.insert(0, 'Something else entirely');
    }, 'test-person-edit');
    expect(readBlockId(findBlockById(getProseFragment(doc), bulletId) as Y.XmlElement)).toBe(
      bulletId,
    );
  });
});

describe('isPersonOrigin', () => {
  it('names a socket object a person and every server-side string not', () => {
    expect(isPersonOrigin({ socket: true })).toBe(true);
    expect(isPersonOrigin('agent')).toBe(false);
    expect(isPersonOrigin('file-watch')).toBe(false);
    expect(isPersonOrigin(null)).toBe(false);
    expect(isPersonOrigin(undefined)).toBe(false);
  });
});

describe('clearAuthorshipOnPersonEdit', () => {
  it('hands back the bullet a person typed in and leaves its neighbours alone', () => {
    const doc = docOf('## Topic\n');
    const stop = clearAuthorshipOnPersonEdit(doc);
    const headingId = readOutline(doc)[0]?.id as string;
    apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '- one\n- two\n' }]);
    expect(blocksAuthoredBy(doc, AGENT).length).toBeGreaterThanOrEqual(2);

    const outline = readOutline(doc);
    const first = findBlockById(getProseFragment(doc), outline[1]?.id as string) as Y.XmlElement;
    const second = findBlockById(getProseFragment(doc), outline[2]?.id as string) as Y.XmlElement;
    // A person typing is a non-string origin — the collab socket's own shape.
    doc.transact(
      () => {
        const text = (first.get(0) as Y.XmlElement).get(0) as Y.XmlText;
        text.insert(text.length, '!');
      },
      { peer: 'browser' },
    );

    expect(readBlockAuthor(first)).toBeUndefined();
    expect(readBlockAuthor(second)).toBe(AGENT);
    stop();
  });

  it('leaves the claim alone when the agent itself writes', () => {
    const doc = docOf('## Topic\n');
    const stop = clearAuthorshipOnPersonEdit(doc);
    const headingId = readOutline(doc)[0]?.id as string;
    apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '- one\n' }]);
    const bullet = findBlockById(
      getProseFragment(doc),
      readOutline(doc)[1]?.id as string,
    ) as Y.XmlElement;
    expect(readBlockAuthor(bullet)).toBe(AGENT);
    stop();
  });
});

describe('splitLeadingListItems', () => {
  it('takes the leading run and hands back what followed', () => {
    const got = splitLeadingListItems('- one\n- two\n\nA paragraph.\n');
    expect(got?.ordered).toBe(false);
    expect(got?.items).toEqual(['one', 'two']);
    expect(got?.rest).toBe('A paragraph.');
  });

  it('keeps a nested sub-bullet with its item', () => {
    const got = splitLeadingListItems('- lead\n  - nested\n- next\n');
    expect(got?.items).toEqual(['lead\n- nested', 'next']);
  });

  it('refuses text that does not start with a list', () => {
    expect(splitLeadingListItems('A paragraph.\n\n- one\n')).toBeNull();
  });
});

describe('applyBlockEdits', () => {
  it('grows the list already under the heading instead of opening a second', () => {
    const doc = docOf('## Topic\n\n- one\n');
    const headingId = readOutline(doc)[0]?.id as string;
    apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '- two\n' }]);
    expect(topKinds(doc)).toEqual(['heading', 'bulletList']);
    expect(md(doc)).toBe('## Topic\n\n- one\n- two');
  });

  it('does not join lists of different types', () => {
    const doc = docOf('## Topic\n\n- one\n');
    const headingId = readOutline(doc)[0]?.id as string;
    apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '1. first\n' }]);
    expect(topKinds(doc)).toEqual(['heading', 'bulletList', 'orderedList']);
  });

  it('inserts at the end of the named section, not the end of the doc', () => {
    const doc = docOf('## First\n\n- a\n\n## Second\n\n- b\n');
    const firstId = readOutline(doc)[0]?.id as string;
    apply(doc, [{ op: 'insert_under_heading', headingId: firstId, markdown: '- a2\n' }]);
    expect(md(doc)).toBe('## First\n\n- a\n- a2\n\n## Second\n\n- b');
  });

  it('applies a replace on its own bullet and keeps the doc one list', () => {
    const doc = docOf('## Topic\n');
    const headingId = readOutline(doc)[0]?.id as string;
    apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '- rough note\n' }]);
    const bulletId = readOutline(doc)[1]?.id as string;
    const res = apply(doc, [
      { op: 'replace_block', blockId: bulletId, markdown: '- sharper note' },
    ]);
    expect(res.applied).toBe(1);
    expect(res.suggested).toBe(0);
    expect(md(doc)).toBe('## Topic\n\n- sharper note');
    expect(topKinds(doc)).toEqual(['heading', 'bulletList']);
  });

  it('turns one bullet into the several a multi-line regroup asks for', () => {
    // THE FAILURE THIS REPLACED: the marker stripping was a single-line regex
    // with no `m` flag, so on the multi-line markdown the prompt asks for when
    // regrouping a topic it matched nothing, the `- ` markers survived into
    // one item's text, and the bullet came back EMPTY with the whole
    // replacement nested underneath it — reported as `applied`.
    const doc = docOf('## Topic\n');
    const headingId = readOutline(doc)[0]?.id as string;
    apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '- one\n- two\n' }]);
    const first = readOutline(doc).find((e) => e.text === 'one')?.id as string;
    const res = apply(doc, [
      { op: 'replace_block', blockId: first, markdown: '- one, revised\n- and a second line' },
    ]);
    expect(res.applied).toBe(1);
    expect(md(doc)).toBe('## Topic\n\n- one, revised\n- and a second line\n- two');
    // One list, and every line in it is a bullet with words on it.
    expect(topKinds(doc)).toEqual(['heading', 'bulletList']);
    expect(readOutline(doc).map((e) => e.text)).toEqual([
      'Topic',
      'one, revised',
      'and a second line',
      'two',
    ]);
    // Both new bullets are the agent's, so the next tick may revise them.
    expect(blocksAuthoredBy(doc, AGENT).length).toBeGreaterThanOrEqual(3);
  });

  it('keeps a nested sub-point nested, and the tail after the list', () => {
    const doc = docOf('## Topic\n');
    const headingId = readOutline(doc)[0]?.id as string;
    apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '- flat point\n' }]);
    const flat = readOutline(doc).find((e) => e.text === 'flat point')?.id as string;
    const res = apply(doc, [
      {
        op: 'replace_block',
        blockId: flat,
        markdown: '- What the dialog gets wrong\n  - It forgets the range.\n\nStill open.',
      },
    ]);
    expect(res.applied).toBe(1);
    expect(md(doc)).toBe(
      '## Topic\n\n- What the dialog gets wrong\n  - It forgets the range.\n\nStill open.',
    );
  });

  it('proposes rather than rewrites a line it does not own', () => {
    const doc = docOf('## Topic\n\n- a line a person typed\n');
    const bulletId = readOutline(doc)[1]?.id as string;
    const res = apply(doc, [
      { op: 'replace_block', blockId: bulletId, markdown: '- the agent would say this' },
    ]);
    expect(res.suggested).toBe(1);
    expect(res.applied).toBe(0);
    // The ACCEPTED state — what reaches disk — is untouched until acceptance.
    expect(md(doc)).toBe('## Topic\n\n- a line a person typed');
    const pending = listSuggestions(doc);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.author.name).toBe('Meeting Assistant');
  });

  it('proposes rather than deletes a line it does not own', () => {
    const doc = docOf('## Topic\n\n- a line a person typed\n');
    const bulletId = readOutline(doc)[1]?.id as string;
    const res = apply(doc, [{ op: 'delete_block', blockId: bulletId }]);
    expect(res.suggested).toBe(1);
    expect(md(doc)).toBe('## Topic\n\n- a line a person typed');
  });

  it('deletes its own bullet, and drops the list when it empties', () => {
    const doc = docOf('## Topic\n');
    const headingId = readOutline(doc)[0]?.id as string;
    apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '- only\n' }]);
    const bulletId = readOutline(doc)[1]?.id as string;
    expect(apply(doc, [{ op: 'delete_block', blockId: bulletId }]).applied).toBe(1);
    expect(topKinds(doc)).toEqual(['heading']);
  });

  it('reports a block that is gone and still lands the rest of the batch', () => {
    const doc = docOf('## Topic\n');
    const headingId = readOutline(doc)[0]?.id as string;
    const res = apply(doc, [
      { op: 'replace_block', blockId: 'bnot-a-real-id', markdown: '- x' },
      { op: 'insert_under_heading', headingId, markdown: '- landed anyway\n' },
    ]);
    expect(res.failed).toBe(1);
    expect(res.outcomes[0]?.error).toBe('unknown-block');
    expect(md(doc)).toBe('## Topic\n\n- landed anyway');
  });

  it('is one transaction — an observer sees the whole batch at once', () => {
    const doc = docOf('## Topic\n');
    const headingId = readOutline(doc)[0]?.id as string;
    const batches: number[] = [];
    getProseFragment(doc).observeDeep((_events, txn) => {
      if (txn.origin === 'agent') batches.push(1);
    });
    apply(doc, [
      { op: 'insert_under_heading', headingId, markdown: '- one\n' },
      { op: 'insert_under_heading', headingId, markdown: '- two\n' },
      { op: 'insert_at_end', markdown: '## A second topic\n' },
    ]);
    expect(batches).toHaveLength(1);
    expect(md(doc)).toBe('## Topic\n\n- one\n- two\n\n## A second topic');
  });

  it('can add a heading and then write under it in the same batch', () => {
    const doc = docOf('## Topic\n');
    apply(doc, [{ op: 'insert_at_end', markdown: '## New topic\n' }]);
    const newHeading = readOutline(doc).find((e) => e.text === 'New topic');
    expect(newHeading).toBeDefined();
    apply(doc, [
      { op: 'insert_under_heading', headingId: newHeading?.id as string, markdown: '- a point\n' },
    ]);
    expect(md(doc)).toBe('## Topic\n\n## New topic\n\n- a point');
  });

  it('refuses to treat a paragraph as a heading', () => {
    const doc = docOf('A paragraph.\n');
    const id = readOutline(doc)[0]?.id as string;
    const res = apply(doc, [{ op: 'insert_under_heading', headingId: id, markdown: '- x\n' }]);
    expect(res.outcomes[0]?.error).toBe('not-a-heading');
  });
});

/**
 * What a browser with the doc open does after every change: keep an empty,
 * unclaimed paragraph at the end of the document whenever the last block is
 * not one. That is Tiptap StarterKit's `TrailingNode`, and it is why a
 * meeting's notes each became a one-item list of their own.
 */
function browserTrailingNode(doc: Y.Doc): void {
  const fragment = getProseFragment(doc);
  const last = fragment.get(fragment.length - 1) as Y.XmlElement | Y.XmlText | undefined;
  if (last instanceof Y.XmlElement && last.nodeName === 'paragraph') return;
  fragment.push([new Y.XmlElement('paragraph')]);
}

function lastTop(doc: Y.Doc): Y.XmlElement {
  const fragment = getProseFragment(doc);
  return fragment.get(fragment.length - 1) as Y.XmlElement;
}

describe('applyBlockEdits while a browser holds the doc open', () => {
  it('grows the list across the empty paragraph the browser leaves at the end', () => {
    const doc = docOf('## Notes\n\n- one\n');
    browserTrailingNode(doc);
    expect(topKinds(doc)).toEqual(['heading', 'bulletList', 'paragraph']);
    const headingId = readOutline(doc)[0]?.id as string;
    apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '- two\n' }]);
    expect(topKinds(doc)).toEqual(['heading', 'bulletList', 'paragraph']);
    // The trailing paragraph is still its own (empty) block at the end.
    expect(readOutline(doc).map((e) => e.text)).toEqual(['Notes', 'one', 'two', '']);
  });

  it('keeps five ticks of a meeting in one list instead of five', () => {
    const doc = docOf('## Notes\n');
    const headingId = readOutline(doc)[0]?.id as string;
    for (const n of ['one', 'two', 'three', 'four', 'five']) {
      apply(doc, [{ op: 'insert_under_heading', headingId, markdown: `- ${n}\n` }]);
      browserTrailingNode(doc);
    }
    expect(topKinds(doc)).toEqual(['heading', 'bulletList', 'paragraph']);
    expect(readOutline(doc).map((e) => e.text)).toEqual([
      'Notes',
      'one',
      'two',
      'three',
      'four',
      'five',
      '',
    ]);
    // Every bullet is still the agent's, so a later tick may revise any of them.
    expect(blocksAuthoredBy(doc, AGENT).length).toBeGreaterThanOrEqual(5);
  });

  it('leaves the browser paragraph itself untouched — same element, still last', () => {
    const doc = docOf('## Notes\n\n- one\n');
    browserTrailingNode(doc);
    const paragraph = lastTop(doc);
    const headingId = readOutline(doc)[0]?.id as string;
    apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '- two\n' }]);
    expect(lastTop(doc)).toBe(paragraph);
    expect(readBlockAuthor(paragraph)).toBeUndefined();
  });

  it("keeps a note's own paragraph with the note, not behind the browser's", () => {
    const doc = docOf('## Notes\n\n- one\n');
    browserTrailingNode(doc);
    const paragraph = lastTop(doc);
    const headingId = readOutline(doc)[0]?.id as string;
    apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '- two\n\nWhy it matters.\n' }]);
    // The bullet joined the list and its paragraph follows it. Inserting that
    // paragraph at the original index would put the browser's empty one back
    // between the two — the gap this whole change exists to close.
    expect(topKinds(doc)).toEqual(['heading', 'bulletList', 'paragraph', 'paragraph']);
    expect(readOutline(doc).map((e) => e.text)).toEqual([
      'Notes',
      'one',
      'two',
      'Why it matters.',
      '',
    ]);
    // And the block still at the end is the browser's own, not a new one.
    expect(lastTop(doc)).toBe(paragraph);
  });

  it('reaches the list from insert_at_end too', () => {
    const doc = docOf('- one\n');
    browserTrailingNode(doc);
    apply(doc, [{ op: 'insert_at_end', markdown: '- two\n' }]);
    expect(topKinds(doc)).toEqual(['bulletList', 'paragraph']);
    expect(readOutline(doc).map((e) => e.text)).toEqual(['one', 'two', '']);
  });

  // ---- negative controls: what the walk must still refuse to step over ----

  it('does not reach past a paragraph that has words in it', () => {
    const doc = docOf('## Notes\n\n- one\n\nA thought of my own.\n');
    const headingId = readOutline(doc)[0]?.id as string;
    apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '- two\n' }]);
    expect(topKinds(doc)).toEqual(['heading', 'bulletList', 'paragraph', 'bulletList']);
  });

  it('does not reach past an empty paragraph an agent claimed', () => {
    const doc = docOf('## Notes\n\n- one\n');
    browserTrailingNode(doc);
    lastTop(doc).setAttribute('cwAuthor', AGENT);
    const headingId = readOutline(doc)[0]?.id as string;
    apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '- two\n' }]);
    expect(topKinds(doc)).toEqual(['heading', 'bulletList', 'paragraph', 'bulletList']);
  });

  it('does not reach past a paragraph holding an image', () => {
    const doc = docOf('## Notes\n\n- one\n');
    const fragment = getProseFragment(doc);
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlElement('image')]);
    fragment.push([paragraph]);
    const headingId = readOutline(doc)[0]?.id as string;
    apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '- two\n' }]);
    expect(topKinds(doc)).toEqual(['heading', 'bulletList', 'paragraph', 'bulletList']);
  });

  it('still refuses to join lists of different types across the paragraph', () => {
    const doc = docOf('## Notes\n\n- one\n');
    browserTrailingNode(doc);
    const headingId = readOutline(doc)[0]?.id as string;
    apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '1. first\n' }]);
    expect(topKinds(doc)).toEqual(['heading', 'bulletList', 'paragraph', 'orderedList']);
  });

  it('opens a list when the section holds only the browser paragraph', () => {
    const doc = docOf('## Notes\n');
    const fragment = getProseFragment(doc);
    fragment.push([new Y.XmlElement('paragraph')]);
    const headingId = readOutline(doc)[0]?.id as string;
    apply(doc, [{ op: 'insert_under_heading', headingId, markdown: '- one\n' }]);
    expect(topKinds(doc)).toEqual(['heading', 'paragraph', 'bulletList']);
    expect(readOutline(doc).map((e) => e.text)).toEqual(['Notes', '', 'one']);
  });
});
