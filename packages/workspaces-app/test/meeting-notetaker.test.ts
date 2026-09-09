/**
 * The Note-taker fold as a unit: what it says when it is shut, what it offers
 * when it is open, and what a pick reports.
 *
 * The states the approved mock pins are the ones asserted here — collapsed by
 * default with the current note-taker on the head line, three rows carrying
 * the price, "since" only on the row that is on.
 */
import { DEFAULT_NOTES_METHOD, NOTES_METHODS, notesMethodInfo } from '@claude-workspaces/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendNotetakerFold, buildNotetakerFold, clockLabel } from '../src/meeting-notetaker.ts';

afterEach(() => {
  document.body.replaceChildren();
});

/** The fold, mounted, so every assertion reads a rendered element. */
function mount(opts: Parameters<typeof buildNotetakerFold>[0]): HTMLElement {
  const el = buildNotetakerFold(opts);
  document.body.append(el);
  return el;
}

const noop = {
  onToggleOpen: () => {},
  onPick: () => {},
};

describe('the fold when it is shut', () => {
  it('is collapsed by default and still says which note-taker is on', () => {
    const el = mount({ method: 'ledger-opus', open: false, ...noop });
    expect(el.querySelector('.meeting-adv-head')?.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('.meeting-adv-value')?.textContent).toBe(
      notesMethodInfo('ledger-opus').label,
    );
    // Shut means shut: no rows, so nothing method-related is on the sheet
    // beyond the one line.
    expect(el.querySelectorAll('.meeting-choice')).toHaveLength(0);
  });

  it('a tap on the head asks to open it and changes nothing else', () => {
    const onToggleOpen = vi.fn();
    const onPick = vi.fn();
    const el = mount({ method: DEFAULT_NOTES_METHOD, open: false, onToggleOpen, onPick });
    el.querySelector<HTMLButtonElement>('.meeting-adv-head')?.click();
    expect(onToggleOpen).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('the fold when it is open', () => {
  it('offers every note-taker, each with its price, and marks the one that is on', () => {
    const el = mount({ method: 'ledger-haiku', open: true, ...noop });
    const rows = [...el.querySelectorAll('.meeting-choice')];
    expect(rows).toHaveLength(NOTES_METHODS.length);
    for (const [i, id] of NOTES_METHODS.entries()) {
      const info = notesMethodInfo(id);
      expect(rows[i]?.querySelector('.meeting-choice-title')?.textContent).toBe(info.label);
      // The price is on the row, because it is part of the choice.
      expect(rows[i]?.querySelector('.meeting-choice-detail')?.textContent).toContain('/hr');
    }
    const selected = rows.filter((r) => r.classList.contains('is-selected'));
    expect(selected).toHaveLength(1);
    expect(selected[0]?.querySelector('.meeting-choice-title')?.textContent).toBe(
      notesMethodInfo('ledger-haiku').label,
    );
    expect(selected[0]?.querySelector<HTMLInputElement>('input[type="radio"]')?.checked).toBe(true);
  });

  it('hangs "since" on the row that is on, and on no other', () => {
    const el = mount({ method: 'ledger-opus', open: true, since: '10:38', ...noop });
    const withSince = [...el.querySelectorAll('.meeting-choice-detail')].filter((d) =>
      d.textContent?.includes('since 10:38'),
    );
    expect(withSince).toHaveLength(1);
    expect(withSince[0]?.textContent).toContain(notesMethodInfo('ledger-opus').detail);
  });

  it('MUTATION CONTROL: with nothing to date, no row claims a time', () => {
    const el = mount({ method: 'ledger-opus', open: true, ...noop });
    for (const d of el.querySelectorAll('.meeting-choice-detail')) {
      expect(d.textContent).not.toContain('since');
    }
  });

  it('reports the row that was picked', () => {
    const onPick = vi.fn();
    const el = mount({ method: 'original', open: true, onToggleOpen: () => {}, onPick });
    const rows = el.querySelectorAll<HTMLLabelElement>('.meeting-choice');
    rows[2]?.click();
    expect(onPick).toHaveBeenCalledWith(NOTES_METHODS[2]);
  });
});

describe('the fold on the sheet', () => {
  it('moves the state it is given and redraws, so the pick sticks', () => {
    const pop = document.createElement('div');
    document.body.append(pop);
    const state = { chooseMethod: DEFAULT_NOTES_METHOD, methodOpen: false, methodSince: '' };
    const renderPop = vi.fn();
    const onPick = vi.fn();
    appendNotetakerFold(pop, state, { renderPop, onPick });
    pop.querySelector<HTMLButtonElement>('.meeting-adv-head')?.click();
    expect(state.methodOpen).toBe(true);
    expect(renderPop).toHaveBeenCalledTimes(1);

    // Redrawn open, a pick goes out and the sheet is asked to redraw again —
    // which is what puts the row's tick where the person tapped.
    pop.replaceChildren();
    appendNotetakerFold(pop, state, { renderPop, onPick });
    pop.querySelectorAll<HTMLLabelElement>('.meeting-choice')[1]?.click();
    expect(onPick).toHaveBeenCalledWith(NOTES_METHODS[1]);
    expect(renderPop).toHaveBeenCalledTimes(2);
  });
});

describe('the clock the trace line reads as', () => {
  it('is zero-padded local time', () => {
    expect(clockLabel(new Date(2026, 8, 9, 9, 5).getTime())).toBe('09:05');
    expect(clockLabel(new Date(2026, 8, 9, 22, 40).getTime())).toBe('22:40');
  });
});
