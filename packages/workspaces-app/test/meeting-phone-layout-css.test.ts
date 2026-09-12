/**
 * The meeting page as a phone lays it out — the three rules Bryan asked for
 * after holding a meeting on his own phone (2026-09-11):
 *
 *   1. the transcript scrolls and stays ABOVE Make Plan and Review, instead of
 *      ending behind them with nothing left to scroll;
 *   2. no status bar under the recording bar — the indicator blinks in the top
 *      right and nothing else is dedicated to it;
 *   3. Make Plan and Review are much shorter and lose their subtitles.
 *
 * These are the CASCADE half: which rule wins at 430 and which at 1180, read
 * as computed values against the real sheets. The GEOMETRY half — that the
 * runway rule 1 sets actually lifts the transcript clear of the dock at
 * maximum scroll — needs a layout engine and lives in
 * `meeting-phone-layout-browser.test.ts`. happy-dom lays nothing out and
 * drops a declaration whose `calc()` carries `max()`, which is exactly the
 * padding under test, so `--lz-runway` is what is legible here: the variable
 * that padding is built from.
 *
 * Every case names the line whose removal fails it, and each has a control at
 * the other viewport or the other DOM shape, so a rule that stopped applying
 * everywhere cannot pass by satisfying a negative on its own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

let removeSheets = () => {};
beforeEach(() => {
  removeSheets = installSheets('tokens.css', 'styles.css', 'doc.css');
  document.body.replaceChildren();
});
afterEach(() => {
  removeSheets();
  setViewport(IPAD);
});

/** The pane as the editor builds it: the scroller, the zone in it, the dock
 *  beside it. `floating` is the wide-layout seat in the balloon margin. */
function pane(opts: { zone?: boolean; float?: boolean; floating?: boolean } = {}): {
  editor: HTMLElement;
  dock: HTMLElement | null;
  float: HTMLElement | null;
} {
  const section = document.createElement('section');
  section.id = 'editor-pane';
  document.body.appendChild(section);
  const editor = document.createElement('div');
  editor.id = 'editor';
  section.appendChild(editor);
  const prose = document.createElement('div');
  prose.className = 'ProseMirror';
  editor.appendChild(prose);
  if (opts.zone !== false) {
    const zone = document.createElement('div');
    zone.className = 'live-zone';
    editor.appendChild(zone);
  }
  let dock: HTMLElement | null = null;
  let float: HTMLElement | null = null;
  if (opts.float !== false) {
    dock = document.createElement('div');
    dock.className = opts.floating ? 'doc-floats is-floating' : 'doc-floats';
    section.appendChild(dock);
    float = document.createElement('button');
    float.className = 'plan-float plan-float--make';
    dock.appendChild(float);
  }
  return { editor, dock, float };
}

/** A float with its two lines, as plan-gate.ts and review-float.ts build it.
 *  `face` is the per-state class the renderers toggle. */
function floatWithSubtitle(
  parent: Element,
  face = 'plan-float--make',
): { button: HTMLElement; sub: HTMLElement } {
  const button = document.createElement('button');
  button.className = `plan-float ${face}`;
  const label = document.createElement('span');
  label.className = 'plan-float-label';
  label.textContent = 'Make Plan';
  const sub = document.createElement('span');
  sub.className = 'plan-float-sub';
  sub.textContent = 'Ask your agent to create a plan';
  button.append(label, sub);
  parent.appendChild(button);
  return { button, sub };
}

describe('the transcript clears the floats (rule 1)', () => {
  it('a phone meeting reserves the dock’s footprint under the transcript', () => {
    setViewport(PHONE);
    const { editor } = pane();
    expect(styleOf(editor).getPropertyValue('--lz-runway').trim()).toBe('104px');
  });

  it('control — a doc with no dock over its pane reserves nothing', () => {
    setViewport(PHONE);
    const { editor } = pane({ float: false });
    expect(styleOf(editor).getPropertyValue('--lz-runway').trim()).toBe('');
  });

  it('control — a dock seated in the balloon margin covers no prose, so it reserves nothing', () => {
    setViewport(IPAD);
    const { editor } = pane({ floating: true });
    expect(styleOf(editor).getPropertyValue('--lz-runway').trim()).toBe('');
  });

  it('control — the same pane at the same width DOES reserve it once the dock is over the prose', () => {
    setViewport(IPAD);
    const { editor } = pane({ floating: false });
    expect(styleOf(editor).getPropertyValue('--lz-runway').trim()).toBe('104px');
  });
});

describe('no status bar under the recording bar (rule 2)', () => {
  it('a phone gives up the strip’s row while it has only words to show', () => {
    setViewport(PHONE);
    const strip = attach('meeting-strip is-live');
    attach('meeting-feed-inner meeting-caption-line', { parent: strip });
    expect(styleOf(strip).display).toBe('none');
  });

  it('but keeps it for a sentence nothing else can say — a refused mic, a lost stream', () => {
    setViewport(PHONE);
    const strip = attach('meeting-strip is-live');
    const line = attach('meeting-feed-inner meeting-caption-line', { parent: strip });
    attach('meeting-note meeting-stream-alarm', { tag: 'span', parent: line });
    expect(styleOf(strip).display).toBe('flex');
  });

  it('control — an iPad keeps the strip, words and all', () => {
    setViewport(IPAD);
    const strip = attach('meeting-strip is-live');
    attach('meeting-feed-inner meeting-caption-line', { parent: strip });
    expect(styleOf(strip).display).toBe('flex');
  });

  it('the indicator that is left blinks: the Record button’s dot, top right', () => {
    setViewport(PHONE);
    const record = attach('meeting-record is-live', { tag: 'button' });
    const dot = attach('meeting-record-dot', { tag: 'span', parent: record });
    // happy-dom does not expand the `animation` shorthand into
    // `animation-name`, so the shorthand is what there is to read.
    expect(styleOf(dot).animation).toContain('meeting-blink');
  });

  it('control — on an iPad the strip’s own blinker is still the blinking one', () => {
    setViewport(IPAD);
    const record = attach('meeting-record is-live', { tag: 'button' });
    const dot = attach('meeting-record-dot', { tag: 'span', parent: record });
    const blinker = attach('meeting-blinker', { tag: 'span' });
    expect(styleOf(dot).animation).not.toContain('meeting-blink');
    // The positive control: the sheet IS reaching this document, and the
    // strip's own blinker is still the thing that blinks at this width.
    expect(styleOf(blinker).animation).toContain('meeting-blink');
  });
});

describe('Make Plan and Review are one short line (rule 3)', () => {
  it('a phone drops the subtitle', () => {
    setViewport(PHONE);
    const { sub } = floatWithSubtitle(document.body);
    expect(styleOf(sub).display).toBe('none');
  });

  it('and the pill stops padding itself past the 44px tap floor', () => {
    setViewport(PHONE);
    const { button } = floatWithSubtitle(document.body);
    const style = styleOf(button);
    expect(style.paddingTop).toBe('8px');
    expect(style.paddingBottom).toBe('8px');
    expect(style.minHeight).toBe('44px');
  });

  it('the Review ask loses it too — both faces a meeting presses', () => {
    setViewport(PHONE);
    const { sub } = floatWithSubtitle(document.body, 'review-float review-float--ask');
    expect(styleOf(sub).display).toBe('none');
  });

  it('but a receipt keeps its second line: who asked, and whether anyone is listening', () => {
    // Not decoration — it is the answer to "did that go anywhere", and it is
    // the line that was added after a Review press with the lead seat empty
    // read as if an agent were coming. Approve Plan's subtitle is the
    // consequence of a press that creates tickets, and keeps it for the same
    // reason.
    setViewport(PHONE);
    for (const face of ['plan-float--requested', 'plan-float--approve']) {
      const { sub } = floatWithSubtitle(document.body, face);
      expect(styleOf(sub).display, face).not.toBe('none');
    }
  });

  it('control — an iPad keeps both lines and the taller pill', () => {
    setViewport(IPAD);
    const { button, sub } = floatWithSubtitle(document.body);
    const subStyle = styleOf(sub);
    expect(subStyle.display).not.toBe('none');
    // Positive control: no rule caps `display` here, so the reading above is
    // only evidence if the sheet reaches this element at all.
    expect(subStyle.fontSize).toBe('11.5px');
    expect(styleOf(button).paddingTop).toBe('10px');
  });
});
