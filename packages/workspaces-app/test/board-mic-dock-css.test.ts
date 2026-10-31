import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The hold-to-talk mic is DOCKED in the workspace nav, not floating over the
 * page.
 *
 * Bryan, 2026-08-19: *"can we make a more durable fix for the mic? Place it in
 * a fixed location instead of floating. Put it in bottom left of left navbar in
 * desktop views. And in the bottom tab on mobile, and give it a distinct look
 * and keep it slightly separate from the navbar so it's clear it's not a
 * navbar item"*.
 *
 * The float is the bug. A `position: fixed` launcher in the bottom-left corner
 * lands on top of whatever the page happens to put there — at 430px it sat on
 * "Record answer", the one control the review queue exists to deliver. This
 * branch answered that twice by reserving space around the mic (152fb3f,
 * 50c9619); a reservation is a promise that nothing will ever be positioned
 * under one particular column, and it has to be renewed at every width where
 * the promise could be broken. Docking the mic makes the promise unnecessary:
 * the mic lives in the nav's own column and no page content is ever behind it.
 *
 * The rail above 1100px and the bottom bar at or under it are two different
 * layouts of the same element (the 901–1100px band was a sticky strip at the
 * top until Bryan, 31 Oct: "Just put it at the bottom"), and every claim
 * below is a claim about ONE of them. That is what the old text version of this file could not
 * express: it regexed `styles.css` and `board.css` for declarations and then
 * reasoned about which `@media` block they had been found inside, which
 * passes whether or not the query matches at the width a reader is on. Here
 * the nav is built at 1180, at 1000 and at 430 and the computed value is read,
 * so the tier boundaries are measured rather than argued.
 *
 * The mic itself came out on 2026-10-30 (it no longer did anything the lead
 * chat does not); the dock now holds the lead chat's agent button, and what
 * is left here is the dock's own placement at each width.
 */
/** The 901–1100px band: the bottom bar, as on a phone. */
const STRIP = { width: 1000, height: 800 } as const;

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('board.css', 'styles.css');
  publishInsets();
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.body.className = '';
  document.documentElement.style.cssText = '';
});

/**
 * Publish the runtime insets the app publishes.
 *
 * `keyboard-inset.ts` writes `--kb-bottom` on the root element before
 * anything is drawn, and `:root { --safe-bottom: env(safe-area-inset-bottom,
 * 0px) }` resolves to 0px on a device with no home indicator. happy-dom drops
 * `env()`, and does not honour a `var()` fallback inside `calc()` either, so
 * without these a rule like `bottom: calc(16px + var(--kb-bottom, 0px) +
 * var(--safe-bottom, 0px))` is discarded whole and the property reads as if
 * the rule never existed. Setting them puts the chain back — unevaluated,
 * which is why the assertions below compare two chains rather than pixels.
 */
function publishInsets(kb = '0px', safe = '0px'): void {
  document.documentElement.style.setProperty('--kb-bottom', kb);
  document.documentElement.style.setProperty('--safe-bottom', safe);
}

/** A token as the cascade resolves it, so no literal is copied from a rule. */
const token = (name: string, el: Element = document.documentElement) =>
  styleOf(el).getPropertyValue(name);

const px = (v: string) => Number.parseFloat(v);
const z = (v: string) => Number.parseFloat(v);

/** The nav and its dock. */
function nav(viewport: { width: number; height: number }, navClasses = 'board-nav') {
  setViewport(viewport);
  const el = attach(navClasses, { tag: 'nav' });
  const dock = attach('board-nav-dock', { parent: el });
  return {
    nav: styleOf(el),
    dock: styleOf(dock),
    item: styleOf(attach('board-nav-item', { tag: 'a', parent: el })),
  };
}

/** The task overlay and the settings page, whose layers the nav sits under.
 *  The settings surface is the full-screen page, not the panel of rows inside
 *  it: the popover that carried its own layer is gone. */
function overlays(viewport: { width: number; height: number }) {
  setViewport(viewport);
  return {
    detail: styleOf(attach('board-detail')),
    settings: styleOf(attach('settings-shell board-settings-view')),
  };
}

describe('the docked mic reads as a control, not as a nav item', () => {
  it('separates the dock from the items with a divider and a gap', () => {
    const { dock } = nav(IPAD);
    expect(px(dock.borderTopWidth)).toBe(1);
    expect(dock.borderTopStyle).toBe('solid');
    expect(dock.borderTopColor).toBe(token('--border'));
    // *"keep it slightly separate from the navbar"* — the divider alone still
    // reads as a list separator; the gap is what sets it apart.
    expect(px(dock.paddingTop)).toBeGreaterThanOrEqual(8);
    expect(px(dock.marginTop)).toBeGreaterThanOrEqual(8);
  });
});

describe('the phone gets the mic in the bottom tab bar', () => {
  it('puts the dock at the bar’s left end, divided from the tabs', () => {
    // The horizontal treatment is written once, in the ≤1100px strip band, and
    // the ≤900px bar inherits it — the bar IS that strip, pinned to the
    // bottom. Both are read here, so a rule that stops reaching the phone
    // fails rather than being argued about from source order.
    for (const viewport of [STRIP, PHONE]) {
      const { dock } = nav(viewport);
      // The rail's top divider becomes a side one.
      expect(dock.borderTopStyle, `still a top divider at ${viewport.width}px`).toBe('none');
      expect(px(dock.borderRightWidth)).toBe(1);
      // The mic has always been bottom-LEFT, and the feedback widget's pencil
      // owns the opposite corner; `order` puts it at the head of the bar
      // without moving it in the DOM, where it belongs after the pages it is
      // not one of.
      expect(dock.order).toBe('-1');
      // …and it stays positioned, or the readout absolutely positioned against
      // it would silently re-anchor to the viewport.
      expect(dock.position).toBe('relative');
    }

    const phone = nav(PHONE);
    // Positive control: this is the width that pins that strip to the bottom.
    expect(phone.nav.position).toBe('fixed');
    // Inset from the screen edge, and NOT `flex: 1` like the tabs beside it.
    expect(phone.dock.paddingLeft).toBe('10px');
    expect(phone.dock.flexGrow).not.toBe('1');
  });

  it('undoes the rail’s sticky offset when the dock joins a horizontal bar', () => {
    // `bottom: 8px` is the STICKY rail's offset — how far off the scrollport's
    // foot the mic parks. `position: relative` keeps reading the same
    // declaration, and a relatively positioned box with a `bottom` is PAINTED
    // that far ABOVE its flow position: the dock's stretched box, divider and
    // all, would ride 8px out of line with the tabs beside it and poke over
    // the bar's top border. A media query adds no specificity, so the reset
    // has to be written — the rule the rail block states in its own comment.
    // Positive control first: the offset really is there on the rail.
    expect(px(nav(IPAD).dock.bottom)).toBeGreaterThan(0);
    expect(nav(STRIP).dock.bottom).toBe('auto');
    expect(nav(PHONE).dock.bottom).toBe('auto');
  });

  it('gives up the rail’s layer, because the strip has page content behind it', () => {
    // The rail earns `z-index: 70` on one premise: nothing of the page sits
    // behind its column, so a mic painted over the task overlay covers
    // nothing. In this band the nav is a top strip and the centred panel runs
    // underneath it, so the premise is false and the same number reproduces
    // the float. Measured 2026-08-19 at 905px: the mic covered the panel
    // whole, clipped the first characters of the task title, and
    // `elementFromPoint` over the intersection returned `BUTTON.voice-mic` —
    // it took the click as well as the pixels.
    expect(nav(STRIP).dock.zIndex).toBe('auto');
    expect(nav(PHONE).dock.zIndex).toBe('auto');
    // Positive control, and the point of the whole test: the number this
    // overrides is really there on the rail. Without this the assertions above
    // pass just as happily against a dock that never had a layer.
    expect(z(nav(IPAD).dock.zIndex)).toBeGreaterThan(0);
  });

  it('leaves the bar no higher than the full-screen overlays', () => {
    // The bar itself stays under the detail overlay: an overlay that covers
    // the board covers the pages you could navigate to instead of it. Equal
    // z-index is enough, because the detail overlay comes later in the shell
    // markup. (What must NOT be covered is the mic — see the describe below,
    // where the overlay is kept off the bar's row entirely.)
    for (const viewport of [STRIP, PHONE]) {
      const bar = z(nav(viewport).nav.zIndex);
      expect(bar, `the bar lost its layer at ${viewport.width}px`).not.toBeNaN();
      expect(bar).toBeLessThanOrEqual(z(overlays(viewport).detail.zIndex));
      expect(bar).toBeLessThanOrEqual(z(overlays(viewport).settings.zIndex));
    }
  });
});

/**
 * The 901–1100px band is the bottom bar too (Bryan, 31 Oct: "Just put it at
 * the bottom").
 *
 * It used to be a third layout: a strip pinned to the TOP of the content with
 * `position: sticky`, between the rail above 1100 and the phone's fixed bar
 * under 900. Now one block, ≤1100px, makes the nav a fixed bar along the foot
 * of the screen, so the iPad-in-portrait and laptop-window widths get the bar
 * a phone gets.
 */
describe('at or under 1100px the nav is the bottom bar', () => {
  it('fixes the nav to the bottom edge, at 1000 as at 430', () => {
    for (const viewport of [STRIP, PHONE]) {
      const bar = nav(viewport).nav;
      expect(bar.position, `at ${viewport.width}px`).toBe('fixed');
      expect(bar.top, `at ${viewport.width}px`).toBe('auto');
      expect(bar.bottom, `at ${viewport.width}px`).toBe('0px');
      // Opaque, or the page shows through the bar it scrolls under.
      expect(bar.backgroundColor).toBe(token('--bg-panel'));
    }
    // Positive control: the rail above 1100 is not fixed.
    expect(nav(IPAD).nav.position).toBe('');
  });

  it('lays the tabs out as icon over label, sharing the bar evenly', () => {
    for (const viewport of [STRIP, PHONE]) {
      const { item } = nav(viewport);
      expect(item.flexDirection, `at ${viewport.width}px`).toBe('column');
      expect(item.flexGrow, `at ${viewport.width}px`).toBe('1');
    }
    // Positive control: the rail's items are rows.
    expect(nav(IPAD).item.flexDirection).not.toBe('column');
  });

  it('keeps the board in one column once the nav has left the flow', () => {
    // A fixed nav leaves its grid track empty, and auto-placement would put
    // the board into the rail's narrow track. A flex column has no tracks.
    setViewport(STRIP);
    const banded = styleOf(attach('board-main'));
    expect(banded.display).toBe('flex');
    expect(banded.flexDirection).toBe('column');
    // `align-items: start` on the base rule would shrink the board to its own
    // content in a column flex container; the undo has to be written.
    expect(banded.alignItems).toBe('stretch');
    // Positive control: the base layout really is the grid this overrides.
    setViewport(IPAD);
    const base = styleOf(attach('board-main'));
    expect(base.display).toBe('grid');
    expect(base.alignItems).toBe('start');
  });

  it('publishes the bar’s height, and the board’s tail clears it, at 1000 as at 430', () => {
    document.body.className = 'board-body';
    for (const viewport of [STRIP, PHONE]) {
      setViewport(viewport);
      const barHeight = token('--board-bottom-bar', document.body);
      expect(px(barHeight), `at ${viewport.width}px`).toBeGreaterThan(0);
      expect(styleOf(attach('', { attrs: { id: 'board-root' } })).paddingBottom).toContain(
        barHeight,
      );
    }
    // Positive control: above 1100 there is no bar and nothing to clear.
    setViewport(IPAD);
    expect(px(token('--board-bottom-bar', document.body))).toBe(0);
  });
});

describe('the task detail never lands on top of the docked mic', () => {
  /**
   * Docking traded one overlap for another. `.board-detail` is `position: fixed;
   * inset: 0` and comes after `.board-main` in the shell, so the panel and its
   * scrim cover the nav — and the mic went into the nav. That is not cosmetic:
   * hold-to-talk from inside an open task is a shipped capability (the voice
   * context sends `surface: 'task'`), and the keyboard half of it needs a
   * Space key a phone does not have. The mic has to stay reachable while a
   * task is open, at every width.
   */
  it('lifts the dock — and only the dock — over the panel’s scrim', () => {
    // Where the nav is a static rail or strip (≥901px) it opens no stacking
    // context, so the dock alone can sit above the overlay. The rail's column
    // holds no page content, so a mic painted over that scrim covers nothing —
    // while a scrim painted over the mic hands the click to the scrim's own
    // close-on-outside handler and dismisses the task instead.
    const dock = nav(IPAD).dock;
    expect(z(dock.zIndex), 'the dock has no layer of its own').not.toBeNaN();
    expect(z(dock.zIndex)).toBeGreaterThan(z(overlays(IPAD).detail.zIndex));
    // Only the dock: the pages stay under the overlay, so this lifts the mic
    // rather than restoring a nav you can click through a modal.
    expect(nav(IPAD).nav.zIndex).toBe('');
  });

  it('stops the phone’s full-screen panel above the bar the mic is in', () => {
    // A fixed bar IS a stacking context whatever its z-index, so at ≤900px no
    // z-index on the dock can escape it. The answer is geometric instead: the
    // overlay ends where the bar begins, so the mic is not merely on top of
    // nothing — nothing is over it.
    document.body.className = 'board-body';
    setViewport(PHONE);
    const barHeight = token('--board-bottom-bar', document.body);
    // Positive control: the bar's height really is published at this width, so
    // the offset below resolves to the bar rather than to a 0 fallback.
    expect(px(barHeight)).toBeGreaterThan(0);
    const overlay = styleOf(attach('board-detail'));
    expect(overlay.bottom).not.toBe('0px');
    expect(overlay.bottom).toContain(barHeight);
    // …and it clears the home-indicator inset the bar itself pads for: moving
    // that inset moves the overlay's foot with it.
    const flat = overlay.bottom;
    publishInsets('0px', '34px');
    expect(styleOf(attach('board-detail')).bottom).not.toBe(flat);
    // Control: at 1180 the overlay owes the bar nothing, because there is none.
    publishInsets();
    setViewport(IPAD);
    expect(styleOf(attach('board-detail')).bottom).toBe('0px');
  });
});

describe('the nav does not clip what hangs off it', () => {
  it('is not clipped by the nav it now hangs off', () => {
    // The indicator is up to 840px wide and overflows a 170px rail by design.
    // An `overflow-x` on the nav would clip it — and would also make the nav a
    // scroll container, which silently breaks the dock's `position: sticky`.
    for (const viewport of [IPAD, STRIP, PHONE]) {
      const { nav: bar } = nav(viewport);
      expect(bar.overflow, `the nav clips at ${viewport.width}px`).toBe('');
      expect(bar.overflowX, `the nav scrolls at ${viewport.width}px`).toBe('');
    }
  });
});

describe('the float-era mitigations are gone with the float', () => {
  it('drops the tail reservation the fixed mic forced on the task panel', () => {
    // 152fb3f and 50c9619 reserved 24+60px under the panel at every width the
    // panel's left edge reached the mic's column (a ≤1023px block). Nothing is
    // in that column any more, so the panel's tail is the same at every width.
    setViewport(IPAD);
    const wide = styleOf(attach('board-detail-panel')).paddingBottom;
    expect(px(wide), 'the task panel is unstyled').toBeGreaterThan(0);
    for (const width of [1023, 1000, 900, 430]) {
      setViewport({ width, height: 800 });
      expect(
        styleOf(attach('board-detail-panel')).paddingBottom,
        `the panel still reserves mic clearance at ${width}px`,
      ).toBe(wide);
    }
    // Positive control: the phone's own page tail still clears the bottom bar —
    // that reservation is about the BAR, which is still fixed, and is not one
    // of the mic mitigations.
    document.body.className = 'board-body';
    setViewport(PHONE);
    const barHeight = token('--board-bottom-bar', document.body);
    expect(px(barHeight)).toBeGreaterThan(0);
    expect(styleOf(attach('', { attrs: { id: 'board-root' } })).paddingBottom).toContain(barHeight);
  });

  it('drops the right-aligned submits the fixed mic forced on every composer', () => {
    // The RIGHT alignment existed only to keep a submit out of the mic's
    // column. A form is free to lay its buttons out however the form wants
    // again — `.board-decide-form` still starts its button, which is a layout
    // choice about the form and doubles here as the control proving this read
    // can see an `align-self` at all.
    setViewport(IPAD);
    let sawAnAlignment = false;
    for (const form of ['board-comment-form', 'board-decide-form']) {
      const el = attach(form, { tag: 'form' });
      // Positive control: the composers themselves are still styled.
      expect(styleOf(el).display, `.${form} is unstyled`).not.toBe('');
      const submit = attach('', { tag: 'button', parent: el, attrs: { type: 'submit' } });
      const align = styleOf(submit).alignSelf;
      expect(align, `.${form} still right-aligns to dodge the mic`).not.toBe('flex-end');
      if (align !== '') sawAnAlignment = true;
    }
    expect(sawAnAlignment, 'no composer declares an align-self, so the read is blind').toBe(true);
  });
});
