/**
 * What one page open costs the server, counted at the page.
 *
 * Both cases here were measured over CDP against a staging server before they
 * were written (board Home and the board page, 1180x820 and 430, five opens
 * each): `GET /api/calendar/events` went out twice on every single open, and
 * `POST /workspaces/<ws>/links:titles` went out two or three times carrying an
 * identical URL list. Sentry's browser project filed the pair as one N+1
 * group. These drive the real shell and the real hydration scheduler and count
 * requests, because a page that asks twice is not a shape a unit test of
 * either module can see — each module was behaving correctly on its own.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildShell } from '../src/board/board-shell.ts';
import { CALENDAR_EVENTS_URL, _resetCalendarEventsForTest } from '../src/calendar-events-source.ts';
import { renderCommentMarkdown } from '../src/comment-markdown.ts';
import { _resetLinkTitlesForTest, hydrateLinkTitles } from '../src/link-titles.ts';

/** Every request the page made, in order, with the body a POST carried. */
interface Recorded {
  url: string;
  body: string | null;
}

function recorder(answer: (url: string) => unknown = () => ({ events: [] })) {
  const calls: Recorded[] = [];
  const fetcher = (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body === undefined ? null : String(init.body) });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(answer(url)),
    } as unknown as Response);
  };
  return { calls, fetcher };
}

const urlsOf = (calls: readonly Recorded[], match: string) =>
  calls.filter((c) => c.url.includes(match));

beforeEach(() => {
  _resetCalendarEventsForTest();
  _resetLinkTitlesForTest();
  document.body.innerHTML = '';
});

describe('a board open', () => {
  it('reads the calendar once, though the shell mounts a banner in each pane', async () => {
    const { calls, fetcher } = recorder();
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetcher as typeof fetch;
    try {
      const root = document.createElement('div');
      document.body.append(root);
      buildShell(document, root, 'Harborlight', 'w-shell1');
      // Both banners are in the tree — the fix must not be "mount one".
      expect(root.querySelectorAll('meeting-banner').length).toBe(2);
      // Let every connectedCallback's read settle.
      await new Promise((r) => setTimeout(r, 0));
      expect(urlsOf(calls, CALENDAR_EVENTS_URL).length).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('link-title hydration', () => {
  it('posts one lookup when a second pass starts before the first has landed', async () => {
    const { calls, fetcher } = recorder(() => ({ titles: {}, statuses: {}, planHeld: {} }));
    const host = document.createElement('div');
    host.innerHTML = renderCommentMarkdown(`${location.origin}/workspaces/w-abc123?task=t-one`);
    document.body.append(host);
    expect(host.querySelectorAll('a[data-ws-link][data-ws-pending]').length).toBe(1);

    // Two passes over the same document, neither awaited before the other
    // starts — the board's own shape, where a second region renders while the
    // first pass's POST is still out.
    await Promise.all([hydrateLinkTitles(document, fetcher), hydrateLinkTitles(document, fetcher)]);

    const lookups = urlsOf(calls, 'links:titles');
    expect(lookups.length).toBe(1);
    expect(JSON.parse(String(lookups[0]?.body)).urls.length).toBe(1);
  });

  it('asks again on a later pass, so a released URL is not cached by the dedupe', async () => {
    const { calls, fetcher } = recorder(() => ({ titles: {}, statuses: {}, planHeld: {} }));
    const url = `${location.origin}/workspaces/w-abc123?task=t-two`;
    // A failed round leaves nothing cached, so the next pass must go out
    // again — the dedupe releases the URL however the round ended.
    const failing = () => Promise.resolve({ ok: false, status: 500 } as unknown as Response);
    const host = document.createElement('div');
    host.innerHTML = renderCommentMarkdown(url);
    document.body.append(host);
    await hydrateLinkTitles(document, failing);
    await hydrateLinkTitles(document, fetcher);
    expect(urlsOf(calls, 'links:titles').length).toBe(1);
  });
});
