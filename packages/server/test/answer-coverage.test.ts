/**
 * The coverage check's network half and its rules for when it is asked. The
 * API is never called: `fetchImpl` is a stub and the key is injected.
 *
 * All fixtures are invented; the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  type AnswerCoverage,
  coverageApplies,
  haikuAnswerCoverage,
  openPartsAfter,
} from '../src/answer-coverage.ts';

const ITEM = {
  headline: 'Two things before the export ships',
  detail: 'Run at 02:00 or 04:00? Include archived rows?',
};

function stubFetch(reply: { status?: number; text?: string } | Error, sent: { body?: string }) {
  return (async (_url: string, init?: { body?: string }) => {
    sent.body = init?.body;
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify({ content: [{ text: reply.text ?? '' }] }), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('the real check', () => {
  it('sends the item and every answer, and returns the open questions', async () => {
    const sent: { body?: string } = {};
    const check = haikuAnswerCoverage({
      apiKey: 'test-key',
      fetchImpl: stubFetch(
        {
          text: JSON.stringify({
            questions: [
              { question: 'Run at 02:00 or 04:00?', answeredBy: '04:00.' },
              { question: 'Include archived rows?', answeredBy: null },
            ],
          }),
        },
        sent,
      ),
    });
    const out = await check?.({ item: ITEM, answers: ['04:00.'] });
    expect(out).toEqual({ open: ['Include archived rows?'] });
    expect(sent.body).toContain('Include archived rows?');
    expect(sent.body).toContain('04:00.');
  });

  it('every failure is no verdict, so the answer closes the item', async () => {
    for (const reply of [{ status: 529 }, { text: 'not json' }, new Error('socket hang up')]) {
      const check = haikuAnswerCoverage({ apiKey: 'test-key', fetchImpl: stubFetch(reply, {}) });
      expect(await check?.({ item: ITEM, answers: ['04:00.'] })).toBeNull();
    }
  });

  it('is not built without a key', () => {
    expect(haikuAnswerCoverage({ apiKey: null })).toBeNull();
  });
});

describe('when an answer is checked', () => {
  it('only a typed answer to an item asking two or more questions', () => {
    const review = { shape: 'review' as const, ...ITEM };
    expect(coverageApplies(review, undefined)).toBe(true);
    expect(coverageApplies(review, 'o-late')).toBe(false);
    expect(coverageApplies({ ...review, detail: 'Run at 04:00?' }, undefined)).toBe(false);
    expect(coverageApplies({ ...review, shape: 'secret' as const }, undefined)).toBe(false);
  });
});

describe('the open parts an answer leaves', () => {
  const review = { shape: 'review' as const, ...ITEM };

  it('are what the check named', async () => {
    const check: AnswerCoverage = async () => ({ open: ['Include archived rows?'] });
    expect(await openPartsAfter(check, { review }, '04:00.')).toEqual(['Include archived rows?']);
  });

  it('are judged with the answers given to the current wording, not a replaced one', async () => {
    const sent: string[][] = [];
    const check: AnswerCoverage = async (input) => {
      sent.push(input.answers);
      return { open: [] };
    };
    const partial = (text: string, ts: number) => ({ text, by: 'Reader', ts, open: ['q?'] });
    const item = {
      review,
      partialAnswers: [partial('Before the rewrite.', 10), partial('After the rewrite.', 30)],
      revisions: [{ at: 20, by: 'Filer', headline: 'Old wording' }],
    };
    await openPartsAfter(check, item, 'Now.');
    expect(sent).toEqual([['After the rewrite.', 'Now.']]);
  });

  it('are judged again against the item as it stands when it changed during the call', async () => {
    const sent: string[][] = [];
    const check: AnswerCoverage = async (input) => {
      sent.push(input.answers);
      return { open: sent.length === 1 ? [] : ['Include archived rows?'] };
    };
    const partial = { text: 'On-call gets the alert.', by: 'Reader', ts: 5, open: ['q?'] };
    const answeredMeanwhile = { review, partialAnswers: [partial] };
    expect(await openPartsAfter(check, { review }, '04:00.', () => answeredMeanwhile)).toEqual([
      'Include archived rows?',
    ]);
    expect(sent).toEqual([['04:00.'], ['On-call gets the alert.', '04:00.']]);
  });

  it('are none when the item keeps changing, is gone, or was closed meanwhile', async () => {
    const check: AnswerCoverage = async () => ({ open: ['Include archived rows?'] });
    let n = 0;
    const partial = { text: 'x', by: 'Reader', ts: 5, open: ['q?'] };
    const changing = () => ({ review, partialAnswers: Array.from({ length: ++n }, () => partial) });
    const closed = () => ({ review, answer: { text: 'All of it.', by: 'Reader', ts: 6 } });
    expect(await openPartsAfter(check, { review }, '04:00.', changing)).toEqual([]);
    expect(await openPartsAfter(check, { review }, '04:00.', () => undefined)).toEqual([]);
    expect(await openPartsAfter(check, { review }, '04:00.', closed)).toEqual([]);
  });

  it('are none when the check is missing, cannot tell, or throws', async () => {
    const nothing: AnswerCoverage = async () => null;
    const throws: AnswerCoverage = async () => {
      throw new Error('boom');
    };
    expect(await openPartsAfter(undefined, { review }, '04:00.')).toEqual([]);
    expect(await openPartsAfter(nothing, { review }, '04:00.')).toEqual([]);
    expect(await openPartsAfter(throws, { review }, '04:00.')).toEqual([]);
  });
});
