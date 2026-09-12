import {
  type Comment,
  type Thread,
  type User,
  createThread,
  prose,
  setCommentReview,
} from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createEditor } from '../src/editor.ts';
import { type ComposerEditorModule, setComposerEditorLoader } from '../src/md-composer.ts';
import { mountMobileReview } from '../src/mobile-review.ts';
import { MountScope } from '../src/mount-scope.ts';
import { mountMarkupMargin } from '../src/redline/markup-margin.ts';
import { mountReviewChrome } from '../src/review-chrome.ts';
import type { InlineThreadCard } from '../src/review-surface.ts';
import { ThreadPanel } from '../src/threads.ts';

/**
 * A half-typed answer to a question survives other threads changing.
 *
 * Reported by Bryan (2026-09-12): typing in a comment's input in the doc's
 * margin while an agent replied to and resolved OTHER threads, "my text in
 * progress in the input for this comment … disappeared" on every update.
 * Reproduced headless at 1180x820: the reply textarea kept its words, but a
 * pending QUESTION's folded card answers from a one-line `<input>`, and every
 * surface's rebuild snapshot read only `textarea`. A reply on another thread
 * emptied the field and dropped focus to body.
 */

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const bob: User = { id: 'u2', name: 'Bob', kind: 'known', color: '#e36f1e' };

const cleanups: Array<() => void> = [];
beforeEach(() => {
  history.replaceState(null, '', '/workspaces/w-1/docs/d1');
  // The composer chunk never lands; nothing here types into the reply box.
  setComposerEditorLoader(() => new Promise<ComposerEditorModule>(() => {}));
});
afterEach(() => {
  for (const f of cleanups.splice(0).reverse()) f();
  setComposerEditorLoader(null);
  document.body.innerHTML = '';
});

const answerField = (root: ParentNode, id: string): HTMLInputElement | null =>
  root.querySelector<HTMLInputElement>(`.thread[data-thread-id="${id}"] .thread-answer-input`);

/** Type into the field the way a reader leaves it: words, caret mid-word. */
function typeInto(input: HTMLInputElement): void {
  input.value = 'the honeycrisp';
  input.focus();
  input.setSelectionRange(4, 4);
  expect(document.activeElement, 'focus never landed — the rest is vacuous').toBe(input);
}

function expectKept(before: HTMLInputElement, after: HTMLInputElement | null, what = ''): void {
  expect(after, `${what}: the rebuilt card lost its answer field`).not.toBeNull();
  expect(after, `${what}: the card was not rebuilt — the case proves nothing`).not.toBe(before);
  expect(after?.value).toBe('the honeycrisp');
  expect(document.activeElement).toBe(after);
  expect(after?.selectionStart).toBe(4);
  expect(after?.selectionEnd).toBe(4);
}

describe('the balloon margin', () => {
  function mountDoc() {
    // The chrome's own DOM contract (same shell markup-margin.test.ts mounts).
    document.body.innerHTML = `
      <div id="shell">
        <aside id="set-pane"></aside>
        <main id="editor-pane"><div id="editor"></div></main>
        <aside id="threads-pane">
          <div class="threads-tabs">
            <button class="tab active" data-tab="open">Open</button>
            <button class="tab" data-tab="resolved">Resolved</button>
          </div>
          <button id="toggle-threads">☰</button>
          <span id="threads-count"></span>
          <button id="close-threads">×</button>
          <ol id="threads-list"></ol>
        </aside>
        <div id="threads-scrim"></div>
        <div id="doc-title"></div>
        <div id="composer" class="hidden">
          <div id="composer-avatar"></div>
          <div id="composer-quote"></div>
          <textarea id="composer-text"></textarea>
          <button id="composer-submit">Post</button>
        </div>
        <div id="composer-scrim" class="hidden"></div>
        <div id="thread-view" class="hidden">
          <button id="thread-view-close">×</button>
          <div id="thread-view-body"></div>
          <textarea id="thread-view-reply-text"></textarea>
          <button id="thread-view-reply-submit">Reply</button>
        </div>
        <div id="toast" class="hidden"></div>
      </div>`;
    const parent = document.getElementById('editor') as HTMLElement;
    const ydoc = new Y.Doc();
    prose
      .getProseFragment(ydoc)
      .push(prose.parseMarkdownBlocks('Apples bridges lanterns harbor.\n'));
    const editor = createEditor({ parent, ydoc, awareness: new Awareness(ydoc) });
    const scope = new MountScope();
    const chrome = mountReviewChrome({
      docId: 'd1',
      user: alice,
      ydoc,
      surface: editor,
      whenSynced: (cb) => cb(),
      canWrite: true,
      scope,
      selectHint: '',
      reanchorHint: '',
      getSelection: () => editor.getSelectionRel(),
    });
    cleanups.push(() => {
      scope.dispose();
      editor.destroy();
    });
    const threadAt = (from: number, to: number, id: string): void => {
      editor.editor.commands.setTextSelection({ from, to });
      const sel = editor.getSelectionRel();
      if (!sel) throw new Error('selection did not resolve');
      createThread(ydoc, {
        threadId: id,
        anchor: {
          kind: 'text-range',
          startRel: sel.start,
          endRel: sel.end,
          snippet: { text: sel.snippet },
        },
        createdBy: { id: 'u2', name: 'Bob', kind: 'known', color: '#c0392b' },
        firstComment: { id: `${id}-c1`, text: `opening ${id}` },
      });
    };
    const margin = mountMarkupMargin({
      editorEl: parent,
      view: editor.editor.view,
      getDeletions: () => [],
      threads: () => chrome.collectThreads(),
      chrome,
      scope,
    });
    return { ydoc, threadAt, margin };
  }

  function replyOn(ydoc: Y.Doc, threadId: string): void {
    const comments = (ydoc.getMap('threads').get(threadId) as Y.Map<unknown>).get(
      'comments',
    ) as Y.Array<Y.Map<unknown>>;
    const reply = new Y.Map<unknown>();
    reply.set('id', `bg-${comments.length}`);
    reply.set('author', { id: 'u3', name: 'Cara', kind: 'known', color: '#333' });
    reply.set('text', 'A background reply.');
    reply.set('ts', Date.now());
    comments.push([reply]);
  }

  it('keeps a folded question’s answer, caret and focus when another thread gets a reply, is resolved, or is created', async () => {
    const { ydoc, threadAt, margin } = mountDoc();
    // The balloons only: the editor also carries inline copies of each card.
    const column = margin.marginEl;
    threadAt(1, 7, 'q1');
    threadAt(8, 15, 't2');
    threadAt(16, 24, 't3');
    setCommentReview(ydoc, 'q1', 'q1-c1', { shape: 'review', headline: 'Which apples to stock?' });
    margin.relayout();

    const events: Array<[string, () => void]> = [
      ['a reply on another thread', () => replyOn(ydoc, 't2')],
      [
        'another thread resolved',
        () => (ydoc.getMap('threads').get('t3') as Y.Map<unknown>).set('status', 'resolved'),
      ],
      ['a new thread', () => threadAt(25, 31, 't4')],
    ];
    for (const [what, happen] of events) {
      const input = answerField(column, 'q1');
      if (!input) throw new Error(`no answer field before ${what}`);
      typeInto(input);
      happen();
      await new Promise((r) => setTimeout(r, 0));
      margin.relayout();
      expectKept(input, answerField(column, 'q1'), what);
      // Clear it so the next event starts from a fresh draft.
      (answerField(column, 'q1') as HTMLInputElement).value = '';
    }
  });
});

let seq = 1_700_000_000_000;
function comment(author: User, text: string): Comment {
  seq += 1000;
  return { id: `c${seq}`, author, text, ts: seq };
}

function thread(id: string, comments: Comment[]): Thread {
  return {
    id,
    status: 'open',
    anchor: {
      kind: 'text-range',
      startRel: new Uint8Array(),
      endRel: new Uint8Array(),
      snippet: { text: `the snippet for ${id}` },
    } as Thread['anchor'],
    createdBy: comments[0]?.author ?? alice,
    commentCount: comments.length,
    lastActivity: comments[comments.length - 1]?.ts ?? seq,
    comments,
  };
}

const question = (id: string): Thread =>
  thread(id, [
    {
      ...comment(bob, 'Which apples?'),
      review: { shape: 'review', headline: 'Which apples to stock?' },
    },
  ]);

const withReply = (t: Thread): Thread => {
  const c = comment(bob, 'a background reply');
  return {
    ...t,
    comments: [...t.comments, c],
    commentCount: t.commentCount + 1,
    lastActivity: c.ts,
  };
};

function mountPanel(container: HTMLElement): ThreadPanel {
  return new ThreadPanel({
    container,
    currentUser: alice,
    onThreadClick: () => {},
    onReply: () => {},
    onResolve: () => {},
    onReopen: () => {},
    onReanchor: () => {},
  });
}

describe('the comments drawer', () => {
  it('keeps a question’s answer, caret and focus when another thread gets a reply', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = mountPanel(container);
    const q1 = question('q1');
    const t2 = thread('t2', [comment(bob, 'second thread')]);
    panel.setThreads([q1, t2]);

    const input = answerField(container, 'q1');
    if (!input) throw new Error('no answer field rendered');
    typeInto(input);
    panel.setThreads([q1, withReply(t2)]);
    expectKept(input, answerField(container, 'q1'));
  });
});

describe('the inline cards below 1100px', () => {
  it('keeps a question’s answer, caret and focus when its own card is rebuilt', () => {
    document.body.innerHTML = '<div id="editor"></div><div id="threads-list"></div>';
    const editor = document.getElementById('editor') as HTMLElement;
    const panel = mountPanel(document.getElementById('threads-list') as HTMLElement);
    let threads = [question('q1')];
    let placed: InlineThreadCard[] = [];
    const mobile = mountMobileReview({
      inlineVisible: () => true,
      threads: () => threads,
      resolveRange: () => ({ from: 1, to: 5 }),
      renderCard: (t, pending) => panel.renderThread(t, pending),
      surface: {
        // A real surface swaps the widgets in; this one does the same.
        setInlineCards: (cards) => {
          for (const c of placed) c.el.remove();
          placed = cards;
          for (const c of cards) editor.appendChild(c.el);
        },
        scrollToPos: () => {},
      },
      setActive: (id) => panel.setActive(id),
      revealInSheet: (id) => panel.revealThread(id),
      openSheet: () => {},
      closeSheet: () => {},
      isSheetOpen: () => false,
    });
    mobile.refresh();

    const input = answerField(editor, 'q1');
    if (!input) throw new Error('no answer field rendered');
    typeInto(input);
    // A reply that is not the answer changes the card's key, so it rebuilds.
    threads = [withReply(threads[0] as Thread)];
    mobile.refresh();
    expectKept(input, answerField(editor, 'q1'));
  });
});
