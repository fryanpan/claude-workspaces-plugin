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
  notesMethodDetail,
  notesMethodInfo,
} from '@claude-workspaces/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendNotetakerFold,
  buildNotetakerFold,
  clockLabel,
  notetakerAcknowledged,
  notetakerAnswersShownPick,
  notetakerChoiceAtMount,
  notetakerMountAnswer,
  notetakerPicked,
  notetakerReconciled,
  readPerHour,
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

describe('the price on a row says whether it was measured or guessed', () => {
  const detailsOf = (el: HTMLElement): string[] =>
    [...el.querySelectorAll('.meeting-choice-detail')].map((d) => d.textContent ?? '');

  it('marks the eval figure as an estimate when the server has measured nothing', () => {
    const el = mount({ method: 'original', open: true, ...ALL, ...noop });
    for (const text of detailsOf(el)) expect(text).toMatch(/\$\d+\.\d\d\/hr est\.$/);
  });

  it('states a measured figure plainly, with no estimate mark', () => {
    const el = mount({
      method: 'original',
      open: true,
      perHour: { original: 2.4449 },
      ...ALL,
      ...noop,
    });
    const [first] = detailsOf(el);
    expect(first).toContain('$2.44/hr');
    expect(first).not.toContain('est.');
    // And it is the MEASURED number, not the eval's — the bug this replaces
    // was a row that said $0.60/hr for a meeting that billed several times
    // that.
    expect(first).not.toContain('$0.60');
  });

  it('marks only the methods that have no measurement, row by row', () => {
    const el = mount({
      method: 'original',
      open: true,
      perHour: { 'ledger-opus': 7.25 },
      ...ALL,
      ...noop,
    });
    const details = detailsOf(el);
    const opus = details.find((t) => t.includes('7.25'));
    expect(opus).toBeDefined();
    expect(opus).not.toContain('est.');
    expect(details.filter((t) => t.includes('est.'))).toHaveLength(NOTES_METHODS.length - 1);
  });

  it('"since" still hangs off the measured row, and off no other', () => {
    const el = mount({
      method: 'original',
      open: true,
      since: '10:38',
      perHour: { original: 2.4 },
      ...ALL,
      ...noop,
    });
    const withSince = detailsOf(el).filter((t) => t.includes('since 10:38'));
    expect(withSince).toHaveLength(1);
    expect(withSince[0]).toContain('$2.40/hr · since 10:38');
  });

  it('MUTATION CONTROL: a figure the server did not send leaves the row estimated', () => {
    const el = mount({ method: 'original', open: true, perHour: {}, ...ALL, ...noop });
    for (const text of detailsOf(el)) expect(text).toContain('est.');
  });
});

describe('reading the figures off the wire', () => {
  it('keeps positive finite numbers for methods this build knows', () => {
    expect(readPerHour({ original: 2.4, 'ledger-opus': 7 })).toEqual({
      original: 2.4,
      'ledger-opus': 7,
    });
  });

  it('drops anything that would print as $NaN/hr', () => {
    expect(
      readPerHour({ original: null, 'ledger-haiku': 'cheap', 'ledger-opus': Number.NaN }),
    ).toEqual({});
  });

  it('drops a zero or negative rate rather than claiming a meeting is free', () => {
    expect(readPerHour({ original: 0, 'ledger-opus': -3 })).toEqual({});
  });

  it('ignores a method id this build has never heard of', () => {
    expect(readPerHour({ 'ledger-telepathy': 9 })).toEqual({});
  });

  it('a server that sends nothing reads as nothing measured', () => {
    expect(readPerHour(undefined)).toEqual({});
    expect(readPerHour(null)).toEqual({});
    expect(readPerHour('nope')).toEqual({});
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
    expect(withSince[0]?.textContent).toContain(notesMethodDetail('ledger-opus'));
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
    const picked = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-opus', 'rest');
    const late = notetakerMountAnswer(picked, 'original');
    expect(late.shown).toBe('ledger-opus');
  });

  it('MUTATION CONTROL: the same late answer with no pick before it does land', () => {
    const late = notetakerMountAnswer(notetakerChoiceAtMount('ledger-opus'), 'original');
    expect(late.shown).toBe('original');
  });

  it('a refused change puts the row back to what the server holds', () => {
    const picked = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-opus', 'rest');
    expect(picked.shown).toBe('ledger-opus');
    const refused = notetakerAcknowledged(picked, false, { seq: picked.seq });
    expect(refused.shown).toBe('original');
    expect(refused.confirmed).toBe('original');
  });

  it('MUTATION CONTROL: an accepted change keeps it, and that becomes what is held', () => {
    const picked = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-opus', 'rest');
    const ok = notetakerAcknowledged(picked, true, { seq: picked.seq });
    expect(ok.shown).toBe('ledger-opus');
    expect(ok.confirmed).toBe('ledger-opus');
  });

  it('a second refusal goes back to the confirmed one, not to the last thing shown', () => {
    // Two picks in a row with the first accepted: the second's rollback must
    // land on the accepted method, never on the doc's original.
    const first = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-haiku', 'rest');
    let c = notetakerAcknowledged(first, true, { seq: first.seq });
    const second = notetakerPicked(c, 'ledger-opus', 'rest');
    c = notetakerAcknowledged(second, false, { seq: second.seq });
    expect(c.shown).toBe('ledger-haiku');
  });

  it('an unanswered mount GET leaves the row exactly as it was', () => {
    const c = notetakerChoiceAtMount('original');
    expect(notetakerMountAnswer(c, null)).toEqual(c);
  });
});

/**
 * TWO WRITES IN FLIGHT AT ONCE.
 *
 * A person changes their mind while the first REST write is still out, and
 * `fetch` promises settle in the order the responses arrive rather than the
 * order they were sent. Each answer speaks only for the pick it was sent for.
 */
describe('an answer that arrives for a pick nobody is showing any more', () => {
  it('does not confirm a newer selection when an older success lands late', () => {
    const first = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-haiku', 'rest');
    const second = notetakerPicked(first, 'ledger-opus', 'rest');
    // The first request's success, arriving after the second pick.
    const after = notetakerAcknowledged(second, true, { seq: first.seq });
    expect(after.shown).toBe('ledger-opus');
    // It moves only what the server is KNOWN to hold, which is now the first
    // method — the second write has not answered yet.
    expect(after.confirmed).toBe('ledger-haiku');
    // And the row is still waiting: the second answer still moves it.
    expect(notetakerAcknowledged(after, true, { seq: second.seq }).confirmed).toBe('ledger-opus');
  });

  it('does not roll back a newer selection when an older failure lands late', () => {
    const first = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-haiku', 'rest');
    const second = notetakerPicked(first, 'ledger-opus', 'rest');
    const after = notetakerAcknowledged(second, false, { seq: first.seq });
    expect(after.shown).toBe('ledger-opus');
  });

  it('MUTATION CONTROL: the answer for the pick on the row still moves it', () => {
    const picked = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-opus', 'rest');
    expect(notetakerAcknowledged(picked, false, { seq: picked.seq }).shown).toBe('original');
    expect(notetakerAcknowledged(picked, true, { seq: picked.seq }).confirmed).toBe('ledger-opus');
  });

  it('a pick takes the next number, and the socket answer finds it by method', () => {
    const mount = notetakerChoiceAtMount('original');
    const one = notetakerPicked(mount, 'ledger-haiku', 'socket');
    expect(one.seq).toBe(mount.seq + 1);
    expect(notetakerPicked(one, 'ledger-opus', 'socket').seq).toBe(one.seq + 1);
    // The socket frame carries no number, only the method it recorded — and
    // that is enough to name the pick it is answering.
    expect(notetakerAcknowledged(one, true, { method: 'ledger-haiku' }).confirmed).toBe(
      'ledger-haiku',
    );
  });

  it('an answer naming a method nobody asked for moves nothing', () => {
    const one = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-haiku', 'socket');
    const after = notetakerAcknowledged(one, false, { method: 'ledger-opus' });
    expect(after.shown).toBe('ledger-haiku');
    expect(after.confirmed).toBe('original');
  });

  /**
   * TWO PICKS BEFORE EITHER IS ANSWERED, over the socket where the answer
   * carries the method rather than a number. The first is kept and the second
   * refused, so the note-taker the server ends on is the FIRST — and that is
   * what the row has to settle on.
   */
  it('settles on the method the server kept when an earlier pick wins', () => {
    const first = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-haiku', 'socket');
    const second = notetakerPicked(first, 'ledger-opus', 'socket');
    const kept = notetakerAcknowledged(second, true, { method: 'ledger-haiku' });
    // The person is still looking at their newer pick while its write is out.
    expect(kept.shown).toBe('ledger-opus');
    const refused = notetakerAcknowledged(kept, false, { method: 'ledger-opus' });
    expect(refused.shown).toBe('ledger-haiku');
    expect(refused.confirmed).toBe('ledger-haiku');
  });

  it('two refused writes leave the row on what the doc had, not on a pick', () => {
    // The at-rest path numbers its own writes, so the reported ordering was
    // already safe there — but `confirmed` used to move at the PRESS, which
    // made the second rollback land on the first pick. Nothing was ever
    // recorded, so the doc still holds the method it opened with.
    const first = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-haiku', 'rest');
    const second = notetakerPicked(first, 'ledger-opus', 'rest');
    const one = notetakerAcknowledged(second, false, { seq: first.seq });
    const both = notetakerAcknowledged(one, false, { seq: second.seq });
    expect(both.shown).toBe('original');
    expect(both.confirmed).toBe('original');
  });

  /**
   * THE OLDER WRITE CAN BE THE ONE THE SERVER KEEPS.
   *
   * Two at-rest writes go out; the second's response comes back first, which
   * says nothing about the order the server applied them — the first request
   * whose response is still out may be the one that lands last, and then the
   * doc holds ITS method. Clearing a still-unanswered pick because a later
   * one answered throws away the only answer that can say so, and the row
   * then keeps a method the server replaced.
   */
  it('keeps an older REST pick pending when a newer one answers first', () => {
    const first = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-haiku', 'rest');
    const second = notetakerPicked(first, 'ledger-opus', 'rest');
    const early = notetakerAcknowledged(second, true, { seq: second.seq });
    // The first write has not answered, so nothing is settled yet.
    expect(early.pending.map((p) => p.seq)).toEqual([first.seq]);
    // Its answer arrives last, and it is the doc's last word.
    const late = notetakerAcknowledged(early, true, { seq: first.seq });
    expect(late.confirmed).toBe('ledger-haiku');
    expect(late.shown).toBe('ledger-haiku');
  });

  it('a socket answer settles the picks sent before it, which answer in order', () => {
    // The asymmetry is deliberate: one socket answers every frame it was
    // sent, in order, so an answer is proof the earlier ones are done with —
    // dropped with the socket if they never came. A `fetch` proves nothing
    // about another `fetch`.
    const first = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-haiku', 'socket');
    const second = notetakerPicked(first, 'ledger-opus', 'socket');
    const after = notetakerAcknowledged(second, true, { method: 'ledger-opus' });
    expect(after.pending).toEqual([]);
    expect(after.shown).toBe('ledger-opus');
  });

  /**
   * WHAT THE DOC SAYS, AFTER THE SOCKET THAT WAS ASKED WENT AWAY. It settles
   * the frames that died with it and nothing else — a pick made since is
   * still somebody's to answer.
   */
  it('settles the stranded frames against the doc, and leaves later picks alone', () => {
    const stranded = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-opus', 'socket');
    // The server had applied it; the answer was what the drop ate.
    const settled = notetakerReconciled(stranded, 'ledger-opus', stranded.seq);
    expect(settled.pending).toEqual([]);
    expect(settled.shown).toBe('ledger-opus');
    expect(settled.confirmed).toBe('ledger-opus');
  });

  it('a pick made after the drop is not settled by the doc read', () => {
    const stranded = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-opus', 'socket');
    const upTo = stranded.seq;
    // Picked again once the meeting was back: this one still has an answer
    // coming, so the row goes on showing it.
    const again = notetakerPicked(stranded, 'ledger-haiku', 'socket');
    const settled = notetakerReconciled(again, 'ledger-opus', upTo);
    expect(settled.pending.map((p) => p.seq)).toEqual([again.seq]);
    expect(settled.shown).toBe('ledger-haiku');
    expect(settled.confirmed).toBe('ledger-opus');
    // And its refusal now lands on what the doc actually said.
    expect(notetakerAcknowledged(settled, false, { method: 'ledger-haiku' }).shown).toBe(
      'ledger-opus',
    );
  });

  it('a REST write still out is left to answer for itself', () => {
    // Its `fetch` does not care that a socket went away, so the doc read has
    // no business settling it — and the read can race the write anyway.
    const rest = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-haiku', 'rest');
    const settled = notetakerReconciled(rest, 'original', rest.seq);
    expect(settled.pending.map((p) => p.seq)).toEqual([rest.seq]);
    expect(settled.shown).toBe('ledger-haiku');
  });

  it('only the answer for the pick on the row may raise an error', () => {
    const first = notetakerPicked(notetakerChoiceAtMount('original'), 'ledger-haiku', 'socket');
    const second = notetakerPicked(first, 'ledger-opus', 'socket');
    expect(notetakerAnswersShownPick(second, { method: 'ledger-haiku' })).toBe(false);
    expect(notetakerAnswersShownPick(second, { method: 'ledger-opus' })).toBe(true);
    expect(notetakerAnswersShownPick(second, { method: 'original' })).toBe(false);
  });
});
