import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dockStyles } from '../src/styles-dock.ts';
import { widgetStyles } from '../src/styles.ts';
import { MIC_CSS } from '../src/widget-mic.ts';
import { comment, setup } from './voice-ui-harness.ts';

/**
 * Calm by default (owner, 2026-09-13): "no badges. No blinking." A widget
 * sits on somebody else's page, so anything it loops or flashes steals
 * attention from the page being reviewed.
 *
 * Read off the PARSED stylesheets — the CSSOM of each <style> the widget
 * installs, walked rule by rule through `@media` — not off their text. The
 * voice sheet is the one the real VoiceView puts in its shadow root. The one
 * infinite animation allowed is the spinner while a note the reader sent is
 * on its way, and it doubles as the control that the walk sees loops at all.
 */

/** Attention motion the calm sweep removed. Any of these back is a regression. */
const REMOVED_KEYFRAMES = ['cw-vpulse', 'cw-vsettle', 'cw-vring', 'cw-saved'];
const SPINNERS = ['.voice-spinner'];

interface Walked {
  keyframes: string[];
  infinite: string[];
}

function walk(rules: CSSRuleList, out: Walked): void {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSKeyframesRule) {
      out.keyframes.push(rule.name);
      continue;
    }
    if (rule instanceof CSSStyleRule) {
      const s = rule.style;
      const loops = `${s.animation} ${s.animationIterationCount}`.includes('infinite');
      if (loops) out.infinite.push(rule.selectorText);
      continue;
    }
    const nested = (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules;
    if (nested) walk(nested, out);
  }
}

function walkStyles(root: ParentNode, out: Walked): void {
  for (const style of Array.from(root.querySelectorAll('style'))) {
    if (style.sheet) walk(style.sheet.cssRules, out);
  }
}

beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function everySheet(): Walked {
  const out: Walked = { keyframes: [], infinite: [] };
  for (const css of [widgetStyles + dockStyles, MIC_CSS]) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    walkStyles(document.head, out);
    style.remove();
  }
  walkStyles(setup().shadow, out);
  return out;
}

describe('calm by default — the widget', () => {
  it('ships none of the removed attention keyframes', () => {
    const { keyframes } = everySheet();
    expect(keyframes, 'CONTROL: the walk reads keyframes').toContain('cw-voice-spin');
    for (const name of REMOVED_KEYFRAMES) expect(keyframes, name).not.toContain(name);
  });

  it('loops nothing forever except a spinner for work the reader started', () => {
    const { infinite } = everySheet();
    expect(infinite, 'CONTROL: the spinner is seen').toEqual(expect.arrayContaining(SPINNERS));
    expect(infinite.filter((sel) => !SPINNERS.includes(sel))).toEqual([]);
  });

  it('records with a steady dot and no level bars, and a settled comment rings nothing', () => {
    const t = setup();
    t.add(comment({ target: 2 }));
    expect(t.view.live.querySelector('.vdot'), 'CONTROL: the dot is drawn').not.toBeNull();
    expect(t.view.live.querySelector('.vbars')).toBeNull();
    t.add(comment({ target: 2, final: true }));
    expect(t.card(), 'CONTROL: the comment settled').not.toBeNull();
    expect(t.shadow.querySelector('.vring')).toBeNull();
  });
});
