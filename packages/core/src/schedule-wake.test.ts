/**
 * The wake's retry policy, driven directly (`schedule-wake.ts`). Every
 * instant is a literal; fixtures are invented.
 */
import { describe, expect, it } from 'vitest';
import {
  type ScheduleWake,
  WAKE_BACKOFF_MS,
  WAKE_MAX_ATTEMPTS,
  describeAttempts,
  wakeStatus,
  wakeStep,
} from './schedule-wake.ts';

const T0 = Date.UTC(2026, 2, 2, 9);
const MINUTE = 60_000;

function tried(times: number[]): ScheduleWake {
  return { instanceId: 't-run', attempts: times.map((at) => ({ at, via: 'nobody' as const })) };
}

describe('when the wake tries again', () => {
  it('tries at once for a fresh instance', () => {
    expect(wakeStep(undefined, T0)).toBe('attempt');
    expect(wakeStep({ instanceId: 't-run', attempts: [] }, T0)).toBe('attempt');
  });

  it('waits out each backoff before the next attempt: 5, 15, then 45 minutes', () => {
    expect(wakeStep(tried([T0]), T0 + 4 * MINUTE)).toBe('wait');
    expect(wakeStep(tried([T0]), T0 + 5 * MINUTE)).toBe('attempt');
    const two = tried([T0, T0 + 5 * MINUTE]);
    expect(wakeStep(two, T0 + 19 * MINUTE)).toBe('wait');
    expect(wakeStep(two, T0 + 20 * MINUTE)).toBe('attempt');
    const three = tried([T0, T0 + 5 * MINUTE, T0 + 20 * MINUTE]);
    expect(wakeStep(three, T0 + 64 * MINUTE)).toBe('wait');
    expect(wakeStep(three, T0 + 65 * MINUTE)).toBe('attempt');
  });

  it('is exhausted one more window after the last attempt, never before', () => {
    const four = tried([T0, T0 + 5 * MINUTE, T0 + 20 * MINUTE, T0 + 65 * MINUTE]);
    expect(four.attempts).toHaveLength(WAKE_MAX_ATTEMPTS);
    const lastWait = WAKE_BACKOFF_MS[WAKE_BACKOFF_MS.length - 1] ?? 0;
    expect(wakeStep(four, T0 + 65 * MINUTE + lastWait - 1)).toBe('wait');
    expect(wakeStep(four, T0 + 65 * MINUTE + lastWait)).toBe('exhausted');
    // Still exhausted, never another attempt.
    expect(wakeStep(four, T0 + 30 * 24 * 60 * MINUTE)).toBe('exhausted');
  });
});

describe('what the record says about a wake', () => {
  it('reads answered, waiting or unanswered off the state', () => {
    const w = tried([T0]);
    expect(wakeStatus(w)).toBe('waiting');
    expect(wakeStatus({ ...w, exhaustedItemId: 'r-1' })).toBe('unanswered');
    expect(wakeStatus({ ...w, exhaustedItemId: 'r-1', answeredAt: T0 + MINUTE })).toBe('answered');
  });

  it('counts the attempts by who they reached', () => {
    const w: ScheduleWake = {
      instanceId: 't-run',
      attempts: [
        { at: T0, via: 'owner', to: 'agent-a' },
        { at: T0, via: 'spawner', to: 'agent-lead' },
        { at: T0, via: 'owner', to: 'agent-a' },
      ],
    };
    expect(describeAttempts(w)).toBe('owner ×2, spawner ×1');
  });
});
