/**
 * The comment list survives a remote update that arrives mid-repaint.
 *
 * Reported by Sentry, not by a person: "Caught error while handling a Yjs
 * update" with a TypeError reading `nodeSize`, 102 times in a week. The read
 * is y-prosemirror's `mapping.get(t).nodeSize` inside
 * `relativePositionToAbsolutePosition`, which the editor's `resolveRel` calls
 * for every stored anchor.
 *
 * The sequence: a remote peer changes the threads map and the prose in ONE
 * update. The chrome's threads observer runs before the ySync plugin's own
 * observer has rebuilt its Yjs-element → ProseMirror-node mapping, so the
 * anchor walk steps over an element that is in the tree and not in the
 * mapping. The throw escaped the whole collect pass, so every thread on the
 * doc lost that repaint — not just the one whose anchor could not be placed.
 *
 * The real editor is mounted rather than a fake surface because the defect is
 * in the binding's mapping, which only the real ySync plugin maintains.
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
    seen: createSeenTracker({ docId: 'd1', storage: { getItem: () => null, setItem: () => {} } }),
    onPendingExpiry: vi.fn(),
    showResolved: () => true,
  });
  open.push(() => {
    projection.clearPendingExpiry();
    editor.destroy();
  });
  return { ydoc, editor, projection };
}

/** Comment on a phrase the way the composer does: select the words, keep the
 *  pair of relative positions the editor hands back. */
function commentOn(ydoc: Y.Doc, editor: EditorHandle, threadId: string, phrase: string): void {
  const at = editor.editor.state.doc.textContent.indexOf(phrase);
  if (at < 0) throw new Error(`phrase not in the document: ${phrase}`);
  // textContent has no block separators, and each paragraph opens with one
  // position — so walk the blocks to turn a text offset into a doc position.
  let from = -1;
  let seen = 0;
  editor.editor.state.doc.descendants((node, pos) => {
    if (from >= 0 || !node.isTextblock) return true;
    const len = node.textContent.length;
    if (at < seen + len) from = pos + 1 + (at - seen);
    seen += len;
    return false;
  });
  editor.editor.commands.setTextSelection({ from, to: from + phrase.length });
  const sel = editor.getSelectionRel();
  if (!sel) throw new Error('selection did not resolve — check the phrase');
  createThread(ydoc, {
    threadId,
    anchor: {
      kind: 'text-range',
      startRel: sel.start,
      endRel: sel.end,
      snippet: { text: sel.snippet },
    },
    createdBy: { id: 'u2', name: 'Reviewer', kind: 'known', color: '#c0392b' },
    firstComment: { id: `c-${threadId}`, text: 'is this still true?' },
  });
}

/** What the panel would draw for one thread: is it still anchored to text,
 *  and over which words. */
function card(
  projection: ReturnType<typeof mount>['projection'],
  editor: EditorHandle,
  id: string,
) {
  const thread = projection.collect().find((t) => t.id === id);
  const range = projection.resolveRange(id);
  return {
    kind: thread?.anchor.kind,
    highlighted: range ? editor.editor.state.doc.textBetween(range.from, range.to) : null,
  };
}

describe('the comment list survives a remote update arriving mid-repaint', () => {
  it('collects every thread while the sync mapping is still being rebuilt', () => {
    const { ydoc, editor, projection } = mount('Alpha bravo.\n\nCharlie delta.\n\nEcho foxtrot.\n');
    commentOn(ydoc, editor, 't-1', 'Echo foxtrot');
    commentOn(ydoc, editor, 't-2', 'Alpha bravo');

    // The chrome's own wiring: every threads change repaints the panel, and
    // the repaint collects every thread and resolves its anchor.
    const repaints: Array<{ ids: string[] }> = [];
    let thrown: unknown = null;
    const observer = () => {
      try {
        repaints.push({ ids: projection.collect().map((t) => t.id) });
      } catch (e) {
        thrown = e;
      }
    };
    ydoc.getMap('threads').observeDeep(observer);
    open.push(() => ydoc.getMap('threads').unobserveDeep(observer));

    // A peer replies on one thread and inserts two paragraphs above the
    // anchored prose, in a single update — the shape the crash came from.
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    remote.transact(() => {
      const comments = (remote.getMap('threads').get('t-1') as Y.Map<unknown>).get(
        'comments',
      ) as Y.Array<Y.Map<unknown>>;
      const reply = new Y.Map<unknown>();
      reply.set('id', 'c-reply');
      reply.set('author', { id: 'u3', name: 'Peer', kind: 'known', color: '#2980b9' });
      reply.set('text', 'still true.');
      reply.set('ts', 1_700_000_000_000);
      comments.push([reply]);
      prose
        .getProseFragment(remote)
        .insert(0, prose.parseMarkdownBlocks('Intro one.\n\nIntro two.\n'));
    });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote));

    // The repaint ran and returned the whole list. Before the fix it threw
    // out of `collect`, so the panel got nothing for this update.
    expect(thrown).toBe(null);
    expect(repaints.length).toBeGreaterThan(0);
    for (const r of repaints) expect(r.ids.sort()).toEqual(['t-1', 't-2']);

    // And once the update has landed, both cards are anchored to their own
    // words again — the inserted paragraphs moved them, nothing lost them.
    expect(card(projection, editor, 't-1')).toEqual({
      kind: 'text-range',
      highlighted: 'Echo foxtrot',
    });
    expect(card(projection, editor, 't-2')).toEqual({
      kind: 'text-range',
      highlighted: 'Alpha bravo',
    });
  });

  // The control: the same doc and the same anchors with no remote update in
  // flight resolve normally, so the case above is about the timing and not
  // about the anchors themselves. It passes before and after the fix.
  it('still resolves both anchors when no update is in flight', () => {
    const { ydoc, editor, projection } = mount('Alpha bravo.\n\nCharlie delta.\n\nEcho foxtrot.\n');
    commentOn(ydoc, editor, 't-1', 'Echo foxtrot');
    commentOn(ydoc, editor, 't-2', 'Alpha bravo');
    expect(card(projection, editor, 't-1')).toEqual({
      kind: 'text-range',
      highlighted: 'Echo foxtrot',
    });
    expect(card(projection, editor, 't-2')).toEqual({
      kind: 'text-range',
      highlighted: 'Alpha bravo',
    });
  });
});
