import { afterEach, describe, expect, it } from 'vitest';
import { attach, installSheets, styleOf } from './css-harness.ts';

/**
 * Calm by default (owner, 2026-09-13): "no badges. No blinking. Calm
 * experience that keeps the user in flow." Nothing on these pages loops,
 * pulses, blinks or flashes to draw the eye.
 *
 * Read off the PARSED stylesheets the pages load — the CSSOM the browser
 * builds, walked rule by rule, including rules inside `@media` — rather than
 * off their text, so a keyframe renamed or moved into a media block is still
 * found. The one infinite animation allowed is the spinner that runs while a
 * voice note the reader sent is on its way; it is also the positive control
 * that proves the walk sees infinite animations at all.
 */

/** The attention motion the calm sweep removed. Any of these back is a regression. */
const REMOVED_KEYFRAMES = [
  'summary-pending-pulse',
  'thread-wink',
  'doc-heading-arrive',
  'meeting-fix',
  'lz-caret-blink',
  'cw-inline-flash',
];

/** Selectors allowed an infinite animation: a spinner for work the reader started. */
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
      if (loops && !/none/.test(s.animation)) out.infinite.push(rule.selectorText);
      continue;
    }
    const nested = (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules;
    if (nested) walk(nested, out);
  }
}

function walkAll(): Walked {
  const out: Walked = { keyframes: [], infinite: [] };
  for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules, out);
  return out;
}

let uninstall: (() => void) | null = null;
afterEach(() => {
  uninstall?.();
  uninstall = null;
  document.body.innerHTML = '';
});

describe('calm by default — the app stylesheets', () => {
  it('bring back none of the removed attention keyframes', () => {
    uninstall = installSheets('tokens.css', 'styles.css', 'doc.css', 'board.css', 'settings.css');
    const { keyframes } = walkAll();
    // Control: the walk reads keyframes at all (the spinner's).
    expect(keyframes).toContain('voice-spin');
    for (const name of REMOVED_KEYFRAMES) expect(keyframes, name).not.toContain(name);
  });

  it('loop nothing forever except a spinner for work the reader started', () => {
    uninstall = installSheets('tokens.css', 'styles.css', 'doc.css', 'board.css', 'settings.css');
    const { infinite } = walkAll();
    // Control: the spinner is seen, so an empty remainder is a real result.
    expect(infinite).toEqual(expect.arrayContaining(SPINNERS));
    expect(infinite.filter((sel) => !SPINNERS.includes(sel))).toEqual([]);
  });

  it('paints a pending summary and a corrected word with no animation', () => {
    uninstall = installSheets('tokens.css', 'styles.css', 'doc.css');
    const line = attach('meeting-caption-line');
    expect(styleOf(attach('w is-fixed', { tag: 'span', parent: line })).animation).toBe('');
    expect(styleOf(attach('thread-discussion pending')).animation).toBe('');
    expect(styleOf(attach('doc-heading-title is-arriving', { tag: 'h1' })).animation).toBe('');
    // Control: the spinner, reached through the same harness, does animate.
    expect(styleOf(attach('voice-spinner')).animation).toContain('voice-spin');
  });

  it('draws no count badge on a topbar button', () => {
    uninstall = installSheets('tokens.css', 'styles.css', 'doc.css');
    const btn = attach('icon-btn', { tag: 'button' });
    expect(styleOf(attach('badge has-count', { tag: 'span', parent: btn })).display).toBe('none');
    // Control: the button itself is drawn.
    expect(styleOf(btn).display).not.toBe('none');
  });
});
