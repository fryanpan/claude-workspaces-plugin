import { type User, resolveUser } from '@claude-workspaces/core';
import { api } from './doc-path.ts';
import { asBackgroundWrite } from './signin/write-gate.ts';

/**
 * "This person has now SEEN this review item" — the browser half of
 * `review_item.viewed`.
 *
 * WHY IT EXISTS. An answer is one instant, so the minutes a reader spends
 * reading an ask before answering it are worth zero to anything measuring
 * from the board's logs. The pair of rows — seen, then answered — makes that
 * a subtraction. Nothing about it is visible: no chrome changes, and a reader
 * cannot tell whether the beacon fired.
 *
 * WHAT "SHOWN ON SCREEN" IS TAKEN TO MEAN, and why this reading is the honest
 * one. Two conditions, both required:
 *
 *  1. **The element intersects the viewport**, per `IntersectionObserver`.
 *     Rendering is not showing: the task panel builds every item's card at
 *     once and the queue builds the card behind the one on top, so "the DOM
 *     has it" would count items the reader never scrolled to. An item below
 *     the fold reports nothing until it is scrolled to.
 *  2. **The page is visible** — `document.visibilityState === 'visible'`. A
 *     background tab lays out normally and its elements intersect its own
 *     viewport, so intersection alone counts a board restored on a phone
 *     into a tab nobody looked at. An item that became intersecting while
 *     hidden is held, not dropped: it reports on the next `visibilitychange`
 *     if it is still on screen, which is the moment the reader actually sees
 *     it.
 *  3. **The card is not in a subtree the page has hidden from the reader** —
 *     no `inert` and no `aria-hidden="true"` ancestor. `display: none` takes
 *     care of itself (a box with no layout intersects nothing), but a doc
 *     thread's FOLDED face is none of those: both faces of a thread card are
 *     always built, stacked in one box, and the folded one is held at
 *     `opacity: 0` inside a clipped slot — so a few of its top pixels still
 *     intersect while the reader is looking at a one-line summary. The page
 *     already marks that face `inert` and `aria-hidden` for exactly the
 *     reason the beacon needs: it is not being shown to anybody.
 *
 * A card held for either reason reports the moment it IS shown. The page
 * tells the watcher when that could have happened — `visibilitychange` for
 * the tab, `recheck()` for a fold that changed what is on show without
 * rebuilding any DOM — rather than the watcher polling for it.
 *
 * Deliberately no DWELL requirement. A reader who scrolls quickly past an
 * item has still seen it, and a dwell threshold is a second number to defend
 * that would make a fast reader's minutes vanish rather than shrink.
 *
 * ONCE PER ITEM PER CLIENT SESSION. The ledger is module-level and lives as
 * long as the page does, so meeting the same item on Home and again on its
 * task page writes one row; a RELOAD is a new client session and writes
 * another, which is what "client session" means here and is the reading a
 * consumer can check against the page-load rows it already has. The ledger is
 * keyed by board and item, never by which surface showed it: the point of the
 * row is that the reader met the ask, not where.
 */

/** Which item was shown, and where it hangs. */
export interface ReviewItemSeenTarget {
  /** The board the item is on — the beacon's own address. */
  workspaceId: string;
  /** The item's universal id: minted `r-…` on a ticket, derived `rt-…` on a
   *  doc thread, or the fixed legacy id for a ticket's own decision. */
  reviewItemId: string;
  /** The ticket, when the item hangs on one. Required for the legacy id,
   *  which every legacy-decision ticket derives and which therefore addresses
   *  nothing alone; the server ignores it otherwise and reads its own. */
  taskId?: string;
}

/** Injected by the tests; the defaults are the real page. */
export interface ReviewItemSeenOptions {
  /** Send the beacon. Default: `POST …/review-items/viewed`. */
  report?: (target: ReviewItemSeenTarget) => void;
  /** Is the page in front of somebody right now? */
  visible?: () => boolean;
  /** Is this card being shown, as opposed to built and hidden? */
  shown?: (el: Element) => boolean;
}

/**
 * Has the page hidden this card from the reader?
 *
 * `inert` and `aria-hidden` are the two markings the app already puts on a
 * subtree it is not showing, so the beacon reads the page's own answer rather
 * than inventing a second one that could disagree with it. Nothing here
 * inspects computed style: the properties that would matter (`display: none`)
 * already produce no intersection, and the ones that would not (a 0.999
 * opacity mid-animation) are not a judgement this belongs in.
 */
function shownToReader(el: Element): boolean {
  return !el.closest('[inert]') && !el.closest('[aria-hidden="true"]');
}

/** One item's identity in the ledger. A board scopes it because two boards
 *  can hold the same derived id only by holding the same doc — and even then
 *  they are two rows to whoever is counting. `|` separates them safely: a
 *  board id and a review item id are both base64url-ish, so neither can
 *  contain one and no pair of distinct ids can collide on the join. */
function ledgerKey(target: ReviewItemSeenTarget): string {
  return `${target.workspaceId}|${target.reviewItemId}`;
}

/** Items this page has already reported. Module-level on purpose: see the
 *  header — the whole page load is one client session. */
const reported = new Set<string>();

/** Test seam only: forget this page's ledger. Never called by the app. */
export function resetReviewItemSeenLedger(): void {
  reported.clear();
}

export interface ReviewItemSeenWatcher {
  /**
   * Watch one card. Safe to call on every repaint — an element already being
   * watched is re-pointed at the target it now carries, and an item already
   * reported is dropped without touching the DOM.
   */
  watch(el: Element, target: ReviewItemSeenTarget): void;
  /**
   * Look again at the cards being held back.
   *
   * For a surface that changes what it SHOWS without rebuilding anything —
   * the doc drawer folds one thread card open and another shut in place, so
   * no element enters or leaves the viewport and the observer has nothing new
   * to say. Cheap: it walks only the held set, which is empty on a page whose
   * items are all either reported or off screen.
   */
  recheck(): void;
  /** Stop watching everything. The page's own teardown. */
  stop(): void;
}

/**
 * Who this browser is, for a write nobody asked for.
 *
 * The row is "somebody read this ask", so it needs an actor, and the server
 * refuses a beacon that names none — which is how the first version of this
 * file recorded nothing at all on a trusted-local board: it sent ids only, and
 * every beacon came back 400 while the tests, which supplied an author by
 * hand, stayed green.
 *
 * Read from the SAME storage every other client write resolves its author
 * from, rather than threaded down from a boot. Two reasons, and the second is
 * the one that matters:
 *
 *  - There is no one boot to thread it from. Three surfaces show an item, the
 *    ledger is one page-wide thing, and a watcher built on first paint has no
 *    access to whatever the app's entry point awaited.
 *  - A page that forgot to hand its user over would send nothing and record
 *    nothing, silently — which is the exact failure this function exists to
 *    close, reintroduced as a wiring step somebody must remember.
 *
 * It cannot write down the WRONG person either: a request carrying a verified
 * session is attributed to that session by `authorFor` on the server, which
 * outranks anything a body claims. This identity is what the server falls back
 * on when nothing is proven — and then it is the same identity the reader's
 * comments and answers on the same page carry, which is what makes viewed and
 * answered subtractable.
 */
function beaconAuthor(): User {
  return resolveUser(null, {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        // A browser with storage denied still gets an identity for this page
        // load; it is just not the same one next time.
      }
    },
  });
}

/**
 * Default beacon: one POST per item, and nothing depends on the answer.
 *
 * `asBackgroundWrite` for the reason the reading tracker uses it — nobody
 * asked for this write, so a sign-in gate refusing it must raise the standing
 * bar rather than a modal demanding the reader sign in to do something they
 * never did. `keepalive` so a view recorded on the way out of the page is not
 * cancelled by the navigation that caused it.
 */
function postSeen(target: ReviewItemSeenTarget): void {
  try {
    const author = beaconAuthor();
    asBackgroundWrite(() => {
      void fetch(api('review-items/viewed', target.workspaceId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reviewItemId: target.reviewItemId,
          ...(target.taskId ? { taskId: target.taskId } : {}),
          author,
        }),
        keepalive: true,
      });
    });
  } catch {
    // Best-effort measurement; never throw into a render.
  }
}

/**
 * Start watching. Returns the watcher the surfaces hand their cards to.
 *
 * A browser with no `IntersectionObserver` gets a watcher that reports
 * nothing rather than one that reports everything: measuring a subset of
 * browsers honestly beats inflating the count with every card a layout built.
 */
export function createReviewItemSeen(opts: ReviewItemSeenOptions = {}): ReviewItemSeenWatcher {
  const report = opts.report ?? postSeen;
  const visible =
    opts.visible ??
    (() => typeof document === 'undefined' || document.visibilityState === 'visible');
  const shown = opts.shown ?? shownToReader;

  /** What each watched element is currently showing. */
  const targets = new WeakMap<Element, ReviewItemSeenTarget>();
  /** In the viewport right now, but not yet SHOWN — a hidden tab, or a folded
   *  face. Held so the reader's first actual look is what the row records. */
  const held = new Set<Element>();

  const Observer = (globalThis as { IntersectionObserver?: typeof IntersectionObserver })
    .IntersectionObserver;
  if (!Observer) {
    return { watch: () => {}, recheck: () => {}, stop: () => {} };
  }

  const fire = (el: Element): void => {
    const target = targets.get(el);
    if (!target) return;
    const key = ledgerKey(target);
    if (reported.has(key)) {
      observer.unobserve(el);
      return;
    }
    reported.add(key);
    held.delete(el);
    observer.unobserve(el);
    report(target);
  };

  /** In the viewport AND actually in front of the reader. */
  const onShow = (el: Element): void => {
    if (visible() && shown(el)) fire(el);
    else held.add(el);
  };

  const observer = new Observer((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        held.delete(entry.target);
        continue;
      }
      onShow(entry.target);
    }
  });

  const releaseHeld = (): void => {
    if (!visible()) return;
    // A copy, because `fire` mutates the set it is walking.
    for (const el of [...held]) {
      if (shown(el)) fire(el);
    }
  };
  const onVisibility = (): void => releaseHeld();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  return {
    watch(el: Element, target: ReviewItemSeenTarget): void {
      if (target.workspaceId === '' || target.reviewItemId === '') return;
      if (reported.has(ledgerKey(target))) return;
      targets.set(el, target);
      observer.observe(el);
    },
    recheck(): void {
      releaseHeld();
    },
    stop(): void {
      observer.disconnect();
      held.clear();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    },
  };
}

/**
 * The page's one watcher, shared by every surface that shows an item.
 *
 * One `IntersectionObserver` rather than one per card, and — more to the
 * point — one ledger: Home, the task panel and a doc page can all be alive in
 * the same page load, and the row is "this reader met this ask", not "this
 * surface drew it". Built on first use so a page that shows no review item
 * installs no observer and no listener.
 */
let shared: ReviewItemSeenWatcher | undefined;

export function reviewItemSeen(): ReviewItemSeenWatcher {
  shared ??= createReviewItemSeen();
  return shared;
}

/** Test seam only: drop the shared watcher AND this page's ledger. */
export function resetReviewItemSeen(): void {
  shared?.stop();
  shared = undefined;
  resetReviewItemSeenLedger();
}
