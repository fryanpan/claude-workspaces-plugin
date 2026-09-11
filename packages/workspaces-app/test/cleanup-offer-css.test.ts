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

  it('lets the two answers wrap rather than shrink at phone width', () => {
    setViewport(PHONE);
    const actions = attach('cleanup-offer-actions', { parent: scrim() });
    expect(styleOf(actions).flexWrap).toBe('wrap');
    expect(styleOf(actions).justifyContent).toBe('flex-end');
  });
});
