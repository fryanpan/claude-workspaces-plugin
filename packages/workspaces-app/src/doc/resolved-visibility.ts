/**
 * Whether settled comments are on the page at all — this reader's choice, on
 * this device.
 *
 * A resolved thread used to keep everything an open one has: a card in the
 * margin (or in the flow), and a tinted anchor on the sentence. Nothing was
 * wrong with any single one of them; the failure was cumulative. On a doc
 * that has been through a review round, most of the cards on screen are
 * about questions nobody is asking any more, and the remaining open ones are
 * the needle. So the default here is `false`: settled work leaves the page,
 * and one control brings it back.
 *
 * Hidden is NOT deleted, and nothing in this module writes to a document.
 * The thread stays in the ydoc, stays in the drawer's list under its
 * Resolved tab, and comes back — muted, exactly where it was — the moment
 * the control is pressed. Reopening from a revealed card puts it back in the
 * open set with no extra step, because the only thing this preference ever
 * touches is what the two anchored surfaces draw.
 *
 * A per-device preference and not a doc setting, for the same reason the
 * card placement is one: two people reading the same review disagree about
 * this, and neither is wrong. `localStorage` rather than `sessionStorage`
 * because a reader who cleared the settled comments away means it for the
 * next visit too. Every accessor is wrapped — private mode, cleared site
 * data and the thumbnail renderer all throw on the accessor itself, and a
 * review page that cannot render without storage renders blank for the
 * reader who most needs it.
 */
import type { Thread } from '@claude-workspaces/core';

export const SHOW_RESOLVED_PREF_KEY = 'lf:show-resolved';

/**
 * Are settled comments drawn on the page right now?
 *
 * Pure over the stored string so the default is testable without a DOM:
 * anything but the stored `'1'` — nothing stored, a cleared store, a value
 * from some future version — means hidden, which is the state that shows the
 * reader more of what they still have to answer.
 */
export function showResolvedFromStored(stored: string | null): boolean {
  return stored === '1';
}

let cached: boolean | null = null;
const listeners = new Set<() => void>();

/** Whether resolved threads are currently drawn on the page. */
export function showResolved(): boolean {
  if (cached === null) {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(SHOW_RESOLVED_PREF_KEY);
    } catch {
      // storage unavailable — the default (hidden) applies for this page.
    }
    cached = showResolvedFromStored(stored);
  }
  return cached;
}

/** Set it, persist it, and tell every mounted surface to repaint. */
export function setShowResolved(next: boolean): void {
  if (showResolved() === next) return;
  cached = next;
  try {
    localStorage.setItem(SHOW_RESOLVED_PREF_KEY, next ? '1' : '0');
  } catch {
    // storage unavailable — the choice holds for this page only.
  }
  for (const fn of Array.from(listeners)) fn();
}

/** Subscribe to changes; the returned function unsubscribes. */
export function onShowResolvedChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Drop the memoised value — for tests, which write the store directly. */
export function resetShowResolvedCache(): void {
  cached = null;
}

/**
 * The threads an ANCHORED surface may draw: the balloon margin, the inline
 * cards, and the highlights on the prose.
 *
 * One function rather than a filter written out at each call site, because
 * the three surfaces have to agree — a highlight with no card under it, or a
 * card pointing at a sentence with no tint, is worse than either state on its
 * own. The drawer's list is deliberately NOT a caller: it is the place a
 * resolved thread stays visible, which is what makes hiding reversible.
 */
export function anchoredThreads(threads: Thread[], resolvedVisible: boolean): Thread[] {
  if (resolvedVisible) return threads;
  return threads.filter((t) => t.status !== 'resolved');
}

/**
 * Wire the topbar's "Show resolved (n)" control.
 *
 * The count is in the label because it is the whole reason to press it: with
 * nothing settled there is nothing to reveal, and `paint(0)` hides the button
 * rather than offering an empty drawer. It carries `aria-pressed` — unlike
 * the placement toggle, this genuinely is an on/off over one set of cards.
 */
export function wireResolvedToggle(opts: {
  btn: HTMLElement;
  /** Scope-bound listener registration, so navigation unbinds it. */
  listen: (target: EventTarget, type: string, handler: EventListener) => void;
}): { paint: (resolvedCount: number) => void } {
  const { btn } = opts;
  // Two labels, one control. Above 720px the words fit and say what pressing
  // it does; on a phone the same topbar is already carrying the doc title,
  // the comment nav and the badge, and the words were measured overrunning
  // their neighbours at 430. The COUNT survives the squeeze because it is the
  // half that changes — a tick and a number beside the comment badge reads as
  // "settled ones, hidden". Which one shows is CSS, so no width is decided
  // here: page zoom moves the width, and this is a layout question, not a
  // question about the device.
  const long = document.createElement('span');
  long.className = 'rt-long';
  const short = document.createElement('span');
  short.className = 'rt-short';
  btn.replaceChildren(long, short);
  let count = 0;
  const paint = (resolvedCount: number): void => {
    count = resolvedCount;
    btn.hidden = resolvedCount === 0;
    const on = showResolved();
    long.textContent = on ? `Hide resolved (${resolvedCount})` : `Show resolved (${resolvedCount})`;
    short.textContent = `✓ ${resolvedCount}`;
    btn.setAttribute('aria-pressed', String(on));
    // The accessible name carries the full phrase at every width, so the
    // phone's short label never costs a screen-reader reader the meaning.
    const name = on
      ? `Hide ${resolvedCount} resolved comments`
      : `Show ${resolvedCount} resolved comments`;
    btn.setAttribute('aria-label', name);
    btn.title = name;
  };
  opts.listen(btn, 'click', () => {
    setShowResolved(!showResolved());
    paint(count);
  });
  paint(0);
  return { paint };
}
