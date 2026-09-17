import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The tidy-up offer's stylesheet contract (meeting-cleanup-offer.ts).
 *
 * THE CASE THIS FILE EXISTS FOR IS THE FIRST ONE. The offer shipped as a row
 * at the end of the prose whose `display: flex` outranked the UA's `[hidden]`
 * rule, so it stood open at the end of EVERY doc — including docs that had
 * never held a recording — overlapping the notes and doing nothing when it
 * was pressed. Every logic test passed throughout: they read the `hidden`
 * PROPERTY, which was set correctly the whole time. Only the cascade knew.
 *
 * The rest is what a finger needs, because the device it is pressed on is an
 * iPad held at arm's length: that the answers are targets rather than lines
 * of text, and that they read as controls at rest — hover is not an answer on
 * a touch screen.
 *
 * Read off the cascade rather than the file's text: a rule that exists and
 * never reaches the element is what a regex cannot tell from one that works.
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('styles.css', 'doc.css');
  setViewport(IPAD);
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const scrim = (attrs?: Record<string, string>): HTMLElement =>
  attach('cleanup-offer', attrs ? { attrs } : {});
const goIn = (root: HTMLElement): HTMLElement =>
  attach('cleanup-offer-go', { tag: 'button', parent: root });

describe('the offer at the end of a finished meeting', () => {
  it('paints nothing at all until a recording has ended', () => {
    // Positive control: a sibling overlay whose `[hidden]` pair is correct
    // reads `none` through the same harness, so a `none` here is the rule
    // working rather than the cascade never arriving.
    expect(styleOf(attach('meeting-strip', { attrs: { hidden: '' } })).display).toBe('none');
    expect(styleOf(scrim({ hidden: '' })).display).toBe('none');
    // …and it is a real rule being overridden, not an element nothing reaches:
    // shown, the same selector lays out the dialog.
    expect(styleOf(scrim()).display).toBe('flex');
  });

  it('is a modal over the notes, not a row in the prose', () => {
    const root = styleOf(scrim());
    expect(root.position).toBe('fixed');
    expect(root.alignItems).toBe('center');
    expect(root.justifyContent).toBe('center');
    // A scrim: the notes are visible behind the question they are about.
    expect(root.background).toContain('rgba(27, 31, 35, 0.45)');
  });

  it('sits above every layer that could be open when a recording ends', () => {
    // A recording ends on its own clock, so it can land while a thread modal
    // or the thread view is open. Under them this would be an invisible
    // dialog holding the focus, whose Escape closed the layer the person can
    // actually see.
    const zOf = (el: HTMLElement): number => Number(styleOf(el).zIndex);
    const ours = zOf(scrim());
    for (const under of ['thread-modal', 'thread-modal-scrim', 'thread-view']) {
      expect(ours).toBeGreaterThan(zOf(attach(under)));
    }
    // Positive control: those layers do carry a z-index of their own, so the
    // comparison is against a number rather than against `auto` read as NaN.
    expect(zOf(attach('thread-modal'))).toBeGreaterThan(0);
  });

  it('gives each answer a target for a finger, not a line of text', () => {
    const go = styleOf(goIn(scrim()));
    // Padding rather than a fixed height, so a label that wraps on the phone
    // grows the target instead of centring a box inside it.
    // 12px each side over the 20px line box clears the 44px floor a finger
    // needs; the 9px this shipped with measured 40px on the iPad.
    expect(go.paddingTop).toBe('12px');
    expect(go.paddingBottom).toBe('12px');
    expect(go.paddingLeft).toBe('16px');
    expect(go.cursor).toBe('pointer');
  });

  it('reads as a control at rest — a border, not a hover', () => {
    const go = styleOf(goIn(scrim()));
    expect(go.borderStyle).toBe('solid');
    expect(go.borderTopWidth).toBe('1px');
    // Positive control: a bare button the cascade never reaches reads none.
    expect(styleOf(attach('', { tag: 'button' })).borderStyle).not.toBe('solid');
  });

  /**
   * The report under the question, and the same `[hidden]` trap the scrim
   * fell into: both of these elements are on the card from the moment it is
   * built and are shown only for a pass that has something to explain, so a
   * rule of theirs that outranked the UA's would leave an empty rule and an
   * empty paragraph under every question the dialog ever asks.
   */
  it('paints no reason list and no recovery line until a pass has explained itself', () => {
    const card = attach('cleanup-offer-card', { parent: scrim() });
    const reasons = attach('cleanup-offer-reasons', {
      tag: 'ul',
      parent: card,
      attrs: { hidden: '' },
    });
    const recovery = attach('cleanup-offer-recovery', {
      tag: 'p',
      parent: card,
      attrs: { hidden: '' },
    });
    expect(styleOf(reasons).display).toBe('none');
    expect(styleOf(recovery).display).toBe('none');
    // Positive control: the same two elements without the attribute paint.
    const shown = attach('cleanup-offer-reasons', { tag: 'ul', parent: card });
    expect(styleOf(shown).display).not.toBe('none');
  });

  it('sets the reasons apart from the notes behind them, and the recovery apart from the reasons', () => {
    const card = attach('cleanup-offer-card', { parent: scrim() });
    const reasons = attach('cleanup-offer-reasons', { tag: 'ul', parent: card });
    const row = attach('', { tag: 'li', parent: reasons });
    const recovery = attach('cleanup-offer-recovery', { tag: 'p', parent: card });
    // A rule down the left, never a bullet: a bullet would read as one of the
    // notes the tidy-up writes.
    expect(styleOf(reasons).listStyleType).toBe('none');
    expect(styleOf(row).borderLeftStyle).toBe('solid');
    // The recovery is the sentence to act on, so it is not the muted grey the
    // reasons take.
    expect(styleOf(recovery).color).not.toBe(styleOf(reasons).color);
  });

  it('lets the two answers wrap rather than shrink at phone width', () => {
    setViewport(PHONE);
    const actions = attach('cleanup-offer-actions', { parent: scrim() });
    expect(styleOf(actions).flexWrap).toBe('wrap');
    expect(styleOf(actions).justifyContent).toBe('flex-end');
  });
});

/**
 * TELLING "REFUSED" APART FROM "ON THE WIRE".
 *
 * Both used to be the primary's filled blue at `opacity: 0.6` with
 * `cursor: default` — one appearance for a request still in flight and for an
 * answer that will never be pressable. On an iPad there is no hover to
 * correct that guess, so a finished-success dialog and a five-second wait
 * looked the same and neither looked inert.
 *
 * The geometry of the card is measured in a real browser
 * (`cleanup-offer-layout-browser.test.ts`); what is read here is the cascade
 * that dresses each state, which happy-dom resolves in full.
 */
describe("the answers, in each of the dialog's three states", () => {
  /** A scrim in one phase, with the primary in the state that phase puts it
   *  in, and the spinner that sits inside it. */
  const inPhase = (
    phaseName: string,
    goAttrs: Record<string, string> = {},
  ): { go: HTMLElement; spinner: HTMLElement; dismiss: HTMLElement } => {
    const root = attach('cleanup-offer', { attrs: { 'data-phase': phaseName } });
    const actions = attach('cleanup-offer-actions', { parent: root });
    const dismiss = attach('cleanup-offer-dismiss', { tag: 'button', parent: actions });
    const go = attach('cleanup-offer-go', { tag: 'button', parent: actions, attrs: goAttrs });
    const spinner = attach('voice-spinner cleanup-offer-spinner', { parent: go });
    return { go, spinner, dismiss };
  };

  it("keeps the primary's fill for the one state it can be pressed in", () => {
    const { go, spinner } = inPhase('asking');
    const asking = styleOf(go);
    // The accent, whatever the token resolves to — read from the sheet rather
    // than pinned, so a palette change is not a failure here.
    expect(asking.backgroundColor).toBe(
      styleOf(document.documentElement).getPropertyValue('--accent').trim(),
    );
    expect(asking.backgroundColor.length).toBeGreaterThan(0);
    expect(asking.cursor).toBe('pointer');
    // Nothing fades it: happy-dom reads an unset property as '' (css-harness
    // says so), which is exactly what "no opacity rule reaches this" means.
    expect(asking.opacity).toBe('');
    // Nothing is moving: the pass has not been asked for.
    expect(styleOf(spinner).display).toBe('none');
  });

  it('drops the fill for an answer that is refused, rather than dimming it', () => {
    const { go } = inPhase('reported', { disabled: '' });
    const refused = styleOf(go);
    // Filled blue at 0.6 is still filled blue. This reads as the flat, inert
    // thing it is — and not by being faded, which is the shade that was doing
    // two jobs.
    expect(refused.backgroundColor).not.toBe(styleOf(inPhase('asking').go).backgroundColor);
    expect(refused.opacity).toBe('1');
    expect(refused.cursor).toBe('default');
  });

  it('tells a pass on the wire apart from one refused for ever', () => {
    const working = inPhase('working', { disabled: '' });
    const refused = inPhase('reported', { disabled: '' });
    // The mark, not the shade: a spinner that paints only while the request
    // is out, and a cursor that says the wait is temporary.
    expect(styleOf(working.spinner).display).toBe('block');
    expect(styleOf(refused.spinner).display).toBe('none');
    expect(styleOf(working.go).cursor).toBe('progress');
    expect(styleOf(refused.go).cursor).toBe('default');
    // The dismiss is refused for the same window, and says the same thing.
    expect(styleOf(working.dismiss).cursor).toBe('progress');
    // Positive control: the two states DO reach the same element through the
    // same harness, so a difference above is the rule and not a missing sheet.
    expect(styleOf(working.go).paddingTop).toBe(styleOf(refused.go).paddingTop);
  });

  it('paints no primary at all once it can never be pressed again', () => {
    // `display: flex` on the button outranks the UA\'s `[hidden]` rule, which
    // is the trap the scrim itself fell into.
    const { go } = inPhase('reported', { hidden: '', disabled: '' });
    expect(styleOf(go).display).toBe('none');
    // Positive control: without the attribute the same button paints.
    expect(styleOf(inPhase('reported', { disabled: '' }).go).display).not.toBe('none');
  });
});
