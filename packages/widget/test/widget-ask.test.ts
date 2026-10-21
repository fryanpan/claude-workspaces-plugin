import type { ReviewPayload, User } from '@claude-workspaces/core';
import { createThread, postReply } from '@claude-workspaces/core';
import { createAnchor } from '@claude-workspaces/core/anchor/element';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountAsks } from '../src/widget-ask.ts';
import { mountPageList } from '../src/widget-page-list.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * A thread's review item, answered in the thread's popover on the page.
 *
 * The case that matters is a reader's comment that an agent ANSWERED with an
 * ask (`post_reply` with a `review` payload). The real widget is mounted into
 * happy-dom, the thread written into its own Yjs doc the way a sync would,
 * and the reader's taps are driven: the row, then an option. The answer is
 * read off the REQUEST the widget made, because answered is a fact on the
 * server. Date is the only faked clock; nothing here sleeps.
 *
 * Fixtures are invented: the Harborlight and Riverbend stands.
 */

const T0 = Date.UTC(2026, 9, 8, 9, 0, 0);

const AGENT: User = { id: 'agent-riverbend', name: 'Riverbend', kind: 'known', color: '#888888' };
const ALICE: User = { id: 'known-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' };

function decision(over: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    shape: 'decision',
    headline: 'Which price does the Harborlight stand open with?',
    detail: 'Both are drawn on [the price board](/workspaces/w-1/docs/d-board).',
    options: [
      { id: 'o-75', label: 'Open at 75c' },
      { id: 'o-50', label: 'Keep 50c' },
    ],
    ...over,
  };
}

interface Mounted {
  el: FeedbackWidgetEl;
  posts: Array<{ url: string; body: Record<string, unknown> }>;
}

async function mountWidget(docId: string): Promise<Mounted> {
  const posts: Mounted['posts'] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = (async (
    url: string,
    init?: RequestInit,
  ) => {
    if (init?.method === 'POST') {
      posts.push({ url: String(url), body: JSON.parse(String(init.body ?? '{}')) });
    }
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  class FakeWS {
    static OPEN = 1;
    readyState = 1;
    addEventListener(): void {}
    removeEventListener(): void {}
    send(): void {}
    close(): void {}
  }
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;
  const mod = await import('../src/widget.ts');
  const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId, user: 'alice' });
  mountAsks(el);
  // The panel's rows are the page list's, mounted beside the asks in mic.js.
  mountPageList(el);
  return { el, posts };
}

/** Alice's comment, and the agent's reply carrying the ask. */
function seedAnsweredComment(
  el: FeedbackWidgetEl,
  threadId: string,
  review: ReviewPayload,
  anchorEl?: HTMLElement,
): void {
  const doc = el.client?.ydoc;
  if (!doc) throw new Error('widget has no doc to seed');
  createThread(doc, {
    threadId,
    anchor: anchorEl ? createAnchor(anchorEl) : { kind: 'subject' },
    createdBy: ALICE,
    firstComment: { id: `${threadId}-c1`, text: 'Is 75c too much?' },
  });
  vi.setSystemTime(T0 + 60_000);
  postReply(doc, threadId, { id: `${threadId}-c2`, author: AGENT, text: 'Priced it.', review });
}

/**
 * Run a full garbage collection now. happy-dom up to 20.11.1 held every
 * MutationObserver callback through a WeakRef alone, so the first collection
 * silently stopped `mountAsks` hearing its rows: CI failed this file on a
 * loaded runner, where a collection happened to land mid-case. Forcing one
 * makes that a failure on every run rather than an occasional one.
 */
function collectGarbage(): void {
  setFlagsFromString('--expose-gc');
  (runInNewContext('gc') as () => void)();
}

/** Let observers, the click handler's fetch and its await settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

const q = (el: FeedbackWidgetEl, sel: string): HTMLElement | null =>
  el.shadow.querySelector(sel) as HTMLElement | null;

/** Tap the thread's row in the panel, which opens its popover. */
async function openRow(el: FeedbackWidgetEl, threadId: string): Promise<HTMLElement | null> {
  el.renderThreads();
  await settle();
  q(el, `.thread[data-thread-id="${threadId}"]`)?.click();
  await settle();
  return q(el, '.thread-popover');
}

describe('a thread whose reply carries an ask, in its popover', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    document.body.innerHTML = '<main><button id="price">75c a cup</button></main>';
    history.replaceState(null, '', '/');
  });
  afterEach(() => {
    vi.useRealTimers();
    document.querySelectorAll('claude-feedback-widget').forEach((n) => n.remove());
    document.querySelectorAll('.cfw-overlay, #cfw-light-styles').forEach((n) => n.remove());
  });

  it('shows a decision: the headline, the detail with its link, one button per option', async () => {
    const { el } = await mountWidget('d-ask-1');
    seedAnsweredComment(el, 'th-1', decision());
    const pop = await openRow(el, 'th-1');
    const ask = pop?.querySelector('.cw-ask');
    expect(ask, 'the popover should carry the ask').toBeTruthy();
    expect(ask?.querySelector('.cw-round-headline')?.textContent).toBe(
      'Which price does the Harborlight stand open with?',
    );
    const link = ask?.querySelector('.cw-round-body a') as HTMLAnchorElement | null;
    expect(link?.textContent).toBe('the price board');
    expect(link?.getAttribute('href')).toBe('/workspaces/w-1/docs/d-board');
    const buttons = Array.from(ask?.querySelectorAll('.cw-answer-opt') ?? []).map(
      (b) => b.textContent,
    );
    expect(buttons).toEqual(['Open at 75c', 'Keep 50c']);
  });

  it('CONTROL: a thread with no ask gets no block', async () => {
    const { el } = await mountWidget('d-ask-plain');
    const doc = el.client?.ydoc;
    if (!doc) throw new Error('no doc');
    createThread(doc, {
      threadId: 'th-plain',
      anchor: { kind: 'subject' },
      createdBy: ALICE,
      firstComment: { id: 'c-plain', text: 'Nice stand.' },
    });
    const pop = await openRow(el, 'th-plain');
    expect(pop, 'the popover itself opened').toBeTruthy();
    expect(pop?.querySelector('.cw-ask')).toBeNull();
  });

  it('shows a question as a reply box and no option buttons', async () => {
    const { el } = await mountWidget('d-ask-q');
    seedAnsweredComment(el, 'th-q', {
      shape: 'review',
      headline: 'What should the Riverbend sign say?',
    });
    const ask = (await openRow(el, 'th-q'))?.querySelector('.cw-ask');
    expect(ask?.querySelector('textarea.cw-answer-text')).toBeTruthy();
    expect(ask?.querySelector('.cw-answer-send')?.textContent).toBe('Answer');
    expect(ask?.querySelector('.cw-answer-opt')).toBeNull();
  });

  it('a tapped option answers the item through the thread’s answer route', async () => {
    const { el, posts } = await mountWidget('d-ask-2');
    seedAnsweredComment(el, 'th-2', decision());
    const pop = await openRow(el, 'th-2');
    (pop?.querySelector('.cw-answer-opt') as HTMLButtonElement).click();
    await settle();
    const answer = posts.find((p) => p.url.endsWith('/answer'));
    expect(answer?.url).toContain('/workspaces/w-1/docs/d-ask-2/threads/th-2/answer');
    expect(answer?.body.commentId).toBe('th-2-c2');
    expect(answer?.body.optionId).toBe('o-75');
    expect(answer?.body.text).toBe('Open at 75c');
    // The block says so at once rather than leaving the buttons up.
    expect(pop?.querySelector('.cw-ask .cw-modal-answered')?.textContent).toContain(
      'Answered: Open at 75c',
    );
    expect(pop?.querySelector('.cw-answer-opt')).toBeNull();
  });

  it('a typed answer to a question goes as the words, with no option', async () => {
    const { el, posts } = await mountWidget('d-ask-q2');
    seedAnsweredComment(el, 'th-q2', { shape: 'review', headline: 'Sign text?' });
    const pop = await openRow(el, 'th-q2');
    (pop?.querySelector('.cw-answer-text') as HTMLTextAreaElement).value = 'Fresh at Riverbend';
    (pop?.querySelector('.cw-answer-send') as HTMLButtonElement).click();
    await settle();
    const answer = posts.find((p) => p.url.endsWith('/answer'));
    expect(answer?.body.text).toBe('Fresh at Riverbend');
    expect(answer?.body.optionId).toBeUndefined();
  });
});

describe('what an ask shows as it changes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    document.body.innerHTML = '<main><button id="price">75c a cup</button></main>';
    history.replaceState(null, '', '/');
  });
  afterEach(() => {
    vi.useRealTimers();
    document.querySelectorAll('claude-feedback-widget').forEach((n) => n.remove());
  });

  it('an answered item shows the option picked and nothing to tap', async () => {
    const { el } = await mountWidget('d-ask-3');
    seedAnsweredComment(
      el,
      'th-3',
      decision({
        answeredAt: T0,
        answeredBy: 'Alice',
        answeredWith: 'o-50',
        answerText: 'Keep 50c',
      }),
    );
    const ask = (await openRow(el, 'th-3'))?.querySelector('.cw-ask');
    expect(ask?.querySelector('.cw-modal-answered')?.textContent).toBe('Answered: Keep 50c');
    expect(ask?.querySelector('.cw-answer-opt')).toBeNull();
    expect(ask?.querySelector('textarea')).toBeNull();
  });

  it('a revised item shows its latest words, not the round it replaced', async () => {
    const { el } = await mountWidget('d-ask-4');
    seedAnsweredComment(
      el,
      'th-4',
      decision({
        headline: 'Open at 60c instead?',
        detail: 'Saltmarsh opens at 60c across the road.',
        revisions: [{ at: T0, by: 'Riverbend', headline: 'Open at 75c?', detail: 'First pass.' }],
      }),
    );
    const ask = (await openRow(el, 'th-4'))?.querySelector('.cw-ask');
    expect(ask?.querySelector('.cw-round-headline')?.textContent).toBe('Open at 60c instead?');
    expect(ask?.textContent).toContain('Saltmarsh opens at 60c');
    expect(ask?.textContent).toContain('Round 2');
    expect(ask?.textContent).not.toContain('First pass.');
  });

  it('a HELD item shows nothing to act on', async () => {
    const { el } = await mountWidget('d-ask-5');
    seedAnsweredComment(
      el,
      'th-5',
      decision({ judge: { at: T0, verdict: 'held', reason: 'no stakes named' } }),
    );
    const pop = await openRow(el, 'th-5');
    expect(pop, 'the popover itself opened').toBeTruthy();
    expect(pop?.querySelector('.cw-ask')).toBeNull();
    // CONTROL: the same item with a passing verdict does show, so the line
    // above is about the hold and not about `judge` being present.
    seedAnsweredComment(el, 'th-5b', decision({ judge: { at: T0, verdict: 'ok', reason: '' } }));
    q(el, '.thread-popover')?.remove();
    expect((await openRow(el, 'th-5b'))?.querySelector('.cw-ask')).toBeTruthy();
  });

  it('an owner-only item shows the ask and no way to answer it here', async () => {
    const { el } = await mountWidget('d-ask-6');
    seedAnsweredComment(el, 'th-6', decision({ ownerOnly: true }));
    const ask = (await openRow(el, 'th-6'))?.querySelector('.cw-ask');
    expect(ask?.querySelector('.cw-round-headline')).toBeTruthy();
    expect(ask?.querySelector('.cw-answer-opt')).toBeNull();
    expect(ask?.querySelector('.cw-ask-note')?.textContent).toContain('owner');
  });
});

describe('finding the threads that ask something', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    document.body.innerHTML =
      '<main><button id="a">Harborlight</button><button id="b">Riverbend</button>' +
      '<button id="c">Saltmarsh</button></main>';
    history.replaceState(null, '', '/');
  });
  afterEach(() => {
    vi.useRealTimers();
    document.querySelectorAll('claude-feedback-widget').forEach((n) => n.remove());
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;

  it('marks the row and the pin of an open ask, and of nothing else', async () => {
    const { el } = await mountWidget('d-ask-7');
    await settle();
    collectGarbage();
    seedAnsweredComment(el, 'th-open', decision(), byId('a'));
    seedAnsweredComment(
      el,
      'th-done',
      decision({ answeredAt: T0, answeredWith: 'o-50', answerText: 'Keep 50c' }),
      byId('b'),
    );
    seedAnsweredComment(
      el,
      'th-held',
      decision({ judge: { at: T0, verdict: 'held', reason: 'no stakes named' } }),
      byId('c'),
    );
    el.renderThreads();
    await settle();
    const row = (id: string) => q(el, `.thread[data-thread-id="${id}"]`);
    expect(row('th-open')?.hasAttribute('data-ask')).toBe(true);
    expect(row('th-done')?.hasAttribute('data-ask')).toBe(false);
    expect(row('th-held')?.hasAttribute('data-ask')).toBe(false);
    const pin = (id: string) =>
      el.pinLayer?.querySelector(`.cfw-pin[data-thread-id="${id}"]`) as HTMLElement | null;
    expect(pin('th-open')?.dataset.state).toBe('review');
    expect(pin('th-done')?.dataset.state).toBe('open');
    // The base bundle marks a held ask's pin as one waiting; it is not.
    expect(pin('th-held')?.dataset.state).toBe('open');
  });
});
