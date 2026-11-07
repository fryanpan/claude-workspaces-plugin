/**
 * A markdown doc's person: opening a thread moves their spot when nothing
 * scrolls, as for a thread on the whole doc, which has no line to scroll to.
 * The spot used to be read only after a scroll and once at mount, so such a
 * thread never reached anyone following them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openThreadChanged } from '../src/doc/open-thread.ts';
import type { EditorHandle } from '../src/editor.ts';
import { MountScope } from '../src/mount-scope.ts';
import { onDocSpotMove } from '../src/presence/doc-spot-slot.ts';
import { wireDocSpot } from '../src/presence/doc-spot.ts';

describe('a markdown doc spot', () => {
  let scope: MountScope;
  const said: unknown[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    scope = new MountScope();
    said.length = 0;
    onDocSpotMove((spot) => said.push(spot));
  });
  afterEach(() => {
    scope.dispose();
    vi.useRealTimers();
  });

  /** jsdom lays nothing out, so the doc reports no position under the middle. */
  const wire = (openThread: () => string | null): void => {
    const editor = {
      editor: { isDestroyed: false, view: { posAtCoords: () => null } },
    } as unknown as EditorHandle;
    wireDocSpot({
      docId: 'd-quay',
      editor,
      scroller: document.createElement('div'),
      openThread,
      revealThread: () => {},
      scope,
    });
  };

  it('reports a thread opened long after the mount, with no scroll', () => {
    let open: string | null = null;
    wire(() => open);
    vi.advanceTimersByTime(1000);
    expect(said).toEqual([]);
    open = 'th-1';
    openThreadChanged();
    vi.advanceTimersByTime(1000);
    expect(said).toEqual([{ threadId: 'th-1' }]);
  });

  it('stops listening when the doc unmounts', () => {
    wire(() => 'th-1');
    scope.dispose();
    said.length = 0;
    openThreadChanged();
    vi.advanceTimersByTime(1000);
    expect(said).toEqual([]);
  });
});
