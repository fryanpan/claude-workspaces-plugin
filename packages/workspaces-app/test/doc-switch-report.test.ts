import type { FeedbackClient } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDocLoadReport } from '../src/doc/doc-load-report.ts';
import type { MountContext } from '../src/mount-context.ts';
import { MountScope } from '../src/mount-scope.ts';
import { PAGE_LOAD_DEADLINE_MS } from '../src/page-load-report.ts';

/**
 * A file switch inside an open diff is an in-place swap, so the page load
 * report never sees it. Each switch reports for itself, so a slow one shows up
 * without anybody saying so.
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

/** A mount whose sync the test releases. */
function mountOf(docType: string): { ctx: MountContext; sync(): void } {
  let ready: () => void = () => {};
  const client = {
    onReady: (cb: () => void) => {
      ready = cb;
    },
  } as unknown as FeedbackClient;
  const ctx = {
    docType,
    workspaceId: 'review-1',
    scope: new MountScope(),
    client,
  } as unknown as MountContext;
  return { ctx, sync: () => ready() };
}

/** The page's own load, reported and out of the way. */
function loadedPage() {
  const report = startDocLoadReport('w-1');
  const first = mountOf('diff');
  report.mounted(first.ctx);
  first.sync();
  vi.advanceTimersByTime(20);
  calls.length = 0;
  return report;
}

describe('a file switch in a diff', () => {
  it('reports the ms from the click to the new file on screen', () => {
    const report = loadedPage();
    report.navigated();
    vi.advanceTimersByTime(300);
    const next = mountOf('diff');
    report.mounted(next.ctx);
    vi.advanceTimersByTime(200);
    next.sync();
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(20);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/workspaces/w-1/load-reports');
    expect(calls[0]?.body.page).toBe('diff-switch');
    expect(calls[0]?.body.msToContent).toBeGreaterThanOrEqual(516);
    expect(calls[0]?.body.msToContent).toBeLessThan(530);
    expect(calls[0]?.body.msToMount).toBeGreaterThanOrEqual(300);
    expect(calls[0]?.body.msToMount).toBeLessThan(320);
  });

  it('reports each switch, not only the first', () => {
    const report = loadedPage();
    for (let i = 0; i < 3; i++) {
      report.navigated();
      const next = mountOf('diff');
      report.mounted(next.ctx);
      next.sync();
      vi.advanceTimersByTime(20);
    }
    expect(calls).toHaveLength(3);
  });

  it('files nothing for a switch the reader left before it arrived', () => {
    const report = loadedPage();
    report.navigated();
    const left = mountOf('diff');
    report.mounted(left.ctx);
    left.ctx.scope.dispose();
    report.navigated();
    const next = mountOf('diff');
    report.mounted(next.ctx);
    left.sync();
    vi.advanceTimersByTime(20);
    expect(calls).toHaveLength(0);
    next.sync();
    vi.advanceTimersByTime(20);
    expect(calls).toHaveLength(1);
  });

  it('files nothing when the page moved to something other than a diff', () => {
    const report = loadedPage();
    report.navigated();
    const next = mountOf('markdown');
    report.mounted(next.ctx);
    next.sync();
    vi.advanceTimersByTime(PAGE_LOAD_DEADLINE_MS + 1);
    expect(calls).toHaveLength(0);
  });

  it('reports a switch that never arrived, with the content absent', () => {
    const report = loadedPage();
    report.navigated();
    vi.advanceTimersByTime(PAGE_LOAD_DEADLINE_MS - 1);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.page).toBe('diff-switch');
    expect('msToContent' in (calls[0]?.body ?? {})).toBe(false);
  });

  it('marks a switch the tab was hidden for, so its number is not judged', () => {
    const report = loadedPage();
    report.navigated();
    let state: DocumentVisibilityState = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(4000);
    state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    const next = mountOf('diff');
    report.mounted(next.ctx);
    next.sync();
    vi.advanceTimersByTime(20);
    expect(calls[0]?.body.hidden).toBe(true);
    expect(calls[0]?.body.hiddenMs).toBeGreaterThanOrEqual(4000);
  });

  it('does not report a navigation before the page load has reported', () => {
    const report = startDocLoadReport('w-1');
    report.navigated();
    const next = mountOf('diff');
    report.mounted(next.ctx);
    next.sync();
    vi.advanceTimersByTime(20);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.page).toBe('diff');
  });
});
