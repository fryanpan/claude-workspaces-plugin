import { beforeEach, describe, expect, it } from 'vitest';
import {
  type ReviewItemSeenTarget,
  createReviewItemSeen,
  resetReviewItemSeen,
} from '../src/review-item-seen.ts';

/**
 * When a review item counts as SEEN.
 *
 * The three conditions the beacon holds are all "not yet, hold it" rather
 * than "no, drop it", so every case here is driven to the moment it should
 * report as well as the moment it should not. A test that only proved silence
 * would pass just as well against a watcher that never fires at all — so each
 * silent case is followed by the release that makes the same card report.
 *
 * `IntersectionObserver` is faked because jsdom has none and because the
 * behaviour under test is what happens AFTER an intersection: the real
 * observer would only be deciding when to call the callback this one calls
 * directly.
 */

/** A fake observer whose entries this test delivers by hand. */
class FakeObserver {
  static live: FakeObserver[] = [];
  readonly watched = new Set<Element>();
  constructor(
    private readonly cb: (entries: { target: Element; isIntersecting: boolean }[]) => void,
  ) {
    FakeObserver.live.push(this);
  }
  observe(el: Element): void {
    this.watched.add(el);
  }
  unobserve(el: Element): void {
    this.watched.delete(el);
  }
  disconnect(): void {
    this.watched.clear();
  }
  /** "This card is now in the viewport." */
  enter(el: Element): void {
    this.cb([{ target: el, isIntersecting: true }]);
  }
  /** "This card has scrolled out of it again." */
  leave(el: Element): void {
    this.cb([{ target: el, isIntersecting: false }]);
  }
}

const withObserver = (): typeof globalThis => {
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
    FakeObserver as unknown as typeof IntersectionObserver;
  return globalThis;
};

const ITEM: ReviewItemSeenTarget = { workspaceId: 'w-tideline', reviewItemId: 'r-one' };
const OTHER: ReviewItemSeenTarget = { workspaceId: 'w-tideline', reviewItemId: 'r-two' };

/** A card in the document, optionally inside a subtree the page has hidden. */
function card(opts: { inert?: boolean } = {}): HTMLElement {
  const host = document.createElement('div');
  if (opts.inert) {
    host.setAttribute('inert', '');
    host.setAttribute('aria-hidden', 'true');
  }
  const el = document.createElement('div');
  host.append(el);
  document.body.append(host);
  return el;
}

describe('the first time a client shows a review item', () => {
  let reported: ReviewItemSeenTarget[] = [];
  let visible = true;

  const watcher = () => {
    withObserver();
    return createReviewItemSeen({
      report: (t) => reported.push(t),
      visible: () => visible,
    });
  };
  const observer = () => FakeObserver.live[FakeObserver.live.length - 1];

  beforeEach(() => {
    resetReviewItemSeen();
    document.body.innerHTML = '';
    FakeObserver.live = [];
    reported = [];
    visible = true;
  });

  it('reports the item once it is in the viewport', () => {
    const w = watcher();
    const el = card();
    w.watch(el, ITEM);
    expect(reported).toHaveLength(0); // watched is not seen
    observer().enter(el);
    expect(reported).toEqual([ITEM]);
  });

  it('reports each item once, however many places show it', () => {
    const w = watcher();
    const queueCard = card();
    const panelCard = card();
    w.watch(queueCard, ITEM);
    w.watch(panelCard, ITEM);
    observer().enter(queueCard);
    observer().enter(panelCard);
    // Same ask, met twice in one page load: one row. The ledger is keyed by
    // board and item, never by which surface drew it.
    expect(reported).toEqual([ITEM]);

    // Positive control on the ledger: a DIFFERENT item still reports, so the
    // silence above is deduplication and not a watcher that stopped.
    const second = card();
    w.watch(second, OTHER);
    observer().enter(second);
    expect(reported).toEqual([ITEM, OTHER]);
  });

  it('holds an item that came on screen in a hidden tab until the tab is looked at', () => {
    const w = watcher();
    const el = card();
    visible = false;
    w.watch(el, ITEM);
    observer().enter(el);
    // A background tab lays out normally; nothing here has been seen.
    expect(reported).toHaveLength(0);
    visible = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(reported).toEqual([ITEM]);
  });

  it('holds a card the page has hidden from the reader until it is shown', () => {
    const w = watcher();
    const el = card({ inert: true });
    w.watch(el, ITEM);
    observer().enter(el);
    // A folded thread card: built, laid out, a few pixels of it clipped into
    // the viewport — and marked `inert`, because nobody is being shown it.
    expect(reported).toHaveLength(0);
    // The reader opens it. Nothing enters or leaves the viewport, so the page
    // has to say so.
    const host = el.parentElement as HTMLElement;
    host.removeAttribute('inert');
    host.removeAttribute('aria-hidden');
    w.recheck();
    expect(reported).toEqual([ITEM]);
  });

  it('forgets a card that left the viewport before it was ever shown', () => {
    const w = watcher();
    const el = card();
    visible = false;
    w.watch(el, ITEM);
    observer().enter(el);
    observer().leave(el);
    visible = true;
    document.dispatchEvent(new Event('visibilitychange'));
    // Scrolled past while the tab was in the background is not seen.
    expect(reported).toHaveLength(0);
    // …and the item is still watchable, so this is a hold released, not a
    // card thrown away.
    observer().enter(el);
    expect(reported).toEqual([ITEM]);
  });

  it('reports nothing at all where the browser cannot tell what is on screen', () => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
    const w = createReviewItemSeen({ report: (t) => reported.push(t) });
    const el = card();
    w.watch(el, ITEM);
    w.recheck();
    w.stop();
    // Measuring a subset of browsers honestly beats counting every card a
    // layout built.
    expect(reported).toHaveLength(0);
  });

  it('ignores a target that names no board or no item', () => {
    const w = watcher();
    const el = card();
    w.watch(el, { workspaceId: '', reviewItemId: 'r-one' });
    w.watch(el, { workspaceId: 'w-tideline', reviewItemId: '' });
    expect(observer().watched.size).toBe(0);
    expect(reported).toHaveLength(0);
  });
});
