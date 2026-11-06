/**
 * A markdown doc's half of presence: which block the person here is on, and
 * moving this view to somebody else's spot.
 *
 * The person's spot is the block at the middle of the doc's scroller — what
 * they are reading — or the thread they have open, with how far down the
 * doc they are. A followed spot is shown the way the planning voice's cursor
 * is (`doc/agent-focus.ts`): the block is found by id, or the first block
 * holding a phrase by its words, and centred in the scroller, moving nothing
 * else; a thread is opened as `?thread=` opens it; a bare scroll fraction
 * scrolls there.
 *
 * The heading of the section at the middle is kept as well: a voice message
 * said here tells the lead which section was on screen.
 *
 * It reaches the page's presence (`app.ts`) through `doc-spot-slot.ts`,
 * because the doc's mount comes and goes with the router.
 */
import { BLOCK_ID_ATTR } from '@claude-workspaces/core/prose';
import type { PresenceSpot } from '@claude-workspaces/core/workspace-presence';
import { centreIn, focusRange } from '../doc/agent-focus.ts';
import type { EditorHandle } from '../editor.ts';
import type { MountScope } from '../mount-scope.ts';
import { type DocPlace, docSpotMoved, setDocSpotHandle } from './doc-spot-slot.ts';

/** How long the scroller rests before the middle block is read again. */
const SETTLE_MS = 150;

export function wireDocSpot(opts: {
  docId: string;
  editor: EditorHandle;
  scroller: HTMLElement;
  openThread: () => string | null;
  revealThread: (id: string) => void;
  scope: MountScope;
}): void {
  const { editor, scroller, scope } = opts;
  const view = () => editor.editor.view;
  /** The doc position at the middle of the scroller, or null. */
  const middle = (): number | null => {
    if (editor.editor.isDestroyed) return null;
    const box = scroller.getBoundingClientRect();
    const hit = view().posAtCoords({
      left: box.left + box.width / 2,
      top: box.top + box.height / 2,
    });
    return hit ? hit.pos : null;
  };
  const scrolled = (): number | undefined => {
    const room = scroller.scrollHeight - scroller.clientHeight;
    return room > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / room)) : undefined;
  };
  const read = (): DocPlace | null => {
    const scroll = scrolled();
    const at = scroll === undefined ? {} : { scroll };
    const threadId = opts.openThread();
    if (threadId) return { threadId, ...at };
    const pos = middle();
    if (pos === null) return null;
    const $pos = view().state.doc.resolve(pos);
    for (let d = $pos.depth; d > 0; d--) {
      const id = $pos.node(d).attrs[BLOCK_ID_ATTR];
      if (typeof id === 'string' && id) return { blockId: id, ...at };
    }
    return scroll === undefined ? null : at;
  };
  /** The last heading at or above the middle of the scroller. */
  const heading = (): string | undefined => {
    const pos = middle();
    if (pos === null) return undefined;
    let last: string | undefined;
    view().state.doc.forEach((node, offset) => {
      if (offset <= pos && node.type.name === 'heading' && node.textContent.trim()) {
        last = node.textContent.trim();
      }
    });
    return last;
  };
  /** The first block holding `quote`, by its words. */
  const blockWith = (quote: string): number | null => {
    let found: number | null = null;
    view().state.doc.descendants((node, pos) => {
      if (found !== null) return false;
      if (!node.isTextblock) return true;
      if (node.textContent.includes(quote)) found = pos;
      return false;
    });
    return found;
  };
  const show = (spot: PresenceSpot): void => {
    if (spot.threadId) {
      opts.revealThread(spot.threadId);
      return;
    }
    if (editor.editor.isDestroyed) return;
    let block: number | null = null;
    if (spot.blockId) {
      block =
        focusRange(view().state.doc, { blockId: spot.blockId, quote: spot.quote ?? '' })?.block ??
        null;
    } else if (spot.quote) {
      block = blockWith(spot.quote);
    }
    const dom = block === null ? null : view().nodeDOM(block);
    if (dom instanceof HTMLElement) {
      centreIn(scroller, dom);
      return;
    }
    if (spot.scroll !== undefined) {
      scroller.scrollTop = spot.scroll * (scroller.scrollHeight - scroller.clientHeight);
    }
  };
  scope.onCleanup(setDocSpotHandle({ docId: opts.docId, show }));

  let timer: ReturnType<typeof setTimeout> | null = null;
  const settle = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const spot = read();
      if (spot) docSpotMoved(spot, heading());
    }, SETTLE_MS);
  };
  scroller.addEventListener('scroll', settle, { passive: true });
  scope.onCleanup(() => {
    if (timer) clearTimeout(timer);
    scroller.removeEventListener('scroll', settle);
  });
  settle();
}
