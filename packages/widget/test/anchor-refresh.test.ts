import { createAnchor } from '@claude-workspaces/core/anchor/element';
import type { Thread } from '@claude-workspaces/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pauseAnchorRefresh, refreshAnchors } from '../src/widget-anchor-refresh.ts';
import type { ThreadRow } from '../src/widget-threads.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * Which pinned elements a page reports to the server, and how.
 *
 * Driven over a happy-dom page with `fetch` stubbed: a thread's anchor is made
 * on one version of the page, the page is changed, and the test hands
 * `refreshAnchors` the row a render would. The real browser run over three
 * rounds is `pins-rewrite.test.ts`. All fixtures invented.
 */

const widget = {
  opts: { serverUrl: 'ws://board.test:8787', workspaceId: 'w-tide', docId: 'd-report' },
  currentContext: { url: '/report' },
  authToken: null,
} as unknown as FeedbackWidgetEl;

let posts: Array<{
  url: string;
  body: { anchor: { fingerprint: { text: string } }; refresh: boolean };
}>;

beforeEach(() => {
  posts = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init.body)) });
    return new Response('{}');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  pauseAnchorRefresh(false);
});

/** A thread made on the element `pick` finds in `before`, and the row a
 *  render of `after` would hand over with `found` as its element. */
function rowAfter(
  id: string,
  before: string,
  pick: string,
  after: string,
  found: (d: Document) => Element | null = (d) => d.querySelector(pick),
): ThreadRow {
  document.body.innerHTML = before;
  const anchor = {
    ...createAnchor(document.querySelector(pick) as HTMLElement),
    context: { url: '/report' },
  };
  const thread = { id, anchor, status: 'open', comments: [] } as unknown as Thread;
  document.body.innerHTML = after;
  return { thread, status: 'open', el: found(document) as HTMLElement | null };
}

describe('refreshAnchors', () => {
  it("reports an element whose words changed a little, once, to the thread's reanchor", () => {
    const row = rowAfter(
      't-heading',
      '<main><h3>Riverbend high water by month</h3></main>',
      'h3',
      '<main><p>New.</p><h3>Riverbend high water by calendar month</h3></main>',
    );
    refreshAnchors(widget, [row]);
    refreshAnchors(widget, [row]);
    expect(posts.map((p) => [p.url, p.body.refresh, p.body.anchor.fingerprint.text])).toEqual([
      [
        'http://board.test:8787/workspaces/w-tide/docs/d-report/threads/t-heading/reanchor',
        true,
        'Riverbend high water by calendar month',
      ],
    ]);
  });

  it('reports nothing for an element that says what its anchor holds', () => {
    const page = '<main><h3>Riverbend high water by month</h3></main>';
    refreshAnchors(widget, [rowAfter('t-same', page, 'h3', page)]);
    expect(posts).toEqual([]);
  });

  it('reports nothing when another element of its tag is as close', () => {
    const row = rowAfter(
      't-tie',
      '<ul><li>Riverbend gauge reads high today</li></ul>',
      'li',
      '<ul><li>Riverbend gauge reads low today</li><li>Riverbend gauge reads level today</li></ul>',
    );
    // CONTROL: the row names an element, as a render that pinned it would.
    expect(row.el?.textContent).toBe('Riverbend gauge reads low today');
    refreshAnchors(widget, [row]);
    expect(posts).toEqual([]);
  });

  it('reports nothing for an element saying under half of the words', () => {
    const row = rowAfter(
      't-far',
      '<main><h3 id="tides">Riverbend high water by month</h3></main>',
      'h3',
      '<main><h3 id="tides">Harborlight low tide in June</h3></main>',
    );
    refreshAnchors(widget, [row]);
    expect(posts).toEqual([]);
  });

  it('reports nothing on another view of the page, or while an older round is shown', () => {
    const row = rowAfter(
      't-held',
      '<main><h3>Riverbend high water by month</h3></main>',
      'h3',
      '<main><h3>Riverbend high water by calendar month</h3></main>',
    );
    const elsewhere = { ...widget, currentContext: { url: '/report', view: 'chart' } };
    const moved = {
      ...row,
      thread: {
        ...row.thread,
        anchor: { ...row.thread.anchor, context: { url: '/report', view: 'table' } },
      },
    } as ThreadRow;
    refreshAnchors(elsewhere as FeedbackWidgetEl, [moved]);
    pauseAnchorRefresh(true);
    refreshAnchors(widget, [row]);
    expect(posts).toEqual([]);
    // CONTROL: the same row, with the newest round back on screen.
    pauseAnchorRefresh(false);
    refreshAnchors(widget, [row]);
    expect(posts).toHaveLength(1);
  });
});
