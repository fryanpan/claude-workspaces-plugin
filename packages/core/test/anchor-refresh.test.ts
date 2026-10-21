/**
 * A page's report of what a thread's element says now, written over the
 * thread's anchor with the first anchor kept beside it.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { refreshAnchor } from '../src/anchor/refresh.ts';
import { createThread, getThreads, listThreads, markOrphan } from '../src/schema.ts';
import type { Anchor, ElementAnchor, User } from '../src/types.ts';

const bryan: User = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };

const sampleAnchor: ElementAnchor = {
  kind: 'element',
  fingerprint: {
    tag: 'BUTTON',
    stableAttrs: { 'aria-label': 'Submit' },
    classes: ['btn', 'primary'],
    text: 'Submit',
    path: 'BUTTON[0] > FORM[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: 'Submit' },
};

describe('refreshAnchor', () => {
  const made = (
    anchor: Anchor = { ...sampleAnchor, context: { url: '/stand' }, at: { x: 0.2, y: 0.5 } },
  ) => {
    const doc = new Y.Doc();
    createThread(doc, {
      threadId: 't1',
      anchor,
      createdBy: bryan,
      firstComment: { id: 'c1', text: 'x' },
    });
    return doc;
  };
  const seen = (text: string, path = 'BUTTON[1] > FORM[0] > BODY[0]'): ElementAnchor => ({
    kind: 'element',
    fingerprint: { ...sampleAnchor.fingerprint, text, path },
    snippet: { text },
    context: { url: '/elsewhere' },
  });

  it('takes the words and path a page found, and keeps the first anchor and the context', () => {
    const doc = made();
    const r = refreshAnchor(doc, 't1', seen('Submit order'));
    expect(r.ok && r.changed).toBe(true);
    const a = r.ok ? r.thread.anchor : null;
    expect(a?.kind === 'element' && [a.fingerprint.text, a.fingerprint.path]).toEqual([
      'Submit order',
      'BUTTON[1] > FORM[0] > BODY[0]',
    ]);
    // Where it was made, and where on the element: the thread's, not the page's.
    expect(a?.kind === 'element' && [a.context, a.at]).toEqual([
      { url: '/stand' },
      { x: 0.2, y: 0.5 },
    ]);
    expect(getThreads(doc).get('t1')?.get('firstAnchor')).toEqual({
      ...sampleAnchor,
      context: { url: '/stand' },
      at: { x: 0.2, y: 0.5 },
    });
    // A second round moves the anchor on and leaves the first one alone.
    refreshAnchor(doc, 't1', seen('Submit the order'));
    const t = listThreads(doc)[0];
    expect(t?.anchor.kind === 'element' && t.anchor.fingerprint.text).toBe('Submit the order');
    expect(
      (getThreads(doc).get('t1')?.get('firstAnchor') as typeof sampleAnchor).snippet.text,
    ).toBe('Submit');
  });

  it('writes nothing when the page found what the anchor already says', () => {
    const doc = made();
    const anchor = sampleAnchor;
    let updates = 0;
    doc.on('update', () => updates++);
    const r = refreshAnchor(doc, 't1', {
      ...anchor,
      snippet: { text: 'Submit', rect: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } },
      fingerprint: { ...anchor.fingerprint, rect: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } },
    });
    expect(r.ok && r.changed).toBe(false);
    expect(updates).toBe(0);
    expect(getThreads(doc).get('t1')?.has('firstAnchor')).toBe(false);
  });

  it('refuses an orphan, a words anchor, another tag and a missing thread', () => {
    const orphaned = made();
    markOrphan(orphaned, 't1');
    expect(refreshAnchor(orphaned, 't1', seen('Submit order'))).toEqual({
      ok: false,
      reason: 'not-element',
    });
    const words = made({
      kind: 'element',
      fingerprint: {
        tag: '*',
        stableAttrs: {},
        classes: [],
        text: 'Submit',
        path: '',
        dataAttrs: {},
      },
      snippet: { text: 'Submit' },
    });
    expect(refreshAnchor(words, 't1', seen('Submit order'))).toEqual({
      ok: false,
      reason: 'not-element',
    });
    const other = seen('Submit order');
    expect(
      refreshAnchor(made(), 't1', { ...other, fingerprint: { ...other.fingerprint, tag: 'A' } }),
    ).toEqual({ ok: false, reason: 'other-tag' });
    expect(refreshAnchor(made(), 'nope', seen('Submit order'))).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });
});
