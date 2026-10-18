/**
 * A digest's prompts and turns said in a few words: one model call per
 * digest, and each mark falls back to its own first words when the call
 * fails, the reply will not parse, or there is no key.
 */
import { describe, expect, it } from 'bun:test';
import {
  SUMMARY_LINE_CHARS,
  SUMMARY_MARK_CHARS,
  SUMMARY_MAX_CALLS,
  SUMMARY_MAX_MARKS,
  buildCoachSummaryPrompt,
  coachSummariesEnabled,
  fallbackSummary,
  haikuCoachSummarizer,
  parseCoachSummaries,
  summariseMarks,
} from '../src/coach/summary.ts';

const prompt = (text: string) => ({ kind: 'prompt' as const, text });

describe('the coach summary', () => {
  it('numbers each mark with its kind, and cuts a long one', () => {
    const { user } = buildCoachSummaryPrompt([
      prompt('chart the Harborlight berths'),
      { kind: 'turn', text: 'x'.repeat(SUMMARY_MARK_CHARS + 50) },
    ]);
    expect(user).toContain('1. [prompt] chart the Harborlight berths');
    expect(user).toContain(`2. [turn] ${'x'.repeat(SUMMARY_MARK_CHARS)}\n`);
    expect(user).not.toContain('x'.repeat(SUMMARY_MARK_CHARS + 1));
  });

  it('reads a JSON array of one line per mark, and nothing else', () => {
    expect(parseCoachSummaries('Here: ["Charted berths", ""]', 2)).toEqual([
      'Charted berths',
      null,
    ]);
    expect(parseCoachSummaries('["one"]', 2)).toBeNull();
    expect(parseCoachSummaries('no array', 1)).toBeNull();
    expect(parseCoachSummaries('[1]', 1)).toEqual([null]);
  });

  it('falls back to each mark’s own words, never rejecting', async () => {
    const marks = [prompt('chart   the\nberths'), prompt('y'.repeat(SUMMARY_LINE_CHARS + 10))];
    expect(await summariseMarks(marks, undefined)).toEqual([
      'chart the berths',
      fallbackSummary('y'.repeat(SUMMARY_LINE_CHARS + 10)),
    ]);
    expect(fallbackSummary('y'.repeat(SUMMARY_LINE_CHARS + 10))).toHaveLength(SUMMARY_LINE_CHARS);
    const throws = async () => {
      throw new Error('boom');
    };
    expect(await summariseMarks(marks, throws)).toHaveLength(2);
    expect(await summariseMarks(marks, async () => ['Charted berths', null])).toEqual([
      'Charted berths',
      fallbackSummary(marks[1]?.text ?? ''),
    ]);
  });

  it('asks the model about 40 marks a call, so a long digest has a line for every prompt', async () => {
    const asked: number[] = [];
    const marks = Array.from({ length: SUMMARY_MAX_MARKS + 5 }, (_, i) => prompt(`p${i}`));
    const lines = await summariseMarks(marks, async (m) => {
      asked.push(m.length);
      return m.map(() => 'said');
    });
    expect(asked).toEqual([SUMMARY_MAX_MARKS, 5]);
    expect(lines.every((l) => l === 'said')).toBe(true);
  });

  it('stops at SUMMARY_MAX_CALLS calls, and a failed call costs only its own marks', async () => {
    const total = SUMMARY_MAX_MARKS * SUMMARY_MAX_CALLS + 2;
    const marks = Array.from({ length: total }, (_, i) => prompt(`p${i}`));
    let calls = 0;
    const lines = await summariseMarks(marks, async (m) => {
      calls += 1;
      if (calls === 2) throw new Error('429');
      return m.map(() => 'said');
    });
    expect(calls).toBe(SUMMARY_MAX_CALLS);
    expect(lines[0]).toBe('said');
    expect(lines[SUMMARY_MAX_MARKS]).toBe(`p${SUMMARY_MAX_MARKS}`);
    expect(lines[SUMMARY_MAX_MARKS * 2]).toBe('said');
    expect(lines.at(-1)).toBe(`p${total - 1}`);
  });

  it('has no summariser without a key, and none when switched off', () => {
    expect(haikuCoachSummarizer({ apiKey: null })).toBeNull();
    expect(coachSummariesEnabled({ CW_COACH_SUMMARIES: '0' })).toBe(false);
    expect(coachSummariesEnabled({})).toBe(true);
  });

  it('answers null on an HTTP error', async () => {
    const fetchImpl = (async () => new Response('', { status: 429 })) as unknown as typeof fetch;
    const s = haikuCoachSummarizer({ apiKey: 'k-test', fetchImpl });
    expect(await s?.([prompt('chart the berths')])).toBeNull();
  });
});
