/**
 * A page with no blocks to name: its person's spot is how far down they are
 * and the thread open, and a followed spot scrolls there, finds a phrase or
 * opens a thread. A folder's file arrives after the follow does, so a spot
 * waits for it.
 */
import type { PresenceSpot } from '@claude-workspaces/core/workspace-presence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MountScope } from '../src/mount-scope.ts';
import { onDocSpotMove, showDocSpot } from '../src/presence/doc-spot-slot.ts';
import { wireFlatDocSpot } from '../src/presence/flat-doc-spot.ts';
import { pageScroller, scrollFraction, scrollToFraction } from '../src/presence/page-scroll.ts';

/** jsdom lays nothing out, so a scroller's size is set by hand. */
function size(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
  el.getClientRects = () => [{}] as unknown as DOMRectList;
  el.style.overflowY = 'auto';
}

describe('a page with no blocks', () => {
  let scope: MountScope;
  let editor: HTMLElement;
  const threads: string[] = [];
  const said: unknown[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'performance'] });
    document.body.innerHTML = '<div id="editor"></div>';
    editor = document.getElementById('editor') as HTMLElement;
    scope = new MountScope();
    threads.length = 0;
    said.length = 0;
    onDocSpotMove((spot) => said.push(spot));
  });
  afterEach(() => {
    scope.dispose();
    vi.useRealTimers();
  });
  const wire = (find?: (q: string) => boolean, open: string | null = null) =>
    wireFlatDocSpot({
      docId: 'd-quay',
      document,
      openThread: () => open,
      revealThread: (id) => threads.push(id),
      ...(find ? { find } : {}),
      scope,
    });
  const spot = (more: Partial<PresenceSpot>): PresenceSpot => ({
    surface: 'doc',
    docId: 'd-quay',
    ...more,
  });

  it('scrolls to a fraction, and reports where its person is', () => {
    size(editor, 1100, 100);
    editor.scrollTop = 250;
    wire(undefined, 'th-1');
    expect(said.at(-1)).toEqual({ threadId: 'th-1', scroll: 0.25 });
    showDocSpot(spot({ scroll: 0.5 }));
    expect(editor.scrollTop).toBe(500);
  });

  it('opens a thread, and finds a phrase before it scrolls', () => {
    size(editor, 1100, 100);
    wire((q) => q === 'high water');
    showDocSpot(spot({ threadId: 'th-1', scroll: 0.5 }));
    expect(threads).toEqual(['th-1']);
    expect(editor.scrollTop).toBe(0);
    showDocSpot(spot({ quote: 'high water', scroll: 0.5 }));
    expect(editor.scrollTop).toBe(0);
    showDocSpot(spot({ quote: 'not here', scroll: 0.5 }));
    expect(editor.scrollTop).toBe(500);
  });

  it('waits for a file that has not arrived, and a newer spot ends the wait', () => {
    size(editor, 100, 100);
    wire();
    showDocSpot(spot({ scroll: 1 }));
    vi.advanceTimersToNextFrame();
    expect(editor.scrollTop).toBe(0);
    size(editor, 1100, 100);
    vi.advanceTimersToNextFrame();
    expect(editor.scrollTop).toBe(1000);

    size(editor, 100, 100);
    editor.scrollTop = 0;
    showDocSpot(spot({ scroll: 1 }));
    showDocSpot(spot({ scroll: 0.5 }));
    size(editor, 1100, 100);
    vi.advanceTimersToNextFrame();
    expect(editor.scrollTop).toBe(500);
  });

  it('stops waiting for a file that never arrives', () => {
    size(editor, 100, 100);
    wire();
    showDocSpot(spot({ scroll: 1 }));
    vi.advanceTimersByTime(4_000);
    size(editor, 1100, 100);
    vi.advanceTimersToNextFrame();
    expect(editor.scrollTop).toBe(0);
  });
});

describe('how far down a page is', () => {
  it('finds the outermost scroller under a root, or the document', () => {
    document.body.innerHTML = '<main id="root"><div id="in"></div></main>';
    const inner = document.getElementById('in') as HTMLElement;
    (document.getElementById('root') as HTMLElement).getClientRects = () =>
      [{}] as unknown as DOMRectList;
    expect(pageScroller(document, ['#root'])).toBeNull();
    size(inner, 500, 100);
    expect(pageScroller(document, ['#missing', '#root'])).toBe(inner);
  });

  it('is undefined with no room, and a fraction of the room otherwise', () => {
    const el = document.createElement('div');
    size(el, 100, 100);
    expect(scrollFraction(el)).toBeUndefined();
    expect(scrollFraction(null)).toBeUndefined();
    size(el, 500, 100);
    scrollToFraction(el, 0.5);
    expect(scrollFraction(el)).toBe(0.5);
  });
});
