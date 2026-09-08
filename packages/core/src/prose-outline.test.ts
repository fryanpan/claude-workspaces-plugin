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
