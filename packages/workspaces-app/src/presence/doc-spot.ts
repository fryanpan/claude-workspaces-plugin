/**
 * A markdown doc's half of presence: which block the person here is on, and
 * moving this view to somebody else's spot.
 *
 * The person's spot is the block at the middle of the doc's scroller — what
 * they are reading — or the thread they have open. A followed spot is shown
 * the way the planning voice's cursor is (`doc/agent-focus.ts`): the block
 * is found by id and centred in the scroller, moving nothing else; a thread
 * is opened as `?thread=` opens it.
 *
 * Held in a slot rather than passed, because the doc's mount comes and goes
 * with the router while the page's presence (`app.ts`) lives for the page —
 * the same shape as `doc/open-thread.ts`.
 */
import { BLOCK_ID_ATTR } from '@claude-workspaces/core/prose';
import type { PresenceSpot } from '@claude-workspaces/core/workspace-presence';
import { centreIn, focusRange } from '../doc/agent-focus.ts';
import type { EditorHandle } from '../editor.ts';
import type { MountScope } from '../mount-scope.ts';

interface DocSpotHandle {
  docId: string;
  read(): Pick<PresenceSpot, 'blockId' | 'threadId'> | null;
  show(spot: PresenceSpot): void;
}

let handle: DocSpotHandle | null = null;
let onMove: ((spot: Pick<PresenceSpot, 'blockId' | 'threadId'>) => void) | null = null;

/** The page's presence listens here for its person's moves. */
export function onDocSpotMove(
  cb: (spot: Pick<PresenceSpot, 'blockId' | 'threadId'>) => void,
): void {
  onMove = cb;
}

/** Show a followed spot on the doc on screen, if it is that doc. */
export function showDocSpot(spot: PresenceSpot): void {
  if (handle && handle.docId === spot.docId) handle.show(spot);
}

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
  const read = (): Pick<PresenceSpot, 'blockId' | 'threadId'> | null => {
    const threadId = opts.openThread();
    if (threadId) return { threadId };
    if (editor.editor.isDestroyed) return null;
    const box = scroller.getBoundingClientRect();
    const hit = view().posAtCoords({
      left: box.left + box.width / 2,
      top: box.top + box.height / 2,
    });
    if (!hit) return null;
    const $pos = view().state.doc.resolve(hit.pos);
    for (let d = $pos.depth; d > 0; d--) {
      const id = $pos.node(d).attrs[BLOCK_ID_ATTR];
      if (typeof id === 'string' && id) return { blockId: id };
    }
    return null;
  };
  const show = (spot: PresenceSpot): void => {
    if (spot.threadId) {
      opts.revealThread(spot.threadId);
      return;
    }
    if (!spot.blockId || editor.editor.isDestroyed) return;
    const r = focusRange(view().state.doc, { blockId: spot.blockId, quote: spot.quote ?? '' });
    const dom = r ? view().nodeDOM(r.block) : null;
    if (dom instanceof HTMLElement) centreIn(scroller, dom);
  };
  const mine: DocSpotHandle = { docId: opts.docId, read, show };
  handle = mine;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const settle = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const spot = read();
      if (spot) onMove?.(spot);
    }, SETTLE_MS);
  };
  scroller.addEventListener('scroll', settle, { passive: true });
  scope.onCleanup(() => {
    if (timer) clearTimeout(timer);
    scroller.removeEventListener('scroll', settle);
    if (handle === mine) handle = null;
  });
  settle();
}
