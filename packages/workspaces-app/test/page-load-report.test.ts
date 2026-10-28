import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { docPageType } from '../src/doc/doc-load-report.ts';
import {
  PAGE_LOAD_DEADLINE_MS,
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
