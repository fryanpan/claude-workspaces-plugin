import { afterEach, describe, expect, it } from 'vitest';
import { MountScope } from '../src/mount-scope.ts';
import {
  type NewCount,
  mountNewIndicator,
  newPillLabel,
  newPillParts,
  renderNewPill,
} from '../src/new-indicator.ts';

/**
 * The one new-content indicator. The words are pure and pinned here; the
 * mount is driven against a hand-measured DOM, because happy-dom lays
 * nothing out and every rect below is stubbed.
 */

const count = (questions: number, fresh: number): NewCount => ({ questions, fresh });

describe('the pill words', () => {
  it('says how many new things, in words, with the questions first', () => {
    expect(newPillLabel(count(0, 4), 'above')).toBe('4 new above');
    expect(newPillLabel(count(1, 2), 'below')).toBe('1 question and 2 new below');
    expect(newPillLabel(count(3, 0), 'below')).toBe('3 questions below');
  });

  it('says nothing at zero — there is no "0 new"', () => {
    expect(newPillParts(count(0, 0))).toEqual([]);
    expect(newPillLabel(count(0, 0), 'above')).toBe('');
  });
});

describe('renderNewPill', () => {
  function pill(): HTMLElement {
    const strip = document.createElement('div');
    strip.className = 'edge-strip edge-strip-top';
    const b = document.createElement('button');
    strip.appendChild(b);
    document.body.appendChild(strip);
    return b;
  }

  it('reads as words a person can act on, and colours only for an ask', () => {
    const el = pill();
    renderNewPill(el, count(0, 4), 'above');
    expect(el.textContent).toContain('4 new');
    expect(el.classList.contains('has-ask')).toBe(false);
    renderNewPill(el, count(1, 2), 'above');
    expect(el.textContent?.replace(/\s+/g, ' ')).toContain('1 question · 2 new');
    expect(el.classList.contains('has-ask')).toBe(true);
  });

  it('hides the pill AND collapses its strip at zero', () => {
    const el = pill();
    renderNewPill(el, count(2, 1), 'below');
    expect(el.hidden).toBe(false);
    expect((el.parentElement as HTMLElement).hidden).toBe(false);
    renderNewPill(el, count(0, 0), 'below');
    expect(el.hidden).toBe(true);
    expect((el.parentElement as HTMLElement).hidden).toBe(true);
    expect(el.textContent).toBe('');
  });
});

// --- the mount -------------------------------------------------------------

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  document.body.replaceChildren();
});

function harness(opts: { wide?: boolean; dock?: number } = {}) {
  const pane = document.createElement('section');
  pane.getBoundingClientRect = () =>
    ({ top: 0, bottom: 820, left: 0, right: 800, width: 800, height: 820 }) as DOMRect;
  const scroller = document.createElement('div');
  scroller.getBoundingClientRect = () =>
    ({ top: 40, bottom: 640, left: 0, right: 800, width: 800, height: 600 }) as DOMRect;
  const marginEl = document.createElement('div');
  marginEl.getBoundingClientRect = () =>
    ({ top: 40, bottom: 640, left: 540, right: 800, width: 260 }) as DOMRect;
  // The real shape: a float inside the dock ROW (`float-dock.ts`), because
  // the row is what the stylesheet places and what gets seated.
  const row = document.createElement('div');
  row.className = 'doc-floats';
  row.getBoundingClientRect = () => ({ height: opts.dock ?? 0 }) as DOMRect;
  const dock = document.createElement('button');
  dock.className = 'plan-float';
  row.appendChild(dock);
  pane.append(scroller, row);
  document.body.appendChild(pane);
  const scope = new MountScope();
  const jumps: string[] = [];
  const handle = mountNewIndicator({
    pane,
    scroller,
    marginEl,
    marginVisible: () => opts.wide !== false,
    dockEl: () => (opts.dock ? dock : null),
    onJump: (dir) => jumps.push(dir),
    scope,
  });
  cleanups.push(() => scope.dispose());
  return { pane, scroller, handle, jumps, row };
}

const strip = (pane: HTMLElement, which: 'top' | 'bottom') =>
  pane.querySelector<HTMLElement>(`.edge-strip-${which}`) as HTMLElement;
const edge = (pane: HTMLElement, which: 'top' | 'bottom') =>
  pane.querySelector<HTMLElement>(`.cw-edge-${which}`) as HTMLElement;

describe('mountNewIndicator', () => {
  it('puts each pill in a strip OUTSIDE the scroll area, one each side of it', () => {
    const h = harness();
    const kids = Array.from(h.pane.children);
    expect(kids.indexOf(strip(h.pane, 'top'))).toBeLessThan(kids.indexOf(h.scroller));
    expect(kids.indexOf(strip(h.pane, 'bottom'))).toBeGreaterThan(kids.indexOf(h.scroller));
    // Nothing of the indicator is inside the scroller, so it can never sit on
    // top of the first or the last comment card.
    expect(h.scroller.querySelector('.cw-edge')).toBe(null);
  });

  it('takes the balloon column’s footprint on a wide layout', () => {
    const h = harness();
    h.handle.render({ questions: 0, fresh: 1 }, { questions: 0, fresh: 1 });
    // The column spans x 540..800 in a pane at x 0..800.
    expect(strip(h.pane, 'top').style.left).toBe('540px');
    expect(strip(h.pane, 'top').style.width).toBe('260px');
    // …and starts just inside the scroller's own top edge (40 + 10).
    expect(strip(h.pane, 'top').style.top).toBe('50px');
    expect(strip(h.pane, 'top').classList.contains('is-floating')).toBe(true);
  });

  it('lets go of the column on a phone, where there is none', () => {
    const h = harness({ wide: false });
    h.handle.render({ questions: 0, fresh: 1 }, { questions: 0, fresh: 1 });
    expect(strip(h.pane, 'top').style.left).toBe('');
    expect(strip(h.pane, 'top').style.width).toBe('');
    expect(strip(h.pane, 'top').style.top).toBe('');
    expect(strip(h.pane, 'top').classList.contains('is-floating')).toBe(false);
  });

  it('keeps the bottom strip clear of the action dock, which keeps its own row', () => {
    const wide = harness({ dock: 60 });
    wide.handle.render({ questions: 0, fresh: 0 }, { questions: 0, fresh: 2 });
    // 60px of dock + a 10px gap + the dock's own 22px inset.
    expect(strip(wide.pane, 'bottom').style.bottom).toBe('92px');
    const phone = harness({ dock: 60, wide: false });
    phone.handle.render({ questions: 0, fresh: 0 }, { questions: 0, fresh: 2 });
    expect(strip(phone.pane, 'bottom').style.marginBottom).toBe('70px');
  });

  it('seats the action dock in the column too, so it covers no body text', () => {
    // Centred on the pane the dock lay over the prose — the one thing round 3
    // of the mock said nothing may do. In the column it is beside the text.
    const h = harness({ dock: 60 });
    h.handle.render({ questions: 0, fresh: 1 }, { questions: 0, fresh: 1 });
    expect(h.row.classList.contains('is-floating')).toBe(true);
    expect(h.row.style.left).toBe('540px');
    expect(h.row.style.width).toBe('260px');
    // The prose column ends where the balloon column starts, so the dock's
    // whole box is clear of it.
    expect(Number.parseInt(h.row.style.left, 10)).toBeGreaterThanOrEqual(540);
  });

  it('gives the dock back its centred pill where there is no column', () => {
    const h = harness({ dock: 60, wide: false });
    h.handle.render({ questions: 0, fresh: 1 }, { questions: 0, fresh: 1 });
    expect(h.row.classList.contains('is-floating')).toBe(false);
    expect(h.row.style.left).toBe('');
    expect(h.row.style.width).toBe('');
  });

  it('a tap says which way the reader asked to go', () => {
    const h = harness();
    h.handle.render({ questions: 0, fresh: 2 }, { questions: 1, fresh: 0 });
    edge(h.pane, 'top').click();
    edge(h.pane, 'bottom').click();
    expect(h.jumps).toEqual(['above', 'below']);
  });

  it('goes away with the scope', () => {
    const h = harness();
    for (const f of cleanups.splice(0)) f();
    expect(h.pane.querySelector('.edge-strip')).toBe(null);
  });

  it('reports the band each strip covers, so no card lies under one', () => {
    // The strips are drawn OVER the column; the column reserves what they
    // cover. Real rects, because this is a measurement.
    const h = harness({ dock: 60 });
    const top = strip(h.pane, 'top');
    const bot = strip(h.pane, 'bottom');
    top.getBoundingClientRect = () => ({ top: 50, bottom: 90, height: 40 }) as DOMRect;
    bot.getBoundingClientRect = () => ({ top: 560, bottom: 600, height: 40 }) as DOMRect;
    h.row.getBoundingClientRect = () => ({ top: 600, bottom: 660, height: 60 }) as DOMRect;
    h.handle.render({ questions: 0, fresh: 2 }, { questions: 1, fresh: 1 });
    const ins = h.handle.insets();
    // Scroller runs 40..640: the top strip reaches 50px into it, the bottom
    // strip 80 — and the seated dock is measured with it, since it sits in
    // the same column.
    expect(ins.top).toBe(58);
    expect(ins.bottom).toBe(88);
  });

  it('reserves nothing where the strips are ordinary rows', () => {
    // No column: the strips take their own height out of the flow, so a card
    // cannot be under one and the column must not be shrunk twice.
    const h = harness({ wide: false, dock: 60 });
    h.handle.render({ questions: 0, fresh: 2 }, { questions: 0, fresh: 2 });
    expect(h.handle.insets()).toEqual({ top: 0, bottom: 0 });
  });

  it('reserves nothing for a pill that is not shown', () => {
    const h = harness();
    const bot = strip(h.pane, 'bottom');
    bot.getBoundingClientRect = () => ({ top: 560, bottom: 600, height: 40 }) as DOMRect;
    h.handle.render({ questions: 0, fresh: 1 }, { questions: 0, fresh: 0 });
    expect(h.handle.insets().bottom).toBe(0);
  });

  it('still reserves the seated dock when the pill beside it is hidden', () => {
    // The dock is in the same column: a card may not slide under it just
    // because there is nothing new below.
    const h = harness({ dock: 60 });
    h.row.getBoundingClientRect = () => ({ top: 580, bottom: 640, height: 60 }) as DOMRect;
    h.handle.render({ questions: 0, fresh: 1 }, { questions: 0, fresh: 0 });
    expect(h.handle.insets().bottom).toBe(68);
  });
});
