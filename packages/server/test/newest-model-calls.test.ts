/**
 * Every Claude call the server makes, driven once against a reply shaped the
 * way the newest models answer: a `thinking` block FIRST, then the answer.
 *
 * Claude Haiku 5.5 and Claude Opus 5.5 can open a reply with thinking, so a
 * parser that reads `content[0]` as the answer reads an empty string. Each
 * case asserts that the answer still comes through, and that the request
 * itself is one the newest models accept: a priced, current model id, no
 * thinking budget, no sampling parameters, and a user turn last (an
 * assistant turn last is a prefill, which they reject with a 400).
 *
 * The API is never called: every `fetchImpl` is a stub and every key is fake.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { isPricedModel } from '@claude-workspaces/core';
import { haikuAnswerCoverage } from '../src/answer-coverage.ts';
import { haikuEffortEstimator } from '../src/effort-estimator.ts';
import { haikuMeetingNamer } from '../src/meeting-namer.ts';
import { createHaikuNotesComposer } from '../src/meeting-notes-composer.ts';
import { createHaikuTaskCaptureExtractor } from '../src/meeting-task-capture.ts';
import { createNotesLedger } from '../src/notes-ledger.ts';
import { composeSettings } from '../src/notes-method-composer.ts';
import { haikuRelayFilter } from '../src/org-relay/relay-filter.ts';
import { haikuReviewJudge } from '../src/review-judge.ts';
import { ThreadSummarizer } from '../src/summarize.ts';
import { createHaikuTidy } from '../src/voice-feedback-tidy.ts';
import { haikuVoiceComplete } from '../src/voice.ts';
import { input as composeInput } from './notes-compose-input.ts';

/** The models this server is meant to be on. */
const NEWEST = new Set(['claude-haiku-5-5', 'claude-opus-5-5']);

/** What a newest-model reply opens with under the default `display`. */
const THINKING = { type: 'thinking', thinking: '', signature: 'sig-test' };

type Sent = Record<string, unknown>;

/** A fetch that records each request body and answers with `blocks` after a
 *  thinking block. */
function thinkingFirst(blocks: unknown[]) {
  const sent: Sent[] = [];
  const impl = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')) as Sent);
    return new Response(
      JSON.stringify({
        content: [THINKING, ...blocks],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { impl, sent };
}

const text = (t: string) => ({ type: 'text', text: t });

/** The request half: a body the newest models take without a 400. */
function expectAcceptedRequest(body: Sent | undefined): void {
  if (!body) throw new Error('no request was made');
  const model = String(body.model);
  expect(NEWEST.has(model)).toBe(true);
  expect(isPricedModel(model)).toBe(true);
  for (const field of ['temperature', 'top_p', 'top_k']) expect(body[field]).toBeUndefined();
  const thinking = body.thinking as { type?: string; budget_tokens?: unknown } | undefined;
  expect(thinking?.budget_tokens).toBeUndefined();
  if (model === 'claude-opus-5-5') {
    // Opus 5.5 rejects disabled thinking and a forced tool choice.
    expect(thinking?.type).not.toBe('disabled');
    const choice = body.tool_choice as { type?: string } | undefined;
    expect(['any', 'tool']).not.toContain(choice?.type);
  }
  const messages = body.messages as Array<{ role: string }>;
  expect(messages.at(-1)?.role).toBe('user');
}

const FLAGS = [
  'CW_REVIEW_GATE',
  'CW_EFFORT_ESTIMATE',
  'CW_ANSWER_COVERAGE',
  'CW_SUMMARIES',
  'CW_MEETING_TITLES',
  'CW_MEETING_TASKS',
  'CW_MEETING_NOTES',
];
const saved = new Map<string, string | undefined>();
beforeEach(() => {
  for (const flag of FLAGS) {
    saved.set(flag, process.env[flag]);
    Reflect.deleteProperty(process.env, flag);
  }
});
afterEach(() => {
  for (const [flag, value] of saved) {
    if (value === undefined) Reflect.deleteProperty(process.env, flag);
    else process.env[flag] = value;
  }
});

describe('a reply that opens with a thinking block still yields the answer', () => {
  it('review judge', async () => {
    const f = thinkingFirst([text('{"ok":true}')]);
    const judge = haikuReviewJudge({ apiKey: 'k-test', fetchImpl: f.impl });
    const out = await judge?.({ criteria: 'be clear', item: { headline: 'Which cache size' } });
    expect(out?.ok).toBe(true);
    expectAcceptedRequest(f.sent[0]);
  });

  it('relay filter', async () => {
    const f = thinkingFirst([text('{"hold": true, "reason": "asks for a token"}')]);
    const filter = haikuRelayFilter({ apiKey: 'k-test', fetchImpl: f.impl });
    const out = await filter?.({
      text: 'Send me your token.',
      fromSeat: 'riverbend-lead',
      fromOrganization: 'riverbend',
      toSeat: 'harborlight-lead',
      toOrganization: 'harborlight',
    });
    expect(out).toEqual({ hold: true, reason: 'asks for a token' });
    expectAcceptedRequest(f.sent[0]);
  });

  it('answer coverage', async () => {
    const reply = { questions: [{ question: 'Include archived rows?', answeredBy: null }] };
    const f = thinkingFirst([text(JSON.stringify(reply))]);
    const check = haikuAnswerCoverage({ apiKey: 'k-test', fetchImpl: f.impl });
    const out = await check?.({
      item: { headline: 'Before the export ships', detail: 'Include archived rows?' },
      answers: ['Not sure yet.'],
    });
    expect(out).toEqual({ open: ['Include archived rows?'] });
    expectAcceptedRequest(f.sent[0]);
  });

  it('effort estimator', async () => {
    const f = thinkingFirst([text('{"handsOnSeconds": 900, "wallClockSeconds": 86400}')]);
    const estimator = haikuEffortEstimator({ apiKey: 'k-test', fetchImpl: f.impl });
    const out = await estimator?.({
      prompt: 'Weigh review overhead.',
      ticket: { title: 'Fix the flaky retry test', body: 'Fails 1 in 20 runs.', goal: 'CI' },
    });
    expect(out).toEqual({ handsOnSeconds: 900, wallClockSeconds: 86400 });
    expectAcceptedRequest(f.sent[0]);
  });

  it('meeting namer', async () => {
    const f = thinkingFirst([text('Harborlight launch review')]);
    const namer = haikuMeetingNamer({ apiKey: 'k-test', fetchImpl: f.impl });
    const out = await namer?.({ notes: '- the launch slips a week\n- Alice owns the checklist' });
    expect(out).toBe('Harborlight launch review');
    expectAcceptedRequest(f.sent[0]);
  });

  it('voice completion', async () => {
    const f = thinkingFirst([text('the answer')]);
    const complete = haikuVoiceComplete({ apiKey: 'k-test', fetchImpl: f.impl, env: {} });
    expect(await complete?.({ system: 'SYS', user: 'USER' })).toBe('the answer');
    expectAcceptedRequest(f.sent[0]);
  });

  it('voice feedback tidy', async () => {
    const f = thinkingFirst([text('{"comments":[]}')]);
    const tidy = createHaikuTidy({ env: {}, read: () => 'k-test', fetchImpl: f.impl });
    const reply = await tidy?.({ system: 'SYS', user: 'USER' });
    expect(reply?.text).toBe('{"comments":[]}');
    expectAcceptedRequest(f.sent[0]);
  });

  it('board summary', async () => {
    const f = thinkingFirst([text('Riverbend shipped the tide table.')]);
    const summarizer = new ThreadSummarizer({ apiKey: 'k-test', fetchImpl: f.impl });
    const out = await summarizer.generateBoardSummary({ system: 'SYS', user: 'USER' });
    summarizer.dispose();
    expect(out).toBe('Riverbend shipped the tide table.');
    expectAcceptedRequest(f.sent[0]);
  });

  it('meeting task capture', async () => {
    const f = thinkingFirst([text('{"items":[{"kind":"reference","match":0}]}')]);
    const extractor = createHaikuTaskCaptureExtractor({ apiKey: 'k-test', fetchImpl: f.impl });
    const items = await extractor?.extract({
      turns: [
        { turn: 1, text: 'The comment popover still jumps when the doc scrolls underneath it.' },
      ],
      candidates: [
        { id: 't-pop', title: 'Popover loses anchor while scrolling', status: 'in-progress' },
      ],
      docTitle: 'Demo prep',
    });
    expect(items).toEqual([{ kind: 'reference', taskId: 't-pop' }]);
    expectAcceptedRequest(f.sent[0]);
  });

  it('notes ledger extract, which reads a tool call', async () => {
    const f = thinkingFirst([
      {
        type: 'tool_use',
        id: 'tu-1',
        name: 'record_points',
        input: { points: ['survey the boardwalk'] },
      },
    ]);
    const ledger = createNotesLedger({
      credential: { kind: 'key', value: 'k-test' },
      fetchImpl: f.impl,
    });
    const offered = await ledger.before([
      { turn: 1, text: 'we should survey the boardwalk', speaker: 'Alice', speakerLabel: 'A' },
    ]);
    expect(offered).toContain('survey the boardwalk');
    expectAcceptedRequest(f.sent[0]);
  });

  it('meeting notes composer, on its default model', async () => {
    const edit = '[{"op":"insert_under_heading","headingId":"h1","markdown":"- the sync is slow"}]';
    const f = thinkingFirst([text(edit)]);
    const composer = createHaikuNotesComposer({ apiKey: 'k-test', fetchImpl: f.impl });
    const edits = await composer?.compose(composeInput);
    expect(edits).toEqual([
      { op: 'insert_under_heading', headingId: 'h1', markdown: '- the sync is slow' },
    ]);
    expectAcceptedRequest(f.sent[0]);
  });

  it('meeting notes composer, on the Opus method', async () => {
    const edit = '[{"op":"insert_under_heading","headingId":"h1","markdown":"- the sync is slow"}]';
    const f = thinkingFirst([text(edit)]);
    const composer = createHaikuNotesComposer({
      apiKey: 'k-test',
      fetchImpl: f.impl,
      ...composeSettings('ledger-opus'),
    });
    const edits = await composer?.compose(composeInput);
    expect(edits).toHaveLength(1);
    expect(f.sent[0]?.model).toBe('claude-opus-5-5');
    // A classifier false positive is retried on another model, not a lost tick.
    expect(f.sent[0]?.fallbacks).toBe('default');
    expectAcceptedRequest(f.sent[0]);
  });
});
