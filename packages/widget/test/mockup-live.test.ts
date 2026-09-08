import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The in-place swap: what a reviewer keeps when a mockup's next round lands
 * under him.
 *
 * The behaviour under test is `swapDocument`, which is the whole of the round
 * change as far as the page is concerned — the SSE frame that triggers it and
 * the fetch that feeds it are transport. What must hold is that the new round
 * is on screen, the reader has not been moved, the widget's own element and
 * everything it is holding are untouched, and a comment's element either
 * resolves against the new DOM or resolves against nothing (which is what puts
 * the thread into the outdated flow).
 */

const ROUND_TWO =
  '<!doctype html><html><head><style id="r2">h1{color:blue}</style></head>' +
  '<body class="round-two"><h1 id="hero">Round two</h1>' +
  '<p id="keeper">Unchanged paragraph</p></body></html>';

async function importLive() {
  return import('../src/mockup-live.ts');
}

/** The page as the server serves it: the mock, then the widget, then us. */
function paintRoundOne(): void {
  document.head.innerHTML = '<style id="r1">h1{color:red}</style>';
  document.body.innerHTML =
    '<h1 id="hero">Round one</h1>' +
    '<p id="keeper">Unchanged paragraph</p>' +
    '<div id="gone">Only in round one</div>' +
    '<claude-feedback-widget doc-id="d-1" workspace-id="w-1"></claude-feedback-widget>' +
    '<script src="/widget.iife.js"></script>' +
    '<script src="/widget/mockup-live.js" data-cw-live></script>';
  document.body.className = 'round-one';
}

describe('mockup live swap', () => {
  beforeEach(() => {
    paintRoundOne();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('puts the new round on screen without touching the widget or the scroll', async () => {
    const { swapDocument } = await importLive();
    const widget = document.querySelector('claude-feedback-widget');
    // Something only the live element holds — if the swap recreated it, the
    // comment panel, the open thread and the socket would have gone with it.
    (widget as unknown as { keptState?: string }).keptState = 'panel-open';

    let scrolledTo: [number, number] | null = null;
    window.scrollTo = ((x: number, y: number) => {
      scrolledTo = [x, y];
    }) as typeof window.scrollTo;
    Object.defineProperty(window, 'scrollY', { value: 420, configurable: true });
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });

    swapDocument(ROUND_TWO);

    expect(document.querySelector('#hero')?.textContent).toBe('Round two');
    expect(document.querySelector('#gone')).toBeNull();
    expect(document.body.className).toBe('round-two');
    // The same element object, not a replacement that looks like it.
    expect(document.querySelector('claude-feedback-widget')).toBe(widget);
    expect((widget as unknown as { keptState?: string }).keptState).toBe('panel-open');
    expect(scrolledTo).toEqual([0, 420]);
  });

  it('replaces the round stylesheet instead of stacking a second one', async () => {
    const { swapDocument } = await importLive();
    // The script claims the page's stylesheets on start; without that claim
    // round one's rules survive round two and the mock renders as neither.
    for (const el of Array.from(document.head.querySelectorAll('style'))) {
      el.setAttribute('data-cw-mock-style', '');
    }
    swapDocument(ROUND_TWO);
    const styles = Array.from(document.head.querySelectorAll('style')).map((s) => s.id);
    expect(styles).toEqual(['r2']);
  });

  it('leaves a surviving element resolvable and a removed one not', async () => {
    const { swapDocument } = await importLive();
    const { anchors } = await import('@claude-workspaces/core');
    const before = {
      keeper: anchors.Element.createAnchor(document.querySelector('#keeper') as HTMLElement),
      gone: anchors.Element.createAnchor(document.querySelector('#gone') as HTMLElement),
    };

    swapDocument(ROUND_TWO);

    // The paragraph the round kept: the comment on it still points at the page.
    expect(anchors.Element.resolve(before.keeper, { root: document }).ok).toBe(true);
    // The div the round removed: nothing to point at, which is what the
    // widget renders as an outdated comment rather than dropping.
    expect(anchors.Element.resolve(before.gone, { root: document }).ok).toBe(false);
  });
});
