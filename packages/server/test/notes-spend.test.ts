/**
 * Summing a meeting's calls. The split matters as much as the total: the
 * capture half is the one a person can switch off, and it is the half that
 * was missing from the figure the chooser printed.
 */
import { describe, expect, it } from 'bun:test';
import { dollars } from '@claude-workspaces/core';
import { NO_SPEND, meetingSpend } from '../src/notes-spend.ts';
import type { NotesCallUsage } from '../src/notes-timing.ts';

const HAIKU = 'claude-haiku-4-5-20251001';

const call = (
  kind: NotesCallUsage['call'],
  over: Partial<NotesCallUsage['usage']> = {},
  model = HAIKU,
): NotesCallUsage => ({
  call: kind,
  model,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  },
});

describe('what a meeting came to', () => {
  it('sums every call into the total', () => {
    const calls = [
      call('compose', { inputTokens: 1_000_000 }),
      call('compose', { outputTokens: 1_000_000 }),
    ];
    expect(meetingSpend(calls).totalUsd).toBeCloseTo(6, 6);
    expect(meetingSpend(calls).calls).toBe(2);
  });

  it('keeps compose and capture apart, because one of them can be switched off', () => {
    const spend = meetingSpend([
      call('compose', { inputTokens: 1_000_000 }),
      call('capture', { inputTokens: 500_000 }),
    ]);
    expect(spend.byCall.compose).toBeCloseTo(1, 6);
    expect(spend.byCall.capture).toBeCloseTo(0.5, 6);
    expect(spend.totalUsd).toBeCloseTo(1.5, 6);
  });

  it('counts a capture call at all — the number that used to be zero', () => {
    // The pre-fix pipeline recorded compose usage and discarded capture's, so
    // a meeting that made both reported only the first. Capture alone must
    // therefore be non-zero on its own.
    const spend = meetingSpend([call('capture', { inputTokens: 200_000, outputTokens: 2_000 })]);
    expect(spend.byCall.capture).toBeGreaterThan(0);
    expect(spend.byCall.compose).toBe(0);
    expect(spend.totalUsd).toBe(spend.byCall.capture);
  });

  it('carries the raw token counts as well as the dollars', () => {
    const spend = meetingSpend([
      call('compose', { inputTokens: 10, cacheReadTokens: 700 }),
      call('capture', { inputTokens: 5, outputTokens: 3 }),
    ]);
    expect(spend.usage).toEqual({
      inputTokens: 15,
      outputTokens: 3,
      cacheReadTokens: 700,
      cacheWriteTokens: 0,
    });
  });

  it('prices cache reads and writes, so a cached meeting is not reported as cheap', () => {
    const cached = call('compose', { inputTokens: 100, cacheReadTokens: 40_000 });
    expect(meetingSpend([cached]).totalUsd).toBeCloseTo(dollars(cached.usage, HAIKU), 9);
    expect(meetingSpend([cached]).totalUsd).toBeGreaterThan(
      dollars({ ...cached.usage, cacheReadTokens: 0 }, HAIKU),
    );
  });

  it('names a model it cannot price rather than counting it as free', () => {
    const spend = meetingSpend([
      call('compose', { inputTokens: 1_000_000 }),
      call('capture', { inputTokens: 1_000_000 }, 'claude-imaginary-9'),
    ]);
    expect(spend.unpricedModels).toEqual(['claude-imaginary-9']);
    expect(spend.byCall.capture).toBe(0);
    // Its tokens are still real and still counted as tokens.
    expect(spend.usage.inputTokens).toBe(2_000_000);
    expect(spend.calls).toBe(2);
  });

  it('an unpriced model is named once however many calls it made', () => {
    const spend = meetingSpend([
      call('capture', { inputTokens: 1 }, 'claude-imaginary-9'),
      call('capture', { inputTokens: 1 }, 'claude-imaginary-9'),
    ]);
    expect(spend.unpricedModels).toEqual(['claude-imaginary-9']);
  });

  it('no calls is no spend, and the same shape a reader can add to', () => {
    expect(meetingSpend([])).toEqual(NO_SPEND);
  });
});
