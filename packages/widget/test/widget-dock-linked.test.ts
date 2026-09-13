import type { ReviewPayload } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLinkedItems } from '../src/widget-dock.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * A TICKET review item that links this page, docked and answered here.
 *
 * The server writes the items into the page as a JSON block
 * (`mockup-linked-items.ts`); the widget reads it once. These drive the real
 * element: the bar carries the ticket's ask, a tap answers it through the
 * ticket's own route, and the dock clears without the page moving.
 *
 * Fixtures are fictional — a lemonade stand.
 */

const T0 = 1_700_000_000_000;

const ASK: ReviewPayload = {
  shape: 'decision',
  headline: 'Which price board ships?',
  detail: 'Two boards on the mock.',
  options: [
    { id: 'o-chalk', label: 'Chalkboard' },
    { id: 'o-print', label: 'Printed' },
  ],
};

function linkedBlock(items: unknown[]): string {
  return `<script type="application/json" data-cw-linked-items>${JSON.stringify(items)}</script>`;
}

const LINKED = { taskId: 't-stand', reviewItemId: 'r-board', review: ASK, by: 'Lead Agent', ts: T0 };

interface Mounted {
  el: FeedbackWidgetEl;
  posts: Array<{ url: string; body: Record<string, unknown> }>;
}

async function mountWidget(docId: string, answerStatus = 200): Promise<Mounted> {
  const posts: Mounted['posts'] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = (async (
    url: string,
    init?: RequestInit,
  ) => {
    if (init?.method === 'POST') {
      posts.push({ url: String(url), body: JSON.parse(String(init.body ?? '{}')) });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: String(url).endsWith('/answer') ? answerStatus : 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  class FakeWS {
    static OPEN = 1;
    readyState = 1;
    binaryType = 'arraybuffer';
    addEventListener(): void {}
    removeEventListener(): void {}
    send(): void {}
    close(): void {}
  }
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;
  const mod = await import('../src/widget.ts');
  const el = mod.FeedbackWidget.init({ workspaceId: 'w-stand', docId, user: 'reviewer' });
  return { el, posts };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

const q = (el: FeedbackWidgetEl, sel: string): HTMLElement | null =>
  el.shadow.querySelector(sel) as HTMLElement | null;

describe('reading the linked items off the page', () => {
  it('reads the block, and nothing from a page without one or with a broken one', () => {
    document.body.innerHTML = linkedBlock([LINKED]);
    const items = readLinkedItems(document);
    expect(items.map((i) => [i.taskId, i.threadId, i.review.headline])).toEqual([
      ['t-stand', 'r-board', 'Which price board ships?'],
    ]);
    document.body.innerHTML = '<main></main>';
    expect(readLinkedItems(document)).toEqual([]);
    document.body.innerHTML =
      '<script type="application/json" data-cw-linked-items>{not json</script>';
    expect(readLinkedItems(document)).toEqual([]);
  });
});

describe('a linked ticket item in the dock', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/');
  });
  afterEach(() => {
    document.querySelectorAll('claude-feedback-widget').forEach((el) => el.remove());
    document.querySelectorAll('.cfw-overlay, #cfw-light-styles').forEach((el) => el.remove());
    document.body.innerHTML = '';
  });

  it('docks the ticket ask, answers it through the ticket route, and clears', async () => {
    document.body.innerHTML = `<main>Price board</main>${linkedBlock([LINKED])}`;
    const { el, posts } = await mountWidget('d-board');
    el.renderThreads();
    expect(q(el, '.cw-dock-text')?.textContent).toContain('Which price board ships?');

    (q(el, '.cw-dock-item') as HTMLButtonElement).click();
    (q(el, '.cw-answer-opt') as HTMLButtonElement).click();
    await settle();

    const answer = posts.find((p) => p.url.endsWith('/answer'));
    expect(answer?.url).toContain('/workspaces/w-stand/tasks/t-stand/review-items/r-board/answer');
    expect(answer?.body.text).toBe('Chalkboard');
    expect(answer?.body.answeredWith).toBe('o-chalk');
    // The ticket route's contract: no doc-thread `commentId` rides along.
    expect(answer?.body.commentId).toBeUndefined();

    el.renderThreads();
    expect(q(el, '.cw-modal'), 'an accepted answer closes the item').toBeNull();
    expect(q(el, '.cw-dock'), 'and the dock clears').toBeNull();
  });

  it('CONTROL: a page with no linked block shows no dock', async () => {
    document.body.innerHTML = '<main>Menu card</main>';
    const { el } = await mountWidget('d-menu');
    el.renderThreads();
    expect(q(el, '.cw-dock')).toBeNull();
  });

  it('CONTROL: a refused answer keeps the ask docked', async () => {
    document.body.innerHTML = `<main>Price board</main>${linkedBlock([LINKED])}`;
    const { el } = await mountWidget('d-refused', 500);
    el.renderThreads();
    (q(el, '.cw-dock-item') as HTMLButtonElement).click();
    (q(el, '.cw-answer-opt') as HTMLButtonElement).click();
    await settle();
    el.renderThreads();
    expect(q(el, '.cw-modal')).toBeTruthy();
    expect(q(el, '.cw-dock')).toBeTruthy();
  });
});
