import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { docPageType } from '../src/doc/doc-load-report.ts';
import {
  PAGE_LOAD_DEADLINE_MS,
  createHiddenClock,
  loadReportUrl,
  startPageLoadReport,
} from '../src/page-load-report.ts';

/**
 * Every page's load report: one per load, sent at the content or at the
 * deadline without it, to the page's board or — for Home and the review
 * page — to the route for pages on no board.
 */
type Call = { url: string; body: Record<string, unknown> };
let calls: Call[];

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return Promise.resolve(new Response('{}'));
  });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('where a report goes', () => {
  it('to its board, or to the route for pages on no board', () => {
    expect(loadReportUrl('w 1')).toBe('/workspaces/w%201/load-reports');
    expect(loadReportUrl(null)).toBe('/api/load-reports');
  });
});

describe('one report per page load', () => {
  it('names the page and its content time, once, however often content is shown', () => {
    const r = startPageLoadReport({ page: 'review', workspaceId: null });
    r.contentShown();
    r.contentShown();
    vi.advanceTimersByTime(PAGE_LOAD_DEADLINE_MS + 1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/load-reports');
    expect(calls[0]?.body.page).toBe('review');
    expect(typeof calls[0]?.body.msToContent).toBe('number');
    expect(typeof calls[0]?.body.msToBoot).toBe('number');
  });

  it('reports at the deadline with the content absent, rather than nothing', () => {
    startPageLoadReport({ page: 'doc', workspaceId: 'w-1' });
    vi.advanceTimersByTime(PAGE_LOAD_DEADLINE_MS - 1);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/workspaces/w-1/load-reports');
    expect('msToContent' in (calls[0]?.body ?? {})).toBe(false);
  });

  it('carries the page type it was renamed to', () => {
    const r = startPageLoadReport({ page: 'doc', workspaceId: 'w-1' });
    r.setPage('diff');
    r.contentShown();
    vi.advanceTimersByTime(20);
    expect(calls[0]?.body.page).toBe('diff');
  });
});

describe('which page a document is', () => {
  it('a diff member is a diff, a set member a folder, the rest a doc', () => {
    expect(docPageType({ docType: 'diff', workspaceId: 'rev-1' })).toBe('diff');
    expect(docPageType({ docType: 'code', workspaceId: 'tree-1' })).toBe('folder');
    expect(docPageType({ docType: 'markdown', workspaceId: 'tree-1' })).toBe('folder');
    expect(docPageType({ docType: 'markdown', workspaceId: '' })).toBe('doc');
  });
});

/**
 * A hidden tab paints no frame and `performance.now()` keeps counting, so a
 * page hidden between its script and its next frame used to report the whole
 * time it sat in the background as its load. These cases drive the page's
 * visibility and a frame queue that, like a browser's, does not run while
 * the page is hidden.
 */
describe('time the page spent hidden', () => {
  let clock: number;
  let state: DocumentVisibilityState;
  let frames: FrameRequestCallback[];
  const setVisibility = (next: DocumentVisibilityState) => {
    state = next;
    document.dispatchEvent(new Event('visibilitychange'));
    if (next === 'visible') for (const cb of frames.splice(0)) cb(clock);
  };

  beforeEach(() => {
    clock = 100;
    state = 'visible';
    frames = [];
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      if (state === 'visible') for (const f of frames.splice(0)) f(clock);
      return 1;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a tab backgrounded before its first frame is marked, with the hidden ms', () => {
    const hidden = createHiddenClock(document, () => clock);
    // contentShown runs while visible, but the page is hidden before the
    // frame it waits for: the browser defers the frame until it is shown.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return 1;
    });
    const r = startPageLoadReport({ page: 'home', workspaceId: null, hidden });
    r.contentShown();
    setVisibility('hidden');
    clock += 19_000;
    setVisibility('visible');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.msToContent).toBe(19_100);
    expect(calls[0]?.body.hidden).toBe(true);
    expect(calls[0]?.body.hiddenMs).toBe(19_000);
  });

  it('a page still hidden when its script runs is marked', () => {
    state = 'hidden';
    const hidden = createHiddenClock(document, () => clock);
    const r = startPageLoadReport({ page: 'review', workspaceId: null, hidden });
    clock += 5_000;
    setVisibility('visible');
    r.contentShown();
    expect(calls[0]?.body.hidden).toBe(true);
    expect(calls[0]?.body.hiddenMs).toBe(5_000);
  });

  it('a page that was never hidden carries no hidden fields', () => {
    const hidden = createHiddenClock(document, () => clock);
    const r = startPageLoadReport({ page: 'home', workspaceId: null, hidden });
    clock += 40;
    r.contentShown();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.msToContent).toBe(140);
    expect('hidden' in (calls[0]?.body ?? {})).toBe(false);
    expect('hiddenMs' in (calls[0]?.body ?? {})).toBe(false);
  });

  it('a deadline report from a page hidden the whole time is marked', () => {
    const hidden = createHiddenClock(document, () => clock);
    startPageLoadReport({ page: 'doc', workspaceId: 'w-1', hidden });
    setVisibility('hidden');
    clock += PAGE_LOAD_DEADLINE_MS;
    vi.advanceTimersByTime(PAGE_LOAD_DEADLINE_MS + 1);
    expect(calls[0]?.body.hidden).toBe(true);
    expect(calls[0]?.body.hiddenMs).toBe(PAGE_LOAD_DEADLINE_MS);
    expect('msToContent' in (calls[0]?.body ?? {})).toBe(false);
  });
});
