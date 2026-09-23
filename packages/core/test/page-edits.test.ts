import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  MAX_PAGE_EDITS,
  MAX_PAGE_EDIT_TEXT,
  type PageEdit,
  pageEditsText,
  readPageEdits,
} from '../src/page-edits.ts';
import { createThread, getThreads, listThreads } from '../src/schema.ts';
import type { ElementAnchor } from '../src/types.ts';

const anchor = (text: string): ElementAnchor => ({
  kind: 'element',
  fingerprint: {
    tag: 'H1',
    stableAttrs: {},
    classes: [],
    text,
    path: 'H1[0] > MAIN[0]',
    dataAttrs: {},
  },
  snippet: { text },
});

const edit = (over: Partial<PageEdit> = {}): PageEdit => ({
  anchor: anchor('Harborlight Street Projects'),
  selector: 'main h1',
  before: 'Harborlight Street Projects',
  after: 'Harborlight Street Works',
  ...over,
});

describe('readPageEdits', () => {
  it('keeps the element, the text before and the text after', () => {
    expect(readPageEdits([edit()])).toEqual([edit()]);
  });

  it('reads nothing as absent, so an ordinary comment keeps its shape', () => {
    expect(readPageEdits(undefined)).toBeUndefined();
    expect(readPageEdits([])).toBeUndefined();
    expect(readPageEdits('main h1')).toBeUndefined();
  });

  it('drops an edit with no element, or one that changes nothing', () => {
    const noAnchor = { ...edit(), anchor: { kind: 'subject' } };
    const thinAnchor = { ...edit(), anchor: { kind: 'element', fingerprint: { tag: 'H1' } } };
    const noSelector = { ...edit(), selector: '' };
    const same = edit({ after: 'Harborlight Street Projects' });
    const notText = { ...edit(), after: 7 };
    expect(readPageEdits([noAnchor, thinAnchor, noSelector, same, notText])).toBeUndefined();
    expect(readPageEdits([noAnchor, edit()])).toEqual([edit()]);
  });

  it('keeps an emptied element: deleting the words is an edit', () => {
    expect(readPageEdits([edit({ after: '' })])).toEqual([edit({ after: '' })]);
  });

  it('refuses words past the cap rather than keeping half of them', () => {
    const long = 'x'.repeat(MAX_PAGE_EDIT_TEXT + 1);
    expect(readPageEdits([edit({ after: long })])).toBeUndefined();
  });

  it('keeps at most the cap of edits', () => {
    const many = Array.from({ length: MAX_PAGE_EDITS + 5 }, (_, i) =>
      edit({ after: `Harborlight ${i}` }),
    );
    expect(readPageEdits(many)).toHaveLength(MAX_PAGE_EDITS);
  });
});

describe('pageEditsText', () => {
  it('says what changed where, one line an edit', () => {
    const text = pageEditsText([
      edit(),
      edit({ selector: 'td:nth-of-type(2)', before: 'Riverbend Way', after: '' }),
    ]);
    expect(text).toBe(
      '2 text edits on this page:\n' +
        '- main h1: "Harborlight Street Projects" → "Harborlight Street Works"\n' +
        '- td:nth-of-type(2): "Riverbend Way" → deleted',
    );
  });

  it('shortens long words in the line; the full text rides on the edit', () => {
    const text = pageEditsText([edit({ after: 'y'.repeat(400) })]);
    expect(text.startsWith('1 text edit on this page:\n')).toBe(true);
    expect(text.length).toBeLessThan(400);
    expect(text.endsWith('…"')).toBe(true);
  });
});

describe('a page edit on the thread', () => {
  const author = { id: 'u-alice', name: 'Alice', color: '#2e7dd7', kind: 'known' as const };

  it('is stored on the first comment and read back whole', () => {
    const doc = new Y.Doc();
    createThread(doc, {
      threadId: 't1',
      anchor: edit().anchor,
      createdBy: author,
      firstComment: { id: 'c1', text: pageEditsText([edit()]), pageEdits: [edit()] },
    });
    expect(listThreads(doc)[0]?.comments[0]?.pageEdits).toEqual([edit()]);
  });

  it('degrades a malformed stored value to an ordinary comment', () => {
    const doc = new Y.Doc();
    createThread(doc, {
      threadId: 't1',
      anchor: edit().anchor,
      createdBy: author,
      firstComment: { id: 'c1', text: 'hello' },
    });
    const comments = getThreads(doc).get('t1')?.get('comments') as Y.Array<Y.Map<unknown>>;
    comments.get(0).set('pageEdits', [{ selector: 'main h1' }]);
    const c = listThreads(doc)[0]?.comments[0];
    expect(c?.text).toBe('hello');
    expect(c && 'pageEdits' in c).toBe(false);
  });
});
