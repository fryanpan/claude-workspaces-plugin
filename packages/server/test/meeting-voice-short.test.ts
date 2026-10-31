/**
 * A meeting hears the shortest answer that works: one sentence, at most
 * `MEETING_SPOKEN_MAX_WORDS` words, whoever wrote it — the board's router,
 * the lead's answer, or the planning voice. Voice is slower than reading, so
 * "No." beats a sentence (Bryan, 3 Oct). Each case below gives the meeting a
 * long answer and reads back what was said.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { MEETING_SPOKEN_MAX_WORDS, spokenLine } from '../src/meeting-claude.ts';
import { shapedAnswer } from '../src/spoken-reply/answer.ts';
import { LEAD_ANSWER_ROUTE } from '../src/spoken-reply/lead-answer.ts';
import {
  type HeardMeeting,
  boardSaying,
  heardMeeting,
  wordsIn,
} from './meeting-session-harness.ts';
import { waitFor } from './wait-for.ts';

const LONG_ACK =
  'The Harborlight board has eleven open tasks across three goals, and most of them are moving along well on the ferry crossing this week. ' +
  'Riverbend is waiting on the berth design. Saltmarsh dredging starts in March once the permits clear.';

const LONG_QUESTION =
  'Before we go any further with the berth, who exactly on the Riverbend side is going to sign off the final design and on what date do they need it?';

/** Bryan's "about 20 words", as a number the tests hold the cap to. */
const CAP = 20;

let m: HeardMeeting | null = null;
afterEach(() => {
  m?.stop();
  m = null;
});

describe('the line a meeting hears', () => {
  it('is the first sentence, cut at the word cap', () => {
    const a = shapedAnswer(LONG_ACK, 'fast-path');
    const line = spokenLine(a);
    expect(wordsIn(line)).toBeLessThanOrEqual(CAP);
    expect(line).not.toContain('Riverbend');
    expect(MEETING_SPOKEN_MAX_WORDS).toBeLessThanOrEqual(CAP);
  });

  it('is the question, when the answer asks one, without its "Next:" label', () => {
    const a = shapedAnswer('Written under Work. Next: Who signs off the dredging?', 'interview');
    expect(spokenLine(a)).toBe('Who signs off the dredging?');
  });

  it('keeps "No." as "No."', () => {
    expect(spokenLine(shapedAnswer('No.', 'fast-path'))).toBe('No.');
  });
});

describe('a long answer in a meeting is said short', () => {
  it('from the board’s router', async () => {
    m = await heardMeeting({ board: boardSaying(LONG_ACK) });
    m.listen();
    await m.ready();
    m.hear(1, 'Claude, how is the board doing?', true);
    await waitFor(() => m?.said.length === 1, { describe: 'the answer said' });
    expect(wordsIn(m.said[0] ?? '')).toBeLessThanOrEqual(CAP);
    expect(m.said[0]).not.toMatch(/\. \S/);
  });

  it('from the lead', async () => {
    m = await heardMeeting({ board: boardSaying('On it.', 'agent', 'q-berth') });
    m.listen();
    await m.ready();
    m.hear(1, 'Claude, can you check who signs off the berth?', true);
    await waitFor(() => m?.json.some((f) => f.type === 'doing'), { describe: 'the lead working' });
    expect(m.said).toEqual([]);
    m.listen();
    m.session.sayLead('q-berth', shapedAnswer(LONG_ACK, LEAD_ANSWER_ROUTE));
    await waitFor(() => m?.said.length === 1, { describe: 'the lead’s answer said' });
    expect(wordsIn(m.said[0] ?? '')).toBeLessThanOrEqual(CAP);
    expect(m.said[0]).not.toMatch(/\. \S/);
  });

  it('from the planning voice', async () => {
    m = await heardMeeting({
      plan: true,
      complete: async () => JSON.stringify({ ask: LONG_QUESTION, heading: 'Design' }),
    });
    m.listen();
    await m.ready();
    m.hear(1, 'Claude, any questions?', true);
    await waitFor(() => m?.said.length === 1, { describe: 'the question said' });
    expect(wordsIn(m.said[0] ?? '')).toBeLessThanOrEqual(CAP);
  });

  it('"any questions?" with none to ask is answered "No."', async () => {
    m = await heardMeeting({
      plan: true,
      complete: async () =>
        JSON.stringify({ ask: null, why: 'The plan already settles who it is for and why.' }),
    });
    m.listen();
    await m.ready();
    m.hear(1, 'Claude, any questions?', true);
    await waitFor(() => m?.said.length === 1, { describe: 'the answer said' });
    expect(m.said).toEqual(['No.']);
  });
});
