/**
 * What the server accepts from the coach session: a moment reaches a page
 * only if it quotes the trigger of the goal it names and has the card's
 * shape; anything else is refused with a reason the session can act on.
 */
import { describe, expect, it } from 'bun:test';
import { readGoalsDoc } from '../src/coach/goals-doc.ts';
import { checkMoment, quotesTrigger } from '../src/coach/judge.ts';
import { GOALS_DOC } from './coach-fixtures.ts';

const goals = readGoalsDoc(GOALS_DOC).goals;

describe('quotesTrigger', () => {
  it('wants a run of the trigger’s own words, at least three of them', () => {
    const t = goals[0]?.when ?? '';
    expect(quotesTrigger('more than twenty minutes on styling', t)).toBe(true);
    expect(quotesTrigger('More than twenty minutes, on styling!', t)).toBe(true);
    expect(quotesTrigger('on styling', t)).toBe(false);
    expect(quotesTrigger('twenty minutes styling', t)).toBe(false);
    expect(quotesTrigger('reads a message', t)).toBe(false);
  });
});

describe('checkMoment', () => {
  const moment = {
    goal: 3,
    matched: 'I start on a solution before',
    observed: 'Designing the importer in a spec that never says why',
    line: 'Hi, I’m noticing the importer design came before any **why**. Who has the problem?',
  };

  it('takes a moment that quotes its goal’s trigger, cleaned for the card', () => {
    expect(checkMoment(moment, goals)).toEqual({
      goalIndex: 2,
      matched: 'I start on a solution before',
      observed: 'Designing the importer in a spec that never says why',
      line: 'Hi, I’m noticing the importer design came before any why. Who has the problem?',
    });
  });

  it('refuses a quote of another goal’s trigger, or none, and says so', () => {
    expect(checkMoment({ ...moment, goal: 1 }, goals)).toContain('goal 1');
    expect(checkMoment({ ...moment, matched: 'solution first' }, goals)).toContain(
      'Act differently when',
    );
  });

  it('refuses a goal not on the list, missing text, and a line that asks nothing', () => {
    expect(checkMoment(null, goals)).toContain('goal is a number');
    expect(checkMoment({ ...moment, goal: 4 }, goals)).toContain('1 to 3');
    expect(checkMoment({ ...moment, goal: 1.5 }, goals)).toContain('goal is a number');
    expect(checkMoment({ ...moment, line: 7 }, goals)).toContain('are text');
    expect(checkMoment({ ...moment, line: 'Write the why before the design.' }, goals)).toContain(
      'ends with a question',
    );
    expect(checkMoment({ ...moment, observed: 'x'.repeat(141) }, goals)).toContain('observed');
  });
});
