/**
 * Questions chosen by reading the plan (`interview-reader.ts`), and the
 * planning voice asking them: a plan with every section written and no
 * gaps still gets its open question; "any questions?" gets the best one or
 * one sentence saying there is none and why; a pause nobody spoke into costs
 * no call; a model that fails asks nothing. The model is a script.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { prose } from '@claude-workspaces/core';
import { findPlanGaps } from '../src/spoken-reply/interview-gaps.ts';
import { asksForQuestions } from '../src/spoken-reply/interview-phrases.ts';
import {
  READER_SYSTEM,
  ReadingMemory,
  parseReading,
  readPlan,
  readingPrompt,
} from '../src/spoken-reply/interview-reader.ts';
import { DOC_ID, type Fixture, ON_DOC, planFixture } from './interview-fixture.ts';

const BERTH_PLAN = `# Harborlight berth plan

## Goal

Open the second Harborlight berth to Riverbend ferries by spring.

### Work

- Dredge the Saltmarsh channel to four metres before March.
- Move the ticket office to the new pier.
- Train the Riverbend crews on the new mooring lines.
`;

const ASK = JSON.stringify({
  ask: 'Who signs off the dredging?',
  heading: 'Work',
  quote: 'saltmarsh channel',
});

let fx: Fixture | null = null;
afterEach(() => {
  fx?.stop();
  fx = null;
});

function scripted(replies: string[]) {
  const calls: Array<{ system: string; user: string }> = [];
  return {
    calls,
    complete: async (args: { system: string; user: string }) => {
      // The reader's prompt only; the answer check falls back to the words.
      if (!args.system.startsWith(READER_SYSTEM)) return '';
      calls.push(args);
      const next = replies.shift();
      if (next === undefined) throw new Error('model down');
      return next;
    },
  };
}

const outlineOf = (f: Fixture): readonly prose.OutlineEntry[] =>
  f.docStore.readOutline(DOC_ID)?.blocks ?? [];

describe('parseReading', () => {
  it('places the question under the heading it names, on the quoted words as written', async () => {
    fx = await planFixture({ markdown: BERTH_PLAN });
    const read = parseReading(`Sure: ${ASK}`, outlineOf(fx));
    if (!read || !('ask' in read)) throw new Error('no question');
    expect(read.ask).toMatchObject({
      kind: 'read',
      heading: 'Work',
      asks: 'Who signs off the dredging?',
      quote: 'Saltmarsh channel',
    });
    const block = outlineOf(fx).find((b) => b.id === read.ask.asksId);
    expect(block?.text).toContain('Saltmarsh channel');
  });

  it('falls back to the quoted block’s heading, then the first section', async () => {
    fx = await planFixture({ markdown: BERTH_PLAN });
    const byQuote = parseReading(
      JSON.stringify({ ask: 'By when?', heading: 'Nowhere', quote: 'ticket office' }),
      outlineOf(fx),
    );
    expect(byQuote && 'ask' in byQuote ? byQuote.ask.heading : null).toBe('Work');
    const bare = parseReading(JSON.stringify({ ask: 'Why spring?' }), outlineOf(fx));
    expect(bare && 'ask' in bare ? bare.ask.heading : null).toBe('Goal');
    expect(bare && 'ask' in bare ? bare.ask.asksId : 'x').toBeUndefined();
  });

  it('takes the quoted words under the heading it names, and a heading by its words alone', async () => {
    fx = await planFixture({
      markdown:
        '# Harborlight berth plan\n\nThe Saltmarsh channel is shallow today.\n\n## 1. Goal\n\nOpen the berth by spring.\n\n### Work\n\n- Dredge the Saltmarsh channel to four metres.\n',
    });
    const read = parseReading(ASK, outlineOf(fx));
    if (!read || !('ask' in read)) throw new Error('no question');
    const block = outlineOf(fx).find((b) => b.id === read.ask.asksId);
    expect(block?.text).toBe('Dredge the Saltmarsh channel to four metres.');
    const goal = parseReading(
      JSON.stringify({ ask: 'Why spring?', heading: 'Goal.' }),
      outlineOf(fx),
    );
    expect(goal && 'ask' in goal ? goal.ask.heading : null).toBe('1. Goal');
  });

  it('reads no question, a reason, or nothing usable', async () => {
    fx = await planFixture({ markdown: BERTH_PLAN });
    expect(parseReading('{"ask": null, "why": "All settled."}', outlineOf(fx))).toEqual({
      none: 'All settled.',
    });
    expect(parseReading('no json here', outlineOf(fx))).toBeNull();
    expect(parseReading('{"ask": "Why?"}', [])).toBeNull();
  });
});

describe('readingPrompt and readPlan', () => {
  it('shows the plan, the gaps, what was asked and what was just said', async () => {
    fx = await planFixture({ markdown: BERTH_PLAN });
    const p = readingPrompt({
      outline: outlineOf(fx),
      gaps: [],
      heard: 'We start in March.',
      asked: ['Who pays?'],
      invited: true,
    });
    expect(p.system.startsWith(READER_SYSTEM)).toBe(true);
    expect(p.system).toContain('asked whether you have any questions');
    expect(p.user).toContain('### Work');
    expect(p.user).toContain('- Move the ticket office to the new pier.');
    expect(p.user).toContain('- Who pays?');
    expect(p.user).toContain('JUST SAID:\nWe start in March.');
    expect(
      readingPrompt({ ...{ outline: [], gaps: [], heard: '', asked: [] }, invited: false }).system,
    ).toBe(READER_SYSTEM);
  });

  it('asks nothing when the model fails', async () => {
    const m = scripted([]);
    expect(
      await readPlan(m.complete, { outline: [], gaps: [], heard: 'x', asked: [], invited: false }),
    ).toEqual({
      none: '',
    });
  });
});

describe('asksForQuestions', () => {
  it('hears the invitation at the end of what was said', () => {
    for (const said of [
      'Any questions?',
      'So that is the plan. Do you have any questions?',
      'Claude, any questions for me?',
      'have you got any more questions',
      'What questions do you have?',
      'Anything you want to ask me?',
    ]) {
      expect(asksForQuestions(said), said).toBe(true);
    }
    for (const said of [
      'We got questions from Riverbend about the berth.',
      'Any questions go to the Saltmarsh office.',
      'I have questions about the budget.',
    ]) {
      expect(asksForQuestions(said), said).toBe(false);
    }
  });
});

describe('the planning voice reading a plan with no gaps', () => {
  it('asks the open question at a pause somebody spoke into, and puts the cursor on it', async () => {
    const m = scripted([ASK]);
    fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete });
    expect(findPlanGaps(outlineOf(fx))).toEqual([]);
    const r = await fx.say('We dredge first and then move the office.');
    expect(r).toMatchObject({
      spoken: 'Who signs off the dredging?',
      asking: true,
      route: 'interview',
    });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]?.user).toContain('We dredge first and then move the office.');
  });

  it('writes the answer under the heading, then reads once more for the next', async () => {
    const m = scripted([ASK, '{"ask": null, "why": "Nothing else is open."}']);
    fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete });
    await fx.say('We dredge first.');
    const r = await fx.say('The Saltmarsh harbour office signs it off.');
    expect(r.spoken).toBe('Written under Work.');
    expect(r.asking).toBe(true);
    expect(fx.headingOf('The Saltmarsh harbour office signs it off.')).toBe('Work');
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1]?.user).toContain('- Who signs off the dredging?');
    expect(fx.lines).toContain(`[interview] doc=${DOC_ID} section=2 after-answer=edit`);
  });

  it('“any questions?” is answered with the best question', async () => {
    const m = scripted([ASK]);
    fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete });
    const r = await fx.say('Any questions?');
    expect(r.spoken).toBe('Who signs off the dredging?');
    expect(m.calls[0]?.system).toContain('asked whether you have any questions');
  });

  it('“any questions?” with a question already out asks it again and writes nothing', async () => {
    const m = scripted([ASK]);
    fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete });
    await fx.say('We dredge first.');
    const r = await fx.say('Any questions?');
    expect(r).toMatchObject({ spoken: 'Who signs off the dredging?', asking: true });
    expect(fx.headingOf('Any questions?')).toBeNull();
    expect(m.calls).toHaveLength(1);
  });

  it('“any questions?” with none is answered “No.”, with why written; a plain pause stays quiet', async () => {
    const m = scripted([
      '{"ask": null, "why": "Every step has an owner and a date."}',
      '{"ask": null, "why": "Nothing new."}',
    ]);
    fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete });
    const r = await fx.say('Do you have any questions?');
    expect(r.spoken).toBe('No.');
    expect(r.detail).toEqual(['Every step has an owner and a date.']);
    expect(r.asking).toBe(true);
    const quiet = await fx.answerer.answer(
      'We start in March.',
      { id: 'a', name: 'A' },
      ON_DOC,
      true,
    );
    expect(quiet).toMatchObject({ spoken: '', asking: true, route: 'interview' });
  });

  it('makes no call at a pause nobody spoke into', async () => {
    const m = scripted([]);
    fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete });
    const r = await fx.answerer.answer('', { id: 'a', name: 'A' }, ON_DOC, true);
    expect(r.spoken).toBe('');
    expect(m.calls).toHaveLength(0);
  });

  it('in a meeting, what the voice does not take is left unsaid, never routed', async () => {
    const m = scripted([]);
    fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete, onBoard: false });
    const r = await fx.answerer.answer(
      'Give me a status update.',
      { id: 'a', name: 'A' },
      ON_DOC,
      true,
    );
    expect(r.spoken).toBe('');
    expect(r.route).not.toBe('fast-path');
  });
});

describe('ReadingMemory', () => {
  it('hears everything said since the last question, and forgets a question never heard', () => {
    const mem = new ReadingMemory();
    mem.keep(DOC_ID, 'We dredge first.');
    expect(mem.keep(DOC_ID, 'Then the office.')).toBe('We dredge first. Then the office.');
    mem.ask(DOC_ID, 'Who pays?');
    expect(mem.askedOn(DOC_ID)).toEqual(['Who pays?']);
    expect(mem.keep(DOC_ID, 'In March.')).toBe('In March.');
    mem.unask(DOC_ID, 'Who pays?');
    expect(mem.askedOn(DOC_ID)).toEqual([]);
    expect(mem.keep(DOC_ID, '')).toBe('We dredge first. Then the office.');
  });
});
