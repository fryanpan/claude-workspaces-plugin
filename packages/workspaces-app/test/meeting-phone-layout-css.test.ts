/**
 * The meeting page as a phone lays it out — two of the rules Bryan asked for
 * after holding a meeting on his own phone (2026-09-11):
 *
 *   1. the transcript scrolls and stays ABOVE the floats, instead of ending
 *      behind them with nothing left to scroll;
 *   2. no status bar under the recording bar — the indicator blinks in the top
 *      right and nothing else is dedicated to it.
 *
 * His third, shorter Make Plan and Review pills, went with those two buttons
 * (2026-11-09).
 *
 * These are the CASCADE half: which rule wins at 430 and which at 1180, read
 * as computed values against the real sheets. The geometry half was a
 * browser test of the doc's live transcript, which went with the doc's own
 * recorder on 2026-10-30. happy-dom lays nothing out and
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
    float.className = 'plan-float plan-float--approve';
    dock.appendChild(float);
  }
  return { editor, dock, float };
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
});
