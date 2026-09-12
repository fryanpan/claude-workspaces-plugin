/**
 * A comment thread whose ENTIRE quoted span is replaced in one edit.
 *
 * Reported from a fresh-eyes pass on the review surface: a find-and-replace
 * whose match covered every word a card was anchored to dropped the card and
 * its highlight for good — still gone after a reload, while the server went
 * on reporting the thread open. A replace that took only part of the span
 * never did that.
 *
 * The real editor is mounted here rather than a fake surface on purpose. The
 * bug lives in the ASSOCIATION of the stored relative positions, and it is
 * @tiptap/y-tiptap that chooses it (assoc -1, so the end position holds the
 * span's last character). A hand-built anchor picks its own assoc and can
 * pass over the defect without touching it — which is why the anchors below
 * come from `getSelectionRel`, the same call the composer makes.
 */
import { createThread, prose } from '@claude-workspaces/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createSeenTracker } from '../src/comment-seen.ts';
import { createThreadProjection } from '../src/doc/thread-projection.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import type { ReviewSurface } from '../src/review-surface.ts';

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
});

function mount(md: string) {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const editor: EditorHandle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc) });
  const projection = createThreadProjection({
    ydoc,
    surface: editor as unknown as Pick<
      ReviewSurface,
      'resolveRel' | 'setThreadRanges' | 'lineForPos'
    >,
    seen: createSeenTracker({
      docId: 'd1',
      storage: { getItem: () => null, setItem: () => {} },
    }),
    onPendingExpiry: vi.fn(),
    showResolved: () => true,
  });
  open.push(() => {
    projection.clearPendingExpiry();
    editor.destroy();
  });
  return { ydoc, editor, projection };
}

/** Comment on a range the way the composer does: select it, take the pair of
 *  relative positions the editor hands back, store them on a new thread. */
function commentOn(ydoc: Y.Doc, editor: EditorHandle, range: { from: number; to: number }): void {
  editor.editor.commands.setTextSelection(range);
  const sel = editor.getSelectionRel();
  if (!sel) throw new Error('selection did not resolve — check the range');
  createThread(ydoc, {
    threadId: 't-1',
    anchor: {
      kind: 'text-range',
      startRel: sel.start,
      endRel: sel.end,
      snippet: { text: sel.snippet },
    },
    createdBy: { id: 'u2', name: 'Bob', kind: 'known', color: '#c0392b' },
    firstComment: { id: 'c-1', text: 'is this still true?' },
  });
}

/** What the card shows: does the thread still have a live text anchor, and
 *  which words does its highlight cover? */
function card(projection: ReturnType<typeof mount>['projection'], editor: EditorHandle) {
  const thread = projection.collect().find((t) => t.id === 't-1');
  const range = projection.resolveRange('t-1');
  return {
    present: thread != null,
    kind: thread?.anchor.kind,
    highlighted: range ? editor.editor.state.doc.textBetween(range.from, range.to) : null,
  };
}

const SENTENCE = 'Alpha bravo gamma.';

describe('a comment survives an edit that replaces every word it quoted', () => {
  it('re-anchors onto the replacement when the match covers the whole span', () => {
    const { ydoc, editor, projection } = mount(`${SENTENCE} Delta epsilon.\n`);
    commentOn(ydoc, editor, { from: 1, to: 1 + SENTENCE.length });
    expect(card(projection, editor)).toEqual({
      present: true,
      kind: 'text-range',
      highlighted: SENTENCE,
    });

    const res = prose.findAndReplace(ydoc, { find: SENTENCE, replace: 'Zulu yankee.' });
    expect(res.ok).toBe(true);

    // The card stays, and its highlight has moved onto the new words rather
    // than collapsing to nothing.
    expect(card(projection, editor)).toEqual({
      present: true,
      kind: 'text-range',
      highlighted: 'Zulu yankee.',
    });
  });

  it('re-anchors when the whole span is the whole paragraph', () => {
    const { ydoc, editor, projection } = mount(`${SENTENCE}\n\nSecond paragraph.\n`);
    commentOn(ydoc, editor, { from: 1, to: 1 + SENTENCE.length });
    const res = prose.findAndReplace(ydoc, { find: SENTENCE, replace: 'Zulu yankee.' });
    expect(res.ok).toBe(true);
    expect(card(projection, editor)).toEqual({
      present: true,
      kind: 'text-range',
      highlighted: 'Zulu yankee.',
    });
  });

  it('re-anchors when rewrite_thread_region rewrites the thread’s own region', () => {
    const { ydoc, editor, projection } = mount(`${SENTENCE} Delta epsilon.\n`);
    commentOn(ydoc, editor, { from: 1, to: 1 + SENTENCE.length });
    const anchor = (ydoc.getMap('threads').get('t-1') as Y.Map<unknown>).get('anchor') as {
      startRel: Uint8Array;
      endRel: Uint8Array;
    };
    const res = prose.rewriteRange(ydoc, {
      startRel: anchor.startRel,
      endRel: anchor.endRel,
      replacement: 'Zulu yankee.',
    });
    expect(res.ok).toBe(true);
    expect(card(projection, editor)).toEqual({
      present: true,
      kind: 'text-range',
      highlighted: 'Zulu yankee.',
    });
  });

  // The control: a replace INSIDE the span always worked, because the
  // anchor's end still had a live character to hold. It has to keep working —
  // this case passes both before and after the fix.
  it('still tracks a replace that takes only part of the span', () => {
    const { ydoc, editor, projection } = mount(`${SENTENCE} Delta epsilon.\n`);
    commentOn(ydoc, editor, { from: 1, to: 1 + SENTENCE.length });
    const res = prose.findAndReplace(ydoc, { find: 'bravo', replace: 'charlie' });
    expect(res.ok).toBe(true);
    expect(card(projection, editor)).toEqual({
      present: true,
      kind: 'text-range',
      highlighted: 'Alpha charlie gamma.',
    });
  });
});
