import type { Comment, Thread, User } from '@claude-workspaces/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { ComposerEditorModule } from '../src/md-composer.ts';
import { setComposerEditorLoader } from '../src/md-composer.ts';
import { MountScope } from '../src/mount-scope.ts';
import { type ChromeOpts, mountReviewChrome } from '../src/review-chrome.ts';
import type { ReviewSurface } from '../src/review-surface.ts';
import { ThreadPanel, type ThreadPanelOpts } from '../src/threads.ts';

/**
 * A comment that did not reach the server says so, on the comment.
 *
 * Reported 15 September 2026: a comment left on a board was answered by
 * nobody and was afterwards on no board. Every composer already put the words
 * back in the box when a post was refused, and said so in a toast that was
 * gone seconds later — or, on the plain reply path, said nothing whatever. So
 * the surviving evidence was a box holding a sentence, which is exactly what
 * a comment somebody never sent looks like.
 *
 * These drive each composer against a transport that refuses, and assert the
 * draft is kept AND the state is on the card: `.not-sent`, carrying the retry.
 */

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };

let ts = 1_700_000_000_000;
function comment(text: string): Comment {
  ts += 1000;
  return { id: `c${ts}`, author: alice, text, ts };
}

function makeThread(id: string): Thread {
  const comments = [comment('the first word')];
  return {
    id,
    comments,
    status: 'open',
    anchor: { kind: 'element', fingerprint: undefined as never, snippet: { text: 'the anchor' } },
    commentCount: comments.length,
    lastActivity: comments[0]?.ts ?? ts,
    createdBy: alice,
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  setComposerEditorLoader(null);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** The composer chunk never lands, so the plain textarea is the surface —
 *  the state a slow network leaves every box in, and the one a test can type
 *  into without a ProseMirror. */
function plainComposers(): void {
  setComposerEditorLoader(() => new Promise<ComposerEditorModule>(() => {}));
}

function mountPanel(over: Partial<ThreadPanelOpts> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  cleanups.push(() => container.remove());
  const panel = new ThreadPanel({
    container,
    currentUser: alice,
    onThreadClick: () => {},
    onReply: () => {},
    onResolve: () => {},
    onReopen: () => {},
    onReanchor: () => {},
    ...over,
  });
  return { panel, container };
}

const notSent = (root: ParentNode) => root.querySelector<HTMLElement>('.not-sent');
const retryButton = (root: ParentNode) => root.querySelector<HTMLButtonElement>('.not-sent-retry');
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("a doc reply the server refused says so on the card it's in", () => {
  async function refusedReply(reply: () => Promise<boolean>) {
    plainComposers();
    const calls: string[] = [];
    const { panel, container } = mountPanel({
      onReply: (_id, text) => {
        calls.push(text);
        return reply();
      },
    });
    panel.setThreads([makeThread('t1')]);
    panel.setActive('t1');
    const ta = container.querySelector<HTMLTextAreaElement>('.thread textarea');
    if (!ta) throw new Error('no reply box rendered');
    ta.value = 'Did this reach anyone?';
    container.querySelector<HTMLButtonElement>('.thread-actions button.primary')?.click();
    await flush();
    return { calls, container, ta };
  }

  it('keeps the words and shows the retry when the post resolves false', async () => {
    const { container, ta } = await refusedReply(() => Promise.resolve(false));
    expect(ta.value, 'the draft was not handed back').toBe('Did this reach anyone?');
    expect(notSent(container), 'nothing on the card said the reply never went').not.toBeNull();
    expect(retryButton(container)?.textContent).toContain('Not sent');
  });

  it('says the same thing when the transport rejects outright', async () => {
    const { container, ta } = await refusedReply(() => Promise.reject(new Error('offline')));
    expect(ta.value).toBe('Did this reach anyone?');
    expect(notSent(container)).not.toBeNull();
  });

  it('the retry posts the same words again', async () => {
    const { calls, container } = await refusedReply(() => Promise.resolve(false));
    expect(calls).toEqual(['Did this reach anyone?']);
    retryButton(container)?.click();
    await flush();
    expect(calls).toEqual(['Did this reach anyone?', 'Did this reach anyone?']);
  });

  it('a reply that lands leaves no "not sent" standing', async () => {
    plainComposers();
    let ok = false;
    const { panel, container } = mountPanel({ onReply: () => Promise.resolve(ok) });
    panel.setThreads([makeThread('t1')]);
    panel.setActive('t1');
    const ta = container.querySelector<HTMLTextAreaElement>('.thread textarea');
    if (!ta) throw new Error('no reply box rendered');
    const send = () =>
      container.querySelector<HTMLButtonElement>('.thread-actions button.primary')?.click();
    ta.value = 'first try';
    send();
    await flush();
    expect(notSent(container), 'positive control: the refusal was shown').not.toBeNull();
    ok = true;
    retryButton(container)?.click();
    await flush();
    expect(notSent(container)).toBeNull();
  });

  it('the retry sends the words that FAILED, not a sentence typed since', async () => {
    // A slow refusal while the reader has already started the next comment.
    // The retry has to mean the one that did not go: the new words are still
    // theirs to send, and the failed ones are not recoverable anywhere else.
    plainComposers();
    const calls: string[] = [];
    let refuse: (ok: boolean) => void = () => {};
    const { panel, container } = mountPanel({
      onReply: (_id, text) => {
        calls.push(text);
        return new Promise<boolean>((resolve) => {
          refuse = resolve;
        });
      },
    });
    panel.setThreads([makeThread('t1')]);
    panel.setActive('t1');
    const ta = container.querySelector<HTMLTextAreaElement>('.thread textarea');
    if (!ta) throw new Error('no reply box rendered');
    ta.value = 'the one that failed';
    container.querySelector<HTMLButtonElement>('.thread-actions button.primary')?.click();
    await flush();
    // The reader moves on while the first is still in flight.
    ta.value = 'a sentence typed since';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    refuse(false);
    await flush();
    expect(ta.value, 'the newer draft was taken away').toBe('a sentence typed since');
    retryButton(container)?.click();
    await flush();
    expect(calls).toEqual(['the one that failed', 'the one that failed']);
    expect(ta.value, 'the retry emptied a box it was not sending').toBe('a sentence typed since');
  });

  it('typing again retires the state — those words are not the ones that failed', async () => {
    const { container, ta } = await refusedReply(() => Promise.resolve(false));
    expect(notSent(container)).not.toBeNull();
    ta.value = 'something else entirely';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(notSent(container)).toBeNull();
  });
});

// ── the new-comment composer on the doc ────────────────────────────────────

function chromeDom(): void {
  document.body.innerHTML = `
    <div id="shell">
      <main id="main">
        <section id="editor-pane"><div id="editor"></div></section>
        <aside id="threads-pane">
          <div class="threads-tabs"><button class="tab active" data-tab="open">Open</button></div>
          <ol id="threads-list"></ol>
        </aside>
      </main>
      <button id="toggle-threads">☰</button>
      <span id="threads-count"></span>
      <button id="close-threads">×</button>
      <div id="threads-scrim"></div>
      <div id="doc-title"></div>
      <div id="composer" class="hidden">
        <div id="composer-quote" class="composer-quote"></div>
        <div class="composer-inner">
          <div id="composer-avatar" class="composer-avatar"></div>
          <textarea id="composer-text" rows="1"></textarea>
          <button id="composer-submit">↑</button>
        </div>
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
}

function chromeOpts(): ChromeOpts {
  const surface: ReviewSurface = {
    getSelectionRel: () => null,
    resolveRel: () => null,
    scrollToPos: () => {},
    pulseRange: () => {},
    setThreadRanges: () => {},
    destroy: () => {},
  };
  return {
    docId: 'd1',
    user: alice,
    ydoc: new Y.Doc(),
    surface,
    whenSynced: (cb: () => void) => cb(),
    canWrite: true,
    selectHint: 'Select some text first',
    reanchorHint: '',
    getSelection: () => ({
      start: new Uint8Array([1]),
      end: new Uint8Array([2]),
      snippet: 'the anchored words',
    }),
    scope: new MountScope(),
  };
}

describe('a new comment the server refused stays sayable', () => {
  it('leaves the words in the open composer and shows the retry', async () => {
    plainComposers();
    const posts: string[] = [];
    vi.stubGlobal('fetch', (_url: unknown, init?: RequestInit) => {
      posts.push(String(init?.body ?? ''));
      return Promise.reject(new Error('offline'));
    });
    chromeDom();
    const chrome = mountReviewChrome(chromeOpts());
    cleanups.push(() => chrome.destroy?.());
    chrome.openComposer();
    const ta = document.getElementById('composer-text') as HTMLTextAreaElement;
    ta.value = 'Please look at this.';
    document
      .getElementById('composer-submit')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flush();
    const composer = document.getElementById('composer') as HTMLElement;
    expect(composer.classList.contains('hidden'), 'the box was closed over a failure').toBe(false);
    expect(ta.value).toBe('Please look at this.');
    expect(notSent(composer)).not.toBeNull();
    expect(posts).toHaveLength(1);
  });
});
