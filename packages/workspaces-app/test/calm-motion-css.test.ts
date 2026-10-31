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
 * found. No rule on these pages animates forever. The positive control is a
 * probe sheet the test installs beside them, which proves the walk sees a
 * keyframe and an infinite animation at all.
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

/** A sheet the pages never load, holding one looping rule for the walk to find. */
const PROBE_CSS =
  '@keyframes calm-probe-spin { to { transform: rotate(360deg); } } .calm-probe { animation: calm-probe-spin 1s linear infinite; }';

function installProbe(): () => void {
  const el = document.createElement('style');
  el.textContent = PROBE_CSS;
  document.head.append(el);
  return () => el.remove();
}

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
let unprobe: (() => void) | null = null;
afterEach(() => {
  uninstall?.();
  uninstall = null;
  unprobe?.();
  unprobe = null;
  document.body.innerHTML = '';
});

describe('calm by default — the app stylesheets', () => {
  it('bring back none of the removed attention keyframes', () => {
    uninstall = installSheets('tokens.css', 'styles.css', 'doc.css', 'board.css', 'settings.css');
    unprobe = installProbe();
    const { keyframes } = walkAll();
    // Control: the walk reads keyframes at all (the probe's).
    expect(keyframes).toContain('calm-probe-spin');
    for (const name of REMOVED_KEYFRAMES) expect(keyframes, name).not.toContain(name);
  });

  it('loop nothing forever', () => {
    uninstall = installSheets('tokens.css', 'styles.css', 'doc.css', 'board.css', 'settings.css');
    unprobe = installProbe();
    const { infinite } = walkAll();
    // Control: the probe is seen, so an empty remainder is a real result.
    expect(infinite).toContain('.calm-probe');
    expect(infinite.filter((sel) => sel !== '.calm-probe')).toEqual([]);
  });

  it('paints a pending summary and a corrected word with no animation', () => {
    uninstall = installSheets('tokens.css', 'styles.css', 'doc.css');
    const line = attach('meeting-caption-line');
    expect(styleOf(attach('w is-fixed', { tag: 'span', parent: line })).animation).toBe('');
    expect(styleOf(attach('thread-discussion pending')).animation).toBe('');
    expect(styleOf(attach('doc-heading-title is-arriving', { tag: 'h1' })).animation).toBe('');
    // Control: the probe, reached through the same harness, does animate.
    unprobe = installProbe();
    expect(styleOf(attach('calm-probe')).animation).toContain('calm-probe-spin');
  });

  it('draws no count badge on a topbar button', () => {
    uninstall = installSheets('tokens.css', 'styles.css', 'doc.css');
    const btn = attach('icon-btn', { tag: 'button' });
    expect(styleOf(attach('badge has-count', { tag: 'span', parent: btn })).display).toBe('none');
    // Control: the button itself is drawn.
    expect(styleOf(btn).display).not.toBe('none');
  });
});
