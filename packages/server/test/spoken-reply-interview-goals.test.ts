/**
 * The planning voice on a learning-goals doc, through `SpokenAnswerer` over a
 * real `DocStore`: it asks at most the coach's name and what the owner wants
 * to do better, then follows the speaker. Everything said about any goal lands in the one
 * goals section, one bullet per goal; a revision edits that goal in place.
 * The model is a fake keyed on what was said; the clock is the fixture's.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { prose } from '@claude-workspaces/core';
import { GOALS_HEADING, NAME_HEADING, goalsDocTemplate } from '../src/coach/goals-doc.ts';
import type { PlanComplete } from '../src/spoken-reply/interview-reader.ts';
import { sentences } from '../src/spoken-reply/reply-shape.ts';
import { DOC_ID, type Fixture, planFixture } from './interview-fixture.ts';

let fx: Fixture | null = null;
afterEach(() => {
  fx?.stop();
  fx = null;
});

const NOTHING = { name: null, add: [], change: [] };

/** A model that answers by what was just said: the first key the prompt's
 *  JUST SAID part contains picks the reply. Every prompt is kept. */
function fakeModel(by: Record<string, object>): PlanComplete & { prompts: string[] } {
  const prompts: string[] = [];
  const complete = async ({ user }: { system: string; user: string }) => {
    prompts.push(user);
    const said = user.slice(user.indexOf('JUST SAID:'));
    for (const [key, reply] of Object.entries(by)) {
      if (said.includes(key)) return JSON.stringify(reply);
    }
    return JSON.stringify(NOTHING);
  };
  return Object.assign(complete, { prompts });
}

/** The texts of the blocks under every heading named `heading`, in order. */
function under(f: Fixture, heading: string): string[] {
  const blocks = f.docStore.readOutline(DOC_ID)?.blocks ?? [];
  const ids = new Set(blocks.filter((b) => b.text === heading).map((b) => b.id));
  return blocks
    .filter((b) => b.kind !== 'heading' && b.underHeadingId && ids.has(b.underHeadingId))
    .map((b) => b.text)
    .filter((t) => t.trim());
}

function plainText(f: Fixture): string {
  const live = f.docStore.get(DOC_ID);
  return live ? prose.walkProse(prose.getProseFragment(live.ydoc)).plainText : '';
}

const SLIDES = 'Stop polishing slides past midnight; if I am still on them at eleven, ask me why.';
const STUCK = 'Ask for help after an hour stuck; if I spend an hour on one bug, ask me who knows.';
const BOTH = `Call it Saltmarsh. ${SLIDES} And ${STUCK}`;

const OLD_LAYOUT = `# Learning goals

## ${NAME_HEADING}

Saltmarsh

## Goal 1

### ${GOALS_HEADING}

### What’s behind it

### Act differently when

### How
`;

describe('learning goals: an answer lands where it belongs', () => {
  it('a name and two goals said in one breath go to the name and the one goals section', async () => {
    const model = fakeModel({
      'Call it Saltmarsh': { name: 'Saltmarsh', add: [SLIDES, STUCK], change: [] },
    });
    fx = await planFixture({ markdown: goalsDocTemplate(), complete: model });
    const first = await fx.say('');
    expect(first.spoken).toBe('What should your coach be called?');
    const r = await fx.say(BOTH);
    expect(under(fx, NAME_HEADING)).toEqual(['Saltmarsh']);
    expect(under(fx, GOALS_HEADING)).toEqual([SLIDES, STUCK]);
    // Both goals are bullets, one each.
    const blocks = fx.docStore.readOutline(DOC_ID)?.blocks ?? [];
    expect(blocks.filter((b) => b.kind === 'listItem').map((b) => b.depth)).toEqual([0, 0]);
    // Nothing is left to ask: it follows the speaker rather than walking sections.
    expect(r.spoken).toBe('Got it.');
    expect(r.detail).toContain(`Added: ${SLIDES}`);
  });

  it('a goal said while the name question is out is kept, and the name is not pressed', async () => {
    const model = fakeModel({ slides: { name: null, add: [SLIDES], change: [] } });
    fx = await planFixture({ markdown: goalsDocTemplate(), complete: model });
    await fx.say('');
    const r = await fx.say(SLIDES);
    expect(under(fx, GOALS_HEADING)).toEqual([SLIDES]);
    expect(under(fx, NAME_HEADING)).toEqual([]);
    expect(r.spoken).toBe('Got it.');
  });

  it('on an old four-part doc it asks only what to do better, never each part', async () => {
    fx = await planFixture({ markdown: OLD_LAYOUT });
    const spoken: string[] = [(await fx.say('')).spoken];
    spoken.push((await fx.say(SLIDES)).spoken);
    spoken.push((await fx.say('')).spoken);
    spoken.push((await fx.say(STUCK)).spoken);
    expect(spoken).toEqual(['What do you want to do better?', 'Got it.', '', 'Got it.']);
    expect(under(fx, GOALS_HEADING)).toEqual([SLIDES, STUCK]);
    for (const part of ['What’s behind it', 'Act differently when', 'How']) {
      expect(under(fx, part)).toEqual([]);
      expect(spoken.join(' ')).not.toContain(part);
    }
  });

  it('without a model, the name question takes a name and anything after is a goal', async () => {
    fx = await planFixture({ markdown: goalsDocTemplate() });
    await fx.say('');
    // The second question is the open one, asked once, as the name lands.
    expect((await fx.say('Call it Saltmarsh.')).spoken).toBe('What do you want to do better?');
    expect(under(fx, NAME_HEADING)).toEqual(['Saltmarsh']);
    expect((await fx.say('')).spoken).toBe('');
    await fx.say(SLIDES);
    await fx.say(STUCK);
    expect(under(fx, GOALS_HEADING)).toEqual([SLIDES, STUCK]);
  });
});

describe('learning goals: going back', () => {
  const NEW_FIRST = 'Stop polishing slides after ten; at ten, ask me to send them.';

  it('"change the first one" edits that goal in place and keeps the second', async () => {
    const model = fakeModel({
      'Call it Saltmarsh': { name: 'Saltmarsh', add: [SLIDES, STUCK], change: [] },
      'change the first': { name: null, add: [], change: [{ goal: 1, text: NEW_FIRST }] },
    });
    fx = await planFixture({ markdown: goalsDocTemplate(), complete: model });
    await fx.say('');
    await fx.say(BOTH);
    const r = await fx.say('Actually, change the first one to stopping at ten.');
    expect(under(fx, GOALS_HEADING)).toEqual([NEW_FIRST, STUCK]);
    expect(r.spoken).toBe('Changed goal 1.');
    // The model was shown the goals by number, so "the first one" has a referent.
    expect(model.prompts.at(-1)).toContain(`1. ${SLIDES}`);
  });

  it('a typed goal is revised as a proposal, so the typed words stay readable', async () => {
    const typed = goalsDocTemplate()
      .replace(`## ${NAME_HEADING}\n`, `## ${NAME_HEADING}\n\nSaltmarsh\n`)
      .replace(`## ${GOALS_HEADING}\n`, `## ${GOALS_HEADING}\n\n- ${SLIDES}\n`);
    const model = fakeModel({
      'the first one': { name: null, add: [], change: [{ goal: 1, text: NEW_FIRST }] },
    });
    fx = await planFixture({ markdown: typed, complete: model });
    expect((await fx.say('Change the first one to stopping at ten.')).spoken).toBe(
      'Changed goal 1.',
    );
    // His words are still in the doc, struck; the revision is offered beside them.
    expect(plainText(fx)).toContain(SLIDES);
    expect(fx.docStore.docSuggests.listSuggestions(DOC_ID)).toMatchObject([
      { kind: 'replace', deletedText: SLIDES, insertedText: NEW_FIRST },
    ]);
  });

  it('without a model, "change goal 2 to …" still edits goal 2 in place', async () => {
    fx = await planFixture({ markdown: OLD_LAYOUT });
    await fx.say('');
    await fx.say(SLIDES);
    await fx.say(STUCK);
    await fx.say('Change goal 2 to ask for help after thirty minutes.');
    expect(under(fx, GOALS_HEADING)).toEqual([SLIDES, 'Ask for help after thirty minutes.']);
  });
});

/** Every word-ish token, as the cap counts them. */
const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

describe('every planning reply is one short sentence', () => {
  const LONG_Q =
    'Given that the Riverbend crossing is meant to replace the bridge for commuters, which of the two berth designs does the harbour board prefer and why?';

  it('holds on a plan and on a goals doc, whatever the model or the plan says', async () => {
    const spoken: string[] = [];
    const reader: PlanComplete = async ({ system }) =>
      system.includes('ONE spoken question')
        ? JSON.stringify({ ask: LONG_Q, heading: 'Requirements', quote: '' })
        : JSON.stringify({ answer: [1] });
    fx = await planFixture({ complete: reader });
    for (const line of [
      'Claude, interview me.',
      '',
      '',
      'Cut the crossing to twenty minutes so commuters switch from the bridge.',
      'skip',
      'come back to that',
      'The harbour board signs off, after the tide survey.',
      'any questions?',
      'that is enough',
    ]) {
      spoken.push((await fx.say(line)).spoken);
    }
    fx.stop();
    const model = fakeModel({
      'Call it Saltmarsh': { name: 'Saltmarsh', add: [SLIDES, STUCK], change: [] },
    });
    fx = await planFixture({ markdown: goalsDocTemplate(), complete: model });
    for (const line of ['', BOTH, 'any questions?', 'skip', 'that is enough']) {
      spoken.push((await fx.say(line)).spoken);
    }
    const said = spoken.filter((s) => s);
    expect(said.length).toBeGreaterThan(8);
    for (const s of said) {
      expect({ s, words: words(s) <= 20, sentences: sentences(s).length }).toEqual({
        s,
        words: true,
        sentences: 1,
      });
    }
  });
});
