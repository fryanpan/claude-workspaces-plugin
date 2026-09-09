import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The indicator's stylesheet contract, read off the cascade rather than off
 * the file's text.
 *
 * The rule that matters most is the dullest one. The marker this replaced
 * gave itself a display value and never wrote the `[hidden]` rule to match,
 * so the UA's `[hidden] { display: none }` lost on specificity and a pill at
 * zero stayed on screen saying nothing. Both the pill and the strip around
 * it are checked, because either one left showing paints an empty bar.
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

function indicator(): { strip: HTMLElement; pill: HTMLElement } {
  const pane = document.createElement('section');
  pane.id = 'editor-pane';
  const strip = document.createElement('div');
  strip.className = 'edge-strip edge-strip-top';
  const pill = document.createElement('button');
  pill.className = 'cw-edge cw-edge-top';
  strip.appendChild(pill);
  pane.appendChild(strip);
  document.body.appendChild(pane);
  return { strip, pill };
}

describe('the new-content indicator', () => {
  it('a hidden pill and a hidden strip actually leave the screen', () => {
    const { strip, pill } = indicator();
    // The positive control: shown, both have a display value of their own,
    // which is exactly what beat `[hidden]` before.
    expect(styleOf(strip).display).toBe('flex');
    expect(styleOf(pill).display).toBe('inline-flex');
    strip.hidden = true;
    pill.hidden = true;
    expect(styleOf(strip).display).toBe('none');
    expect(styleOf(pill).display).toBe('none');
  });

  it('an ask that way is the only thing that earns colour', () => {
    const { pill } = indicator();
    const plain = styleOf(pill).backgroundColor;
    pill.classList.add('has-ask');
    expect(styleOf(pill).backgroundColor).not.toBe(plain);
  });

  it('leaves the flow only once the module says it has a column to sit in', () => {
    // Not a width rule: the balloon column is a stored preference, so a wide
    // screen with the cards inline has no column and the strip must stay a
    // row. The class is the module's claim that it measured one.
    const { strip } = indicator();
    expect(styleOf(strip).position).not.toBe('absolute');
    strip.classList.add('is-floating');
    expect(styleOf(strip).position).toBe('absolute');
    setViewport(PHONE);
    expect(styleOf(strip).position).toBe('absolute');
  });

  it('the seated dock drops the centring transform that put it over the prose', () => {
    const row = document.createElement('div');
    row.className = 'doc-floats';
    document.body.appendChild(row);
    // The control: unseated, it is still the centred pill, which is what laid
    // it over the body text.
    expect(styleOf(row).transform).toContain('-50%');
    row.classList.add('is-floating');
    expect(styleOf(row).transform).toBe('none');
  });

  it('the pill stays clear of the widget bubble at phone width', () => {
    setViewport(PHONE);
    const { pill } = indicator();
    expect(styleOf(pill).maxWidth).toBe('calc(100% - 84px)');
  });

  it('the outgoing half of a note card’s crossfade is taken out of the flow', () => {
    const card = document.createElement('div');
    card.className = 'balloon margin-note';
    const out = document.createElement('span');
    out.className = 'mn-line is-out';
    const held = document.createElement('span');
    held.className = 'mn-line';
    card.append(held, out);
    document.body.appendChild(card);
    // Both fade over a second; only the outgoing one is lifted out, so the
    // card cannot change height mid-fade.
    expect(styleOf(held).transition).toContain('1000ms');
    expect(styleOf(held).position).not.toBe('absolute');
    expect(styleOf(out).position).toBe('absolute');
    expect(styleOf(out).opacity).toBe('0');
  });
});
