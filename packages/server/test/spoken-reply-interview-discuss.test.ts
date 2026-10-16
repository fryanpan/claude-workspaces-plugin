/**
 * The planning voice talking its question over (`interview-discuss.ts`):
 * words about the question that answer nothing — a question back, a
 * disagreement — get one short sentence back, and the same question stays
 * open under the same heading until an answer is written there. "I don't
 * know yet" and words about something else still go quiet, and with no model
 * nothing changes. The model is a script that answers the reader's, the
 * judge's and the discussion's prompts apart; names are the house ones.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { parseAgentFocus } from '@claude-workspaces/core/spoken-reply';
import { AGENT_FOCUS_FIELD } from '@claude-workspaces/core/spoken-reply';
import { JUDGE_SYSTEM, parseVerdict } from '../src/spoken-reply/interview-answer.ts';
import { DISCUSS_SYSTEM, discussPrompt } from '../src/spoken-reply/interview-discuss.ts';
import type { InterviewEndRow, InterviewGapRow } from '../src/spoken-reply/interview-log.ts';
import { PLANNING_MAX_WORDS, wordCount } from '../src/spoken-reply/interview-phrases.ts';
import { READER_SYSTEM } from '../src/spoken-reply/interview-reader.ts';
import { DOC_ID, type Fixture, planFixture } from './interview-fixture.ts';

const BERTH_PLAN = `# Harborlight berth plan

## Goal

Open the second Harborlight berth to Riverbend ferries by spring.

### Work

- Dredge the Saltmarsh channel to four metres before March.
`;

const QUESTION = 'Who signs off the dredging?';
const ASK = JSON.stringify({ ask: QUESTION, heading: 'Work', quote: 'Saltmarsh channel' });
const NONE = '{"ask": null, "why": "Nothing is open."}';
const ASKED_BACK = 'What do you mean by sign off?';
const EXPLAINED = 'I mean who approves the dredging plan before any work starts.';
const ANSWER = 'The Saltmarsh harbour office signs it off.';
const DISCUSS = '{"answer": [], "discuss": true}';
const PICK_ONE = '{"answer": [1]}';

let fx: Fixture | null = null;
afterEach(() => {
  fx?.stop();
  fx = null;
});

/** A scripted model: the reader asks once then has nothing, the judge and
 *  the discussion reply in the order given. */
function model(judged: string[], replies: Array<string | Error> = [EXPLAINED]) {
  const calls = { reader: 0, judge: 0, discuss: [] as string[] };
  return {
    calls,
    complete: async ({ system, user }: { system: string; user: string }) => {
      if (system.startsWith(READER_SYSTEM)) return calls.reader++ === 0 ? ASK : NONE;
      if (system.startsWith(JUDGE_SYSTEM)) {
        calls.judge++;
        return judged.shift() ?? PICK_ONE;
      }
      if (system === DISCUSS_SYSTEM) {
        calls.discuss.push(user);
        const next = replies.shift();
        if (next instanceof Error || next === undefined) throw next ?? new Error('model down');
        return next;
      }
      return '';
    },
  };
}

function focusOf(f: Fixture) {
  const state = f.docStore.get(DOC_ID)?.awareness.getLocalState() as Record<string, unknown> | null;
  return parseAgentFocus(state?.[AGENT_FOCUS_FIELD]);
}

describe('a question back to the planning voice', () => {
  it('gets one sentence back, and the same question stays open with its cursor', async () => {
    const m = model([DISCUSS]);
    fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete });
    expect((await fx.say('We dredge first.')).spoken).toBe(QUESTION);
    const asked = focusOf(fx);
    const r = await fx.say(ASKED_BACK);
    expect(r).toMatchObject({
      spoken: EXPLAINED,
      asking: true,
      route: 'interview',
      question: QUESTION,
    });
    // Not settled, not re-read, not re-asked: the cursor has not moved.
    expect(fx.interview.active).toBe(true);
    expect(m.calls.reader).toBe(1);
    expect(focusOf(fx)).toEqual(asked);
    expect(fx.rows.filter((row) => row.type === 'gap')).toEqual([]);
    expect(fx.lines).toContain(`[interview] doc=${DOC_ID} section=2 after-answer=discuss`);
    // The discussion is given the plan, the question, its words and what was said.
    expect(m.calls.discuss[0]).toContain('Dredge the Saltmarsh channel');
    expect(m.calls.discuss[0]).toContain(`YOUR QUESTION: ${QUESTION}`);
    expect(m.calls.discuss[0]).toContain('ABOUT THESE WORDS OF THE PLAN: Saltmarsh channel');
    expect(m.calls.discuss[0]).toContain(`THEY SAID: ${ASKED_BACK}`);
  });

  it('a later answer is written under the same heading', async () => {
    const m = model([DISCUSS, PICK_ONE]);
    fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete });
    await fx.say('We dredge first.');
    await fx.say(ASKED_BACK);
    const r = await fx.say(ANSWER);
    expect(r.spoken).toBe('Written under Work.');
    expect(fx.headingOf(ANSWER)).toBe('Work');
    expect(fx.headingOf(ASKED_BACK)).toBeNull();
    expect(fx.lines).toContain(`[interview] doc=${DOC_ID} section=2 after-answer=edit`);
  });

  it('keeps the talk out of the answer’s minutes, and counts it on its own', async () => {
    const m = model([DISCUSS, PICK_ONE]);
    fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete });
    await fx.say('We dredge first.');
    fx.tick(60_000);
    await fx.say(ASKED_BACK);
    fx.tick(30_000);
    await fx.say(ANSWER);
    const gap = fx.rows.find((row): row is InterviewGapRow => row.type === 'gap');
    expect(gap).toMatchObject({ outcome: 'filled', ms: 30_000 });
    const end = fx.rows.find((row): row is InterviewEndRow => row.type === 'end');
    expect(end).toMatchObject({
      filled: 1,
      minutesPerFilled: 0.5,
      discussed: 1,
      discussMs: 60_000,
    });
  });

  it('says one sentence of at most twenty words, however much the model says', async () => {
    const long =
      'Signing off means the Harborlight harbour office reads the dredging plan, checks the tide tables, ' +
      'and agrees the channel depth in writing before any boat moves. After that the crews start.';
    const m = model([DISCUSS], [long]);
    fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete });
    await fx.say('We dredge first.');
    const r = await fx.say(ASKED_BACK);
    expect(r.spoken.length).toBeGreaterThan(0);
    expect(wordCount(r.spoken)).toBeLessThanOrEqual(PLANNING_MAX_WORDS);
    expect(r.spoken).not.toContain('After that');
  });

  it('a talked-over discussion reply leaves the question open', async () => {
    const m = model([DISCUSS, PICK_ONE]);
    fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete });
    await fx.say('We dredge first.');
    await fx.say(ASKED_BACK);
    fx.interview.withdraw();
    expect(fx.interview.active).toBe(true);
    expect((await fx.say(ANSWER)).spoken).toBe('Written under Work.');
  });
});

describe('what still goes quiet', () => {
  it('“I don’t know yet” after a discussion defers, with no judge call', async () => {
    const m = model([DISCUSS]);
    fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete });
    await fx.say('We dredge first.');
    await fx.say(ASKED_BACK);
    const r = await fx.say('I don’t know yet.');
    expect(r).toMatchObject({ spoken: '', asking: true });
    expect(m.calls.judge).toBe(1);
    expect(fx.rows.find((row) => row.type === 'gap')).toMatchObject({ outcome: 'deferred' });
  });

  it('words about something else stay quiet and say nothing', async () => {
    const m = model(['{"answer": [], "discuss": false}']);
    fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete });
    await fx.say('We dredge first.');
    const r = await fx.say('Can somebody close the window?');
    expect(r.spoken).toBe('');
    expect(m.calls.discuss).toEqual([]);
    expect(fx.lines).toContain(`[interview] doc=${DOC_ID} section=2 after-answer=quiet`);
  });

  it('a discussion reply the model cannot give stays quiet', async () => {
    const m = model([DISCUSS], [new Error('model down')]);
    fx = await planFixture({ markdown: BERTH_PLAN, complete: m.complete });
    await fx.say('We dredge first.');
    const r = await fx.say(ASKED_BACK);
    expect(r.spoken).toBe('');
    expect(fx.lines).toContain(`[interview] doc=${DOC_ID} section=2 after-answer=quiet`);
  });

  it('with no model, what is said after a question is written as before', async () => {
    fx = await planFixture();
    const first = await fx.say('Interview me.');
    const heading = first.spoken.match(/under (\w+)/)?.[1] ?? '';
    const r = await fx.say(ASKED_BACK);
    expect(r.detail[0]).toBe(`Written under ${heading}.`);
    expect(fx.headingOf(ASKED_BACK)).toBe(heading);
  });
});

describe('parseVerdict and discussPrompt', () => {
  it('discusses only when no sentence answers', () => {
    expect(parseVerdict(DISCUSS, 2)).toEqual({ picks: [], discuss: true });
    expect(parseVerdict('{"answer": [2], "discuss": true}', 2)).toEqual({
      picks: [1],
      discuss: false,
    });
    expect(parseVerdict('{"answer": []}', 2)).toEqual({ picks: [], discuss: false });
    expect(parseVerdict('{"answer": [], "discuss": "yes"}', 2)).toEqual({
      picks: [],
      discuss: false,
    });
    expect(parseVerdict('no json', 2)).toBeNull();
  });

  it('names no plan words when the question has none', () => {
    const p = discussPrompt({ outline: [], question: 'Why spring?', said: 'Why not?' });
    expect(p.system).toBe(DISCUSS_SYSTEM);
    expect(p.user).not.toContain('ABOUT THESE WORDS');
  });
});
