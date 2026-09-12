import { type Thread, threadRenderKey } from '@claude-workspaces/core';
import { type KeptAnswerField, keptAnswerFields, restoreAnswerFields } from './composer-keep.ts';
import { anchoredThreads } from './doc/resolved-visibility.ts';
import type { InlineThreadCard, ReviewSurface } from './review-surface.ts';
import { prefersReducedMotion, sizeThreadSlots } from './thread-morph.ts';

/**
 * Mobile review navigation.
 *
 * There is no standalone comment drawer on a phone. Two surfaces:
 *
 *  1. **Inline** — the card sits directly under the text (or the source line)
 *     it points at, exactly where a GitHub PR comment sits. Only threads that
 *     have a line to sit beside appear here: open, with a resolvable anchor.
 *  2. **The over-doc sheet** — what the app bar's comment-count badge opens.
 *     Grouped Open / Orphaned / Resolved. This is the ONLY place an orphaned
 *     or resolved thread appears, because neither has an anchor to sit under.
 *
 * There is no third surface and no stepper. `‹ ›` in the app bar used to walk
 * the inline cards in document order; they went with the rest of the top
 * bar's furniture, because a comment is reached by tapping the mark on the
 * sentence it was left on or by opening the list, and a pair of arrows that
 * only ever worked on a phone was a third way to do what two already did.
 *
 * Expand state is SHARED between a thread's inline copy and its sheet copy:
 * this module never touches a card's expansion directly, it goes through the
 * panel's active thread, which folds every copy on screen at once.
 */

/** Everything `centreScrollTop` needs, and nothing that needs a browser. */
export interface CentreMetrics {
  /** The card's top edge in the scroll container's own content space. */
  elTop: number;
  elHeight: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * Where a card has to sit for the jump to read as "go to that comment":
 * centred inside its OWN scroller, clamped to that scroller's range.
 *
 * Deliberately not `scrollIntoView()` — that walks up and scrolls every
 * ancestor scroller too, so the page moves out from under the review surface.
 * Pure so the clamp is checkable without a DOM.
 */
export function centreScrollTop(m: CentreMetrics): number {
  const max = Math.max(0, m.scrollHeight - m.clientHeight);
  const wanted = m.elTop - m.clientHeight / 2 + m.elHeight / 2;
  return Math.max(0, Math.min(max, wanted));
}

/** How long the target card stays highlighted after the nav jumps to it. */
export const NAV_FLASH_MS = 900;

export interface MobileReviewOpts {
  /** Phone-width, i.e. the viewport where inline + sheet replace the drawer. */
  /** Do inline cards apply at this width? NOT "is this a phone" — the cards
   *  are the reader's chosen surface (see `card-placement.ts`), which is a
   *  stored per-device preference rather than anything about this width. */
  inlineVisible: () => boolean;
  /** Every thread on this doc, as the chrome already reads them. */
  threads: () => Thread[];
  /** Live position of a thread's anchor, or null once it stops resolving. */
  resolveRange: (id: string) => { from: number; to: number } | null;
  /** THE shared card builder (`ThreadPanel.renderThread`). Never fork it —
   *  the inline card and the sheet card must be the same shape, and the morph
   *  needs both faces present in whatever node it is handed. */
  renderCard: (t: Thread, pendingReply?: string) => HTMLElement;
  surface: Pick<ReviewSurface, 'setInlineCards' | 'scrollToPos'>;
  /** Expand state, shared with every other copy of the card. */
  setActive: (id: string | null) => void;
  /** Scroll the sheet's own copy of a thread into view once the sheet is up. */
  revealInSheet: (id: string) => void;
  openSheet: () => void;
  closeSheet: () => void;
  isSheetOpen: () => boolean;
  onCleanup?: (fn: () => void) => void;
}

export interface MobileReview {
  /** Rebuild the inline card set from the current threads. Cheap when
   *  nothing a card displays has changed: card nodes are REUSED, which is
   *  what lets an expanded card survive an unrelated thread's new reply. */
  refresh: () => void;
  /** Focus one thread the mobile way. Returns true when it had an inline
   *  card to jump to, false when the sheet was opened instead. */
  showThread: (id: string) => boolean;
  /** Open threads with a resolvable anchor, in document order. */
  inlineThreads: () => Thread[];
}

/**
 * What a card DISPLAYS. Rebuild only on a change to this — never on expansion,
 * because a freshly built node mounts at its final height and cannot morph.
 *
 * The inline card is the SAME card the drawer and the margin balloon build
 * (`ThreadPanel.renderThread`), so it memoizes off the same key: the terms
 * that move without touching a count or a clock — a summary landing, an
 * answer being stamped or taken back — are exactly the ones each of the three
 * hand-written copies of this key was missing.
 */
function cardKey(t: Thread): string {
  return threadRenderKey(t);
}

/**
 * The scroller that actually holds this card. CodeMirror scrolls inside its
 * own `.cm-scroller`; prose scrolls in `#editor`. Anything above those is a
 * scroller we must NOT move.
 */
function scrollContainerOf(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>('.cm-scroller') ?? document.getElementById('editor');
}

export function mountMobileReview(opts: MobileReviewOpts): MobileReview {
  /** One live node per inline thread, keyed by thread id. Kept across
   *  refreshes so an expanded card is not rebuilt out from under its morph. */
  const built = new Map<string, { key: string; el: HTMLElement }>();
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  function inlineThreads(): Thread[] {
    const withPos: Array<{ t: Thread; from: number }> = [];
    for (const t of anchoredThreads(opts.threads())) {
      // An orphaned thread has no anchor at all — it lives in the sheet and
      // only there, and so does a settled one: neither has a line to sit
      // beside.
      if (t.anchor.kind !== 'text-range') continue;
      const r = opts.resolveRange(t.id);
      if (!r) continue;
      withPos.push({ t, from: r.from });
    }
    withPos.sort((a, b) => a.from - b.from);
    return withPos.map((x) => x.t);
  }

  function refresh(): void {
    const list = opts.inlineVisible() ? inlineThreads() : [];
    const cards: InlineThreadCard[] = [];
    const seen = new Set<string>();
    // Answer fields carried out of cards rebuilt below; focus can only go back
    // once the new card is in the document, after `setInlineCards`.
    const keptAnswers: Array<{ el: HTMLElement; kept: KeptAnswerField[] }> = [];
    for (const t of list) {
      const r = opts.resolveRange(t.id);
      if (!r) continue;
      seen.add(t.id);
      const key = cardKey(t);
      let entry = built.get(t.id);
      if (!entry || entry.key !== key) {
        // Carry an in-progress reply across the rebuild — the same trick the
        // drawer and the balloon margin use, and needed here for the same
        // reason: someone else's reply must not wipe what you were typing.
        const draft = entry?.el.querySelector<HTMLTextAreaElement>('textarea')?.value;
        const answers = entry ? keptAnswerFields(entry.el) : [];
        const el = opts.renderCard(t, draft || undefined);
        if (answers.length > 0) keptAnswers.push({ el, kept: answers });
        el.classList.add('cw-inline-card');
        // A widget decoration is outside the document's content model, but
        // nothing stops native editing INSIDE the injected DOM unless the
        // widget opts out itself (same rule live-markup.ts's chip follows).
        el.contentEditable = 'false';
        entry = { key, el };
        built.set(t.id, entry);
      }
      cards.push({ id: t.id, from: r.from, to: r.to, el: entry.el });
    }
    for (const id of Array.from(built.keys())) if (!seen.has(id)) built.delete(id);
    opts.surface.setInlineCards?.(cards);
    for (const { el, kept } of keptAnswers) restoreAnswerFields(el, kept);
    // A card's folding slots hold a height we MEASURE — do it now the nodes
    // are actually in the document, or every inline card renders as a header
    // and a footer with nothing between them.
    for (const c of cards) if (c.el.isConnected) sizeThreadSlots(c.el);
  }

  function flash(el: HTMLElement): void {
    if (flashTimer) clearTimeout(flashTimer);
    for (const other of Array.from(document.querySelectorAll('.cw-nav-flash')))
      other.classList.remove('cw-nav-flash');
    el.classList.add('cw-nav-flash');
    flashTimer = setTimeout(() => el.classList.remove('cw-nav-flash'), NAV_FLASH_MS);
  }

  function centreCard(el: HTMLElement): void {
    const sc = scrollContainerOf(el);
    if (!sc) return;
    const top = centreScrollTop({
      elTop: el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop,
      elHeight: el.offsetHeight,
      clientHeight: sc.clientHeight,
      scrollHeight: sc.scrollHeight,
    });
    // Scroll THIS container by hand. `scrollIntoView()` would walk up and
    // scroll every ancestor scroller too, dragging the page behind the
    // review surface along with it.
    // The morph and the anchor flash both honour reduced motion, and on this
    // path they are already silent — which leaves this scroll as the only
    // thing moving. Jump instead.
    if (typeof sc.scrollTo === 'function') {
      sc.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    } else {
      sc.scrollTop = top;
    }
  }

  function showThread(id: string): boolean {
    // Expanding goes through the panel's active thread, so the inline copy
    // and the sheet copy fold together — never touch one copy directly.
    opts.setActive(id);
    const el = built.get(id)?.el;
    if (el?.isConnected) {
      if (opts.isSheetOpen()) opts.closeSheet();
      centreCard(el);
      flash(el);
      return true;
    }
    // The card exists but isn't in the DOM: CodeMirror only renders its
    // viewport, so an off-screen inline card is genuinely absent. Scroll the
    // surface to the anchor first and centre once it has been rendered.
    const r = built.has(id) ? opts.resolveRange(id) : null;
    if (r) {
      opts.surface.scrollToPos?.(r.from);
      requestAnimationFrame(() => {
        const later = built.get(id)?.el;
        if (later?.isConnected) {
          centreCard(later);
          flash(later);
        }
      });
      return true;
    }
    // Orphaned or resolved: no line to sit beside, so the sheet is the only
    // place this thread exists at all.
    opts.openSheet();
    opts.revealInSheet(id);
    return false;
  }

  opts.onCleanup?.(() => {
    if (flashTimer) clearTimeout(flashTimer);
    built.clear();
    opts.surface.setInlineCards?.([]);
  });

  return { refresh, showThread, inlineThreads };
}
