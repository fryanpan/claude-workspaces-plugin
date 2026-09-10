/**
 * The Note-taker fold as a unit: what it says when it is shut, what it offers
 * when it is open, and what a pick reports.
 *
 * The states the approved mock pins are the ones asserted here — collapsed by
 * default with the current note-taker on the head line, three rows carrying
 * the price, "since" only on the row that is on.
 */
import {
  DEFAULT_NOTES_METHOD,
  NOTES_METHODS,
  OFFERED_NOTES_METHODS,
  notesMethodInfo,
} from '@claude-workspaces/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendNotetakerFold,
  buildNotetakerFold,
  clockLabel,
  notetakerAcknowledged,
  notetakerChoiceAtMount,
  notetakerMountAnswer,
  notetakerPicked,
} from '../src/meeting-notetaker.ts';

afterEach(() => {
  document.body.replaceChildren();
});

/** The fold, mounted, so every assertion reads a rendered element. */
function mount(opts: Parameters<typeof buildNotetakerFold>[0]): HTMLElement {
  const el = buildNotetakerFold(opts);
  document.body.append(el);
  return el;
}

const ALL = { offered: NOTES_METHODS };

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
    const el = mount({ method: 'ledger-haiku', open: true, ...ALL, ...noop });
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
    const el = mount({ method: 'ledger-opus', open: true, since: '10:38', ...ALL, ...noop });
    const withSince = [...el.querySelectorAll('.meeting-choice-detail')].filter((d) =>
      d.textContent?.includes('since 10:38'),
    );
    expect(withSince).toHaveLength(1);
    expect(withSince[0]?.textContent).toContain(notesMethodInfo('ledger-opus').detail);
  });

  it('MUTATION CONTROL: with nothing to date, no row claims a time', () => {
    const el = mount({ method: 'ledger-opus', open: true, ...ALL, ...noop });
    for (const d of el.querySelectorAll('.meeting-choice-detail')) {
      expect(d.textContent).not.toContain('since');
    }
  });

  it('reports the row that was picked', () => {
    const onPick = vi.fn();
    const el = mount({
      method: 'original',
      open: true,
      offered: NOTES_METHODS,
      onToggleOpen: () => {},
      onPick,
    });
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
    appendNotetakerFold(pop, state, { renderPop, onPick, offered: NOTES_METHODS });
    pop.querySelector<HTMLButtonElement>('.meeting-adv-head')?.click();
    expect(state.methodOpen).toBe(true);
    expect(renderPop).toHaveBeenCalledTimes(1);

    // Redrawn open, a pick goes out and the sheet is asked to redraw again —
    // which is what puts the row's tick where the person tapped.
    pop.replaceChildren();
    appendNotetakerFold(pop, state, { renderPop, onPick, offered: NOTES_METHODS });
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

describe('what the sheet actually offers today', () => {
  it('draws no fold at all while only one note-taker is offered', () => {
    // A chooser with one row is a control that does nothing. The rest of the
    // machinery — the route, the socket frame, the composer — is untouched
    // by this, which is what lets a held method be measured before it is
    // offered.
    const pop = document.createElement('div');
    document.body.append(pop);
    appendNotetakerFold(
      pop,
      { chooseMethod: DEFAULT_NOTES_METHOD, methodOpen: false, methodSince: '' },
      { renderPop: () => {}, onPick: () => {} },
    );
    expect(OFFERED_NOTES_METHODS).toHaveLength(1);
    expect(pop.querySelector('.meeting-notetaker')).toBeNull();
  });

  it('MUTATION CONTROL: given two, it draws the fold and both rows', () => {
    // The same call with a longer offer list. Without this the assertion
    // above would pass just as well against a fold that never renders.
    const el = mount({
      method: 'original',
      open: true,
      offered: ['original', 'ledger-haiku'],
      ...noop,
    });
    expect(el.querySelectorAll('.meeting-choice')).toHaveLength(2);
  });

  it('every offered method is one the vocabulary has', () => {
    for (const id of OFFERED_NOTES_METHODS) expect(NOTES_METHODS).toContain(id);
  });
});

describe('which note-taker the fold shows, and who may move it', () => {
  it('the mount answer sets the row when nobody has picked', () => {
    const c = notetakerMountAnswer(notetakerChoiceAtMount('original'), 'ledger-haiku');
    expect(c.shown).toBe('ledger-haiku');
    expect(c.confirmed).toBe('ledger-haiku');
  });

  it('a mount answer that arrives AFTER a pick is dropped', () => {
    // The fetch is issued at mount and a person can pick before it lands. Its
    // answer describes the doc before the pick, so writing it in would show a
    // note-taker the server has already been told to replace.
    const picked = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-opus');
    const late = notetakerMountAnswer(picked, 'original');
    expect(late.shown).toBe('ledger-opus');
  });

  it('MUTATION CONTROL: the same late answer with no pick before it does land', () => {
    const late = notetakerMountAnswer(notetakerChoiceAtMount('ledger-opus'), 'original');
    expect(late.shown).toBe('original');
  });

  it('a refused change puts the row back to what the server holds', () => {
    const picked = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-opus');
    expect(picked.shown).toBe('ledger-opus');
    const refused = notetakerAcknowledged(picked, false);
    expect(refused.shown).toBe('original');
    expect(refused.confirmed).toBe('original');
  });

  it('MUTATION CONTROL: an accepted change keeps it, and that becomes what is held', () => {
    const picked = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-opus');
    const ok = notetakerAcknowledged(picked, true);
    expect(ok.shown).toBe('ledger-opus');
    expect(ok.confirmed).toBe('ledger-opus');
  });

  it('a second refusal goes back to the confirmed one, not to the last thing shown', () => {
    // Two picks in a row with the first accepted: the second's rollback must
    // land on the accepted method, never on the doc's original.
    let c = notetakerAcknowledged(
      notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-haiku'),
      true,
    );
    c = notetakerAcknowledged(notetakerPicked(c, 'ledger-opus'), false);
    expect(c.shown).toBe('ledger-haiku');
  });

  it('an unanswered mount GET leaves the row exactly as it was', () => {
    const c = notetakerChoiceAtMount('original');
    expect(notetakerMountAnswer(c, null)).toEqual(c);
  });
});
