import type { Thread } from '@claude-workspaces/core';
import type { MountScope } from './mount-scope.ts';
import {
  type NewCount,
  type NewDirection,
  type NewIndicatorHandle,
  mountNewIndicator,
} from './new-indicator.ts';
import { type ThreadKind, threadKind } from './thread-kind.ts';

/**
 * The measurement behind the new-content indicator: what has been written
 * that the reader cannot see, and which way it lies.
 *
 * One pass over the document's anchors feeds one pair of pills
 * (`new-indicator.ts` draws them). A thread counts when it is an open
 * question addressed to the reader, or when a reply landed on it since the
 * reader last looked; a note block counts while it is still tinted — the
 * tint (settle-wash.ts) IS "written since you last read here". Tapping a
 * pill goes to the NEAREST of the two kinds in that direction, because the
 * reader asked for the next thing, not the next thread.
 *
 * "New" wears off here too: once a thread has sat in the viewport for
 * `SEEN_DWELL_MS` it stops being new — on the pill, on its glyph and on its
 * highlight, which the caller repaints via `onSeen`.
 */

export const SEEN_DWELL_MS = 1500;

export interface HintItem {
  id: string;
  kind: ThreadKind;
  isNew: boolean;
  /** The anchor's edges in the same coordinate space as the viewport. */
  top: number;
  bottom: number;
}

export interface Tally {
  /** Threads with nothing waiting on the reader: comments, answered, resolved. */
  comments: number;
  /** Open review items — questions and decisions alike, one glyph. */
  questions: number;
  /** How many of the above are new since the reader last looked. */
  fresh: number;
  /** New threads that are NOT open questions — the pill's "N new" half, with
   *  the questions counted once in their own word rather than twice. */
  freshComments: number;
}

export interface OffscreenSplit {
  above: Tally;
  below: Tally;
  /** Ids currently inside the viewport, in document order. */
  inView: string[];
  /** The nearest off-screen thread in each direction, if any. */
  nearestAbove: string | null;
  nearestBelow: string | null;
}

function emptyTally(): Tally {
  return { comments: 0, questions: 0, fresh: 0, freshComments: 0 };
}

export function tallyTotal(t: Tally): number {
  return t.comments + t.questions;
}

/** What one direction's pill says, from that direction's thread tally and
 *  the number of freshly written note blocks lying that way. */
export function pillCount(t: Tally, notes: number): NewCount {
  return { questions: t.questions, fresh: t.freshComments + notes };
}

/**
 * Which threads are above, below, or inside the viewport. Pure — the caller
 * measures. `items` must be in document order; "nearest" relies on it. An
 * anchor is off-screen only when the WHOLE of it is out, so a highlight half
 * under the top edge still counts as visible.
 */
export function splitOffscreen(
  items: HintItem[],
  view: { top: number; bottom: number },
): OffscreenSplit {
  const above = emptyTally();
  const below = emptyTally();
  const inView: string[] = [];
  let nearestAbove: string | null = null;
  let nearestBelow: string | null = null;
  for (const it of items) {
    let target: Tally | null = null;
    if (it.bottom < view.top) {
      target = above;
      nearestAbove = it.id;
    } else if (it.top > view.bottom) {
      target = below;
      if (nearestBelow === null) nearestBelow = it.id;
    }
    if (!target) {
      inView.push(it.id);
      continue;
    }
    if (it.kind === 'question') target.questions += 1;
    else target.comments += 1;
    if (it.isNew) {
      target.fresh += 1;
      if (it.kind !== 'question') target.freshComments += 1;
    }
  }
  return { above, below, inView, nearestAbove, nearestBelow };
}

export function threadHintItem(
  t: Thread,
  rect: { top: number; bottom: number },
  isNew: boolean,
): HintItem {
  return { id: t.id, kind: threadKind(t), isNew, top: rect.top, bottom: rect.bottom };
}

/** A freshly written note block off screen: how far out, and which element. */
interface NoteEdge {
  el: HTMLElement;
  top: number;
  bottom: number;
}

interface NoteSplit {
  above: number;
  below: number;
  nearestAbove: NoteEdge | null;
  nearestBelow: NoteEdge | null;
}

/** The tinted note blocks each side of the viewport. Same edge rule the
 *  threads follow: wholly out, or it is on screen. */
export function splitNotes(edges: NoteEdge[], view: { top: number; bottom: number }): NoteSplit {
  const out: NoteSplit = { above: 0, below: 0, nearestAbove: null, nearestBelow: null };
  for (const e of edges) {
    if (e.bottom < view.top) {
      out.above += 1;
      if (!out.nearestAbove || e.bottom > out.nearestAbove.bottom) out.nearestAbove = e;
    } else if (e.top > view.bottom) {
      out.below += 1;
      if (!out.nearestBelow || e.top < out.nearestBelow.top) out.nearestBelow = e;
    }
  }
  return out;
}

// --- the mount -------------------------------------------------------------

export interface CommentHintsOpts {
  /** The doc's scroll container — the viewport the counts are against. */
  scroller: HTMLElement;
  /** The balloon column; on a wide screen the pills line up over it. Null
   *  when the surface has no margin. */
  marginEl: HTMLElement | null;
  /** The editor pane (`position: relative`) the strips are hung in. */
  floatParent: HTMLElement;
  threads: () => Thread[];
  /** The thread's rendered highlight, or null when it has none. */
  spanFor: (id: string) => Element | null;
  /** The thread's cards (balloon, inline card, panel row). A card in view
   *  counts as having SEEN the thread even when its sentence has scrolled
   *  off — on a phone the card sits under the sentence, and the reader is
   *  looking at the card. Counts stay keyed to the sentence. */
  cardsFor?: (id: string) => Element[];
  isNew: (t: Thread) => boolean;
  /** Record as seen; returns true when the thread stops being new. */
  markSeen: (t: Thread) => boolean;
  /** A thread stopped being new — repaint its glyph and highlight. */
  onSeen: (id: string) => void;
  onJump: (id: string) => void;
  /** The floating action dock the bottom strip must stay clear of. */
  dockEl?: () => HTMLElement | null;
  scope: MountScope;
  dwellMs?: number;
  /** Is the balloon margin showing at this width? Decides whether the strips
   *  take the column's footprint or become rows of the pane. */
  marginVisible: () => boolean;
  /** Smooth-scroll preference; read from the media query by default. */
  reducedMotion?: () => boolean;
}

export interface CommentHintsHandle {
  /** Re-measure and re-render — call when threads change. */
  refresh: () => void;
  /** The last split, for tests. */
  last: () => OffscreenSplit | null;
}

export function mountCommentHints(opts: CommentHintsOpts): CommentHintsHandle {
  const { scroller, scope } = opts;
  const dwell = opts.dwellMs ?? SEEN_DWELL_MS;
  const reduced =
    opts.reducedMotion ??
    (() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

  let last: OffscreenSplit | null = null;
  let lastNotes: NoteSplit | null = null;
  let lastItems: HintItem[] = [];
  let lastVisible = new Set<string>();
  const dwellTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const indicator: NewIndicatorHandle = mountNewIndicator({
    pane: opts.floatParent,
    scroller,
    marginEl: opts.marginEl,
    marginVisible: opts.marginVisible,
    ...(opts.dockEl ? { dockEl: opts.dockEl } : {}),
    onJump: (dir) => jump(dir),
    scope,
  });

  function items(): { list: HintItem[]; byId: Map<string, Thread> } {
    const viewRect = scroller.getBoundingClientRect();
    const withPos: Array<{ item: HintItem; y: number }> = [];
    const byId = new Map<string, Thread>();
    for (const t of opts.threads()) {
      const span = opts.spanFor(t.id);
      if (!span) continue;
      const r = span.getBoundingClientRect();
      byId.set(t.id, t);
      withPos.push({
        item: threadHintItem(
          t,
          { top: r.top - viewRect.top, bottom: r.bottom - viewRect.top },
          opts.isNew(t),
        ),
        y: r.top,
      });
    }
    withPos.sort((a, b) => a.y - b.y);
    return { list: withPos.map((x) => x.item), byId };
  }

  /** The tinted note blocks, in the scroller's coordinate space. */
  function noteEdges(): NoteEdge[] {
    const viewRect = scroller.getBoundingClientRect();
    const out: NoteEdge[] = [];
    for (const el of scroller.querySelectorAll<HTMLElement>('.recent-note')) {
      const r = el.getBoundingClientRect();
      out.push({ el, top: r.top - viewRect.top, bottom: r.bottom - viewRect.top });
    }
    return out;
  }

  function armDwell(id: string, t: Thread): void {
    if (dwellTimers.has(id)) return;
    dwellTimers.set(
      id,
      setTimeout(() => {
        dwellTimers.delete(id);
        if (scope.disposed) return;
        // Still on screen? A flick past a comment must not mark it seen.
        if (!lastVisible.has(id)) return;
        if (opts.markSeen(t)) opts.onSeen(id);
        refresh();
      }, dwell),
    );
  }

  function disarm(id: string): void {
    const timer = dwellTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      dwellTimers.delete(id);
    }
  }

  function refresh(): void {
    if (scope.disposed) return;
    const { list, byId } = items();
    const view = { top: 4, bottom: scroller.clientHeight - 4 };
    const split = splitOffscreen(list, view);
    const notes = splitNotes(noteEdges(), view);
    last = split;
    lastNotes = notes;
    lastItems = list;
    indicator.render(pillCount(split.above, notes.above), pillCount(split.below, notes.below));
    // New threads in view start their dwell; ones that left it stop. A card
    // in view is as good as the sentence in view.
    const visible = new Set(split.inView);
    if (opts.cardsFor) {
      const v = scroller.getBoundingClientRect();
      for (const it of list) {
        if (visible.has(it.id) || !it.isNew) continue;
        for (const card of opts.cardsFor(it.id)) {
          const r = card.getBoundingClientRect();
          if (r.height > 0 && r.top < v.bottom && r.bottom > v.top) {
            visible.add(it.id);
            break;
          }
        }
      }
    }
    lastVisible = visible;
    for (const id of Array.from(dwellTimers.keys())) if (!visible.has(id)) disarm(id);
    for (const it of list) {
      if (!it.isNew) continue;
      if (!visible.has(it.id)) continue;
      const t = byId.get(it.id);
      if (t) armDwell(it.id, t);
    }
  }

  /**
   * The nearest new thing that way — a thread's sentence or a freshly written
   * note block, whichever is closer to the edge the reader is looking at.
   * The pill counts both kinds in one number, so it has to be able to reach
   * both; taking the reader to the nearest THREAD past a note they were told
   * about is the bug this chooses against.
   */
  function jump(dir: NewDirection): void {
    refresh();
    const threadId = dir === 'above' ? last?.nearestAbove : last?.nearestBelow;
    const note = dir === 'above' ? lastNotes?.nearestAbove : lastNotes?.nearestBelow;
    const item = threadId ? lastItems.find((it) => it.id === threadId) : undefined;
    if (item && note) {
      const threadWins = dir === 'above' ? item.bottom >= note.bottom : item.top <= note.top;
      if (threadWins) {
        opts.onJump(item.id);
        return;
      }
      note.el.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
      return;
    }
    if (item) {
      opts.onJump(item.id);
      return;
    }
    if (note) note.el.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
  }

  // Scroll is the hot path: one measurement per frame at most, and a settle
  // pass afterwards so the last position always gets counted.
  let raf: number | null = null;
  const onScroll = (): void => {
    if (raf != null) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      refresh();
    });
  };
  scope.listen(scroller, 'scroll', onScroll, { passive: true });
  scope.listen(window, 'resize', onScroll);
  scope.onCleanup(() => {
    if (raf != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    raf = null;
    for (const id of Array.from(dwellTimers.keys())) disarm(id);
  });

  refresh();
  return { refresh, last: () => last };
}
