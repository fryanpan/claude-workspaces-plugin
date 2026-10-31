/**
 * "Claude, …" stays out of a meeting's notes unless its answer belongs in
 * the minutes (Bryan, 3 Oct: "Claude should only take notes if it thinks
 * its reply should be persisted into the meeting minutes for future
 * reference"). A minute is a decision, a fact found or tasks created, named
 * by the lead in its answer (`answer_voice`'s `minute`) or a change the
 * board itself made — and it is the minute, never the request and reply.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { minuteFor } from '../src/meeting-claude.ts';
import { shapedAnswer } from '../src/spoken-reply/answer.ts';
import type { SpokenAnswer } from '../src/spoken-reply/answer.ts';
import { LEAD_ANSWER_ROUTE, LeadAnswers } from '../src/spoken-reply/lead-answer.ts';
import { routerClassifier, voiceChoices } from '../src/voice-choice.ts';
import type { VoiceClassifyInput } from '../src/voice-classifier.ts';
import { type HeardMeeting, boardSaying, heardMeeting } from './meeting-session-harness.ts';
import { waitFor } from './wait-for.ts';

let m: HeardMeeting | null = null;
afterEach(() => {
  m?.stop();
  m = null;
});

const TASKS = 'Tasks created: Dredge the Saltmarsh channel, Move the ticket office';

describe('which answers are minuted', () => {
  it('a reply with nothing to keep is no minute: a "No.", a status brief, a lookup', () => {
    expect(minuteFor(shapedAnswer('No.', 'agent'))).toBeNull();
    expect(
      minuteFor(
        shapedAnswer('Nothing waiting on you. Harborlight: 5 open — 3 in progress.', 'fast-path'),
      ),
    ).toBeNull();
    expect(minuteFor(shapedAnswer('Opening “Berth plan”.', 'fast-path'))).toBeNull();
    expect(minuteFor(shapedAnswer('Fares are four dollars.', LEAD_ANSWER_ROUTE))).toBeNull();
  });

  it('the lead’s minute, on one line, attributed to Claude', () => {
    const a: SpokenAnswer = { ...shapedAnswer('Done.', LEAD_ANSWER_ROUTE), minute: TASKS };
    expect(minuteFor(a)).toBe(`- Claude: ${TASKS}`);
    const ragged: SpokenAnswer = { ...a, minute: `  ${TASKS.replace(', ', ',\n- ')}  ` };
    expect(minuteFor(ragged)).toBe(`- Claude: ${TASKS.replace(', ', ', - ')}`);
  });

  it('a change the board made itself', () => {
    expect(minuteFor(shapedAnswer('Moved "Sign-in" from todo to done.', 'fast-path-action'))).toBe(
      '- Claude: “Sign-in”: todo → done',
    );
  });
});

describe('in a meeting the page records', () => {
  it('"Claude, …" answered "No." is said and never noted', async () => {
    m = await heardMeeting({ board: boardSaying('No.') });
    m.listen();
    await m.ready();
    m.hear(1, 'Claude, is the berth design signed off?', true);
    await waitFor(() => m?.said.length === 1, { describe: 'the answer said' });
    expect(m.said).toEqual(['No.']);
    expect(m.notes).toEqual([]);
  });

  it('a status brief is said and never noted', async () => {
    m = await heardMeeting({
      board: boardSaying('Nothing waiting on you. Harborlight: 5 open — 3 in progress.'),
    });
    m.listen();
    await m.ready();
    m.hear(1, 'Claude, where are we?', true);
    await waitFor(() => m?.said.length === 1, { describe: 'the answer said' });
    expect(m.notes).toEqual([]);
  });

  it('the lead creating tasks writes one minute, without the request or the reply', async () => {
    m = await heardMeeting({ board: boardSaying('On it.', 'agent', 'q-tasks') });
    m.listen();
    await m.ready();
    m.hear(1, 'Claude, can you create tasks for the berth work?', true);
    await waitFor(() => m?.json.some((f) => f.type === 'doing'), { describe: 'the lead working' });
    expect(m.said).toEqual([]);
    m.listen();
    m.session.sayLead('q-tasks', {
      ...shapedAnswer('Two tasks made.', LEAD_ANSWER_ROUTE),
      minute: TASKS,
    });
    expect(m.notes).toEqual([`- Claude: ${TASKS}`]);
    await waitFor(() => m?.said.length === 1, { describe: 'the answer said' });
    expect(m.said).toEqual(['Two tasks made.']);
  });

  it('the lead’s answer with no minute is said and never noted', async () => {
    m = await heardMeeting({ board: boardSaying('On it.', 'agent', 'q-fares') });
    m.listen();
    await m.ready();
    m.hear(1, 'Claude, can you find the Riverbend fares?', true);
    await waitFor(() => m?.json.some((f) => f.type === 'doing'), { describe: 'the lead working' });
    expect(m.said).toEqual([]);
    m.listen();
    m.session.sayLead('q-fares', shapedAnswer('Four dollars.', LEAD_ANSWER_ROUTE));
    await waitFor(() => m?.said.length === 1, { describe: 'the answer said' });
    expect(m.notes).toEqual([]);
  });
});

describe('the lead’s minute travels with its answer', () => {
  it('LeadAnswers hands the minute on with the words', () => {
    const leads = new LeadAnswers();
    const got: SpokenAnswer[] = [];
    leads.wait('w1', 'q1', {}, (x) => got.push(x));
    expect(leads.answer('w1', 'q1', 'Two tasks made.', TASKS)).toBe(true);
    expect(got[0]?.minute).toBe(TASKS);
  });
});

describe('a question about doing work is not a status ask', () => {
  const input = (transcript: string): VoiceClassifyInput => ({
    index: { goals: [], tasks: [], docIds: [] },
    transcript,
  });
  /** A model that always picks the status option, as Haiku did. */
  const picksStatus = (i: VoiceClassifyInput) => async () => {
    const id = voiceChoices(i).find((o) => o.classification.kind === 'status')?.id;
    return JSON.stringify({ choice: id, confidence: 0.9 });
  };

  it('goes to the lead when it names no status', async () => {
    for (const said of [
      'do you have enough information to create tasks from this meeting?',
      'can you review all of the questions in this doc?',
    ]) {
      const i = input(said);
      const r = await routerClassifier(picksStatus(i))(i);
      expect(r.classification, said).toEqual({ kind: 'change' });
    }
  });

  it('is still a status ask when it asks how things stand', async () => {
    for (const said of ['how are things going on the berth?', 'what is waiting on me today?']) {
      const i = input(said);
      const r = await routerClassifier(picksStatus(i))(i);
      expect(r.classification, said).toEqual({ kind: 'status' });
    }
  });
});
