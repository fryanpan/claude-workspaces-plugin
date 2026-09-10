import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The tidy-up offer's stylesheet contract (meeting-cleanup-offer.ts).
 *
 * The offer is the one control a finished meeting leaves on the page, and the
 * device it is pressed on is an iPad held at arm's length. So what is read
 * here is what a finger needs: that the button is a target rather than a link
 * of text, that it reads as a control at rest (hover is not an answer on a
 * touch screen), and that a refusal message goes UNDER the controls at phone
 * width instead of squeezing them.
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

const offerRow = (): HTMLElement => attach('cleanup-offer');
const goIn = (row: HTMLElement): HTMLElement =>
  attach('cleanup-offer-go', { tag: 'button', parent: row });

describe('the offer at the end of a finished meeting', () => {
  it('is a target for a finger, not a line of text', () => {
    const go = styleOf(goIn(offerRow()));
    // Padding rather than a fixed height, so a label that wraps on the phone
    // grows the target instead of centring a box inside it.
    expect(go.paddingTop).toBe('9px');
    expect(go.paddingBottom).toBe('9px');
    expect(go.paddingLeft).toBe('14px');
    expect(go.cursor).toBe('pointer');
  });

  it('reads as a control at rest — a border, not a hover', () => {
    const go = styleOf(goIn(offerRow()));
    expect(go.borderStyle).toBe('solid');
    expect(go.borderTopWidth).toBe('1px');
    // Positive control: a bare button the cascade never reaches reads none.
    expect(styleOf(attach('', { tag: 'button' })).borderStyle).not.toBe('solid');
  });

  it('lays the controls in a row, and the row sits under the notes', () => {
    const row = styleOf(offerRow());
    expect(row.display).toBe('flex');
    expect(row.alignItems).toBe('center');
    // A gap from the last note, not against it.
    expect(row.marginTop).toBe('14px');
  });

  it('hugs the last note instead of sitting below the click-to-type runway', () => {
    // The first headless render at 430 put the offer a full screen below the
    // notes: `#editor > .ProseMirror` carries a 60vh floor so an empty doc is
    // clickable, and the offer is appended after it.
    const editor = attach('', { attrs: { id: 'editor' } });
    const prose = attach('ProseMirror', { parent: editor });
    // Control: with no offer showing, the runway is still there.
    expect(styleOf(prose).minHeight).not.toBe('auto');
    attach('cleanup-offer', { parent: editor });
    expect(styleOf(prose).minHeight).toBe('auto');
  });

  it('lets a refusal message drop below the controls at phone width', () => {
    setViewport(PHONE);
    const row = offerRow();
    const note = attach('cleanup-offer-note', { parent: row });
    expect(styleOf(row).flexWrap).toBe('wrap');
    expect(styleOf(note).flexBasis).toBe('100%');
    // …and not on the tablet, where they fit on one line.
    setViewport(IPAD);
    expect(styleOf(offerRow()).flexWrap).toBe('nowrap');
  });
});
