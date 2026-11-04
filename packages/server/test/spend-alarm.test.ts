/**
 * `spend-alarm.ts` (security review L3): every board server spends the one
 * shared Anthropic key, so each one raises a warning the day its own model
 * calls cross a configured dollar figure. Driven with an injected clock and
 * a recorded raise, so nothing waits and nothing reaches Sentry.
 */
import { describe, expect, it } from 'bun:test';
import type { TokenUsage } from '@claude-workspaces/core';
import { resolveServerConfig } from '../src/server-config.ts';
import { SpendAlarm, recordModelSpend, setSpendAlarm } from '../src/spend-alarm.ts';

const DAY = 24 * 60 * 60_000;
const NOON = Date.UTC(2026, 10, 4, 12);
/** One million output tokens: a priced model's whole output rate. */
const MILLION_OUT: TokenUsage = {
  inputTokens: 0,
  outputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const HAIKU = 'claude-haiku-4-5';

function rig(thresholdUsd: number) {
  let now = NOON;
  const raised: Array<{ message: string; extra: Record<string, string> }> = [];
  const alarm = new SpendAlarm({
    thresholdUsd,
    raise: (message, extra) => raised.push({ message, extra }),
    now: () => now,
  });
  return {
    alarm,
    raised,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('SpendAlarm', () => {
  it('raises once on the call that crosses the day’s threshold, not before', () => {
    const { alarm, raised } = rig(1);
    alarm.record(HAIKU, { ...MILLION_OUT, outputTokens: 100_000 });
    expect(raised).toEqual([]);
    for (let i = 0; i < 20; i++) alarm.record(HAIKU, { ...MILLION_OUT, outputTokens: 100_000 });
    expect(raised).toHaveLength(1);
    expect(raised[0]?.message).toContain('over $1');
    expect(raised[0]?.extra.day).toBe('2026-11-04');
  });

  it('starts again on the next UTC day, and raises again when that day crosses', () => {
    const { alarm, raised, advance } = rig(1);
    alarm.record(HAIKU, MILLION_OUT);
    expect(raised).toHaveLength(1);
    advance(DAY);
    alarm.record(HAIKU, { ...MILLION_OUT, outputTokens: 1 });
    expect(raised).toHaveLength(1);
    alarm.record(HAIKU, MILLION_OUT);
    expect(raised).toHaveLength(2);
    expect(raised[1]?.extra.day).toBe('2026-11-05');
  });

  it('counts an unpriced model as nothing and names it when it raises', () => {
    const { alarm, raised } = rig(1);
    alarm.record('claude-unknown-model', MILLION_OUT);
    expect(raised).toEqual([]);
    alarm.record(HAIKU, MILLION_OUT);
    expect(raised[0]?.extra.unpricedModels).toBe('claude-unknown-model');
  });

  it('CONTROL: a threshold above the day’s spend never raises', () => {
    const { alarm, raised } = rig(1_000_000);
    for (let i = 0; i < 5; i++) alarm.record(HAIKU, MILLION_OUT);
    expect(raised).toEqual([]);
  });
});

describe('the process-wide alarm', () => {
  it('records into the alarm the server set, and into nothing when none is set', () => {
    const { alarm, raised } = rig(1);
    setSpendAlarm(alarm);
    try {
      recordModelSpend(HAIKU, MILLION_OUT);
      expect(raised).toHaveLength(1);
    } finally {
      setSpendAlarm(null);
    }
    recordModelSpend(HAIKU, MILLION_OUT);
    expect(raised).toHaveLength(1);
  });
});

describe('CW_SPEND_ALARM_USD', () => {
  const config = (env: Record<string, string>) =>
    resolveServerConfig({
      env: { CW_DATA_DIR: '/nonexistent-data', ...env },
      repoRoot: '/nonexistent-repo',
      arg: (_name: string, fallback?: string) => fallback,
    });

  it('is a positive dollar figure, and unset means no alarm', () => {
    expect(config({ CW_SPEND_ALARM_USD: '25' }).spendAlarmUsd).toBe(25);
    expect(config({}).spendAlarmUsd).toBeUndefined();
  });

  it('stops the boot on a value that is not one, rather than running without the alarm', () => {
    for (const bad of ['twenty', '0', '-5', 'Infinity']) {
      expect(() => config({ CW_SPEND_ALARM_USD: bad })).toThrow('CW_SPEND_ALARM_USD');
    }
  });
});
