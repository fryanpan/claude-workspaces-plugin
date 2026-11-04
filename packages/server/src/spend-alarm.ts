/**
 * A board server says so the day its own Claude calls cost more than a set
 * figure.
 *
 * Security review L3: every board server spends one shared Anthropic key, so
 * a break-in on one server spends for every org, and nothing would say which.
 * Each project server is one org, so a sum kept by the server itself is that
 * org's spend. It is summed from the usage rows the calls already record
 * (`NotesCallUsage`, priced by core's `model-cost.ts`, the same table the
 * meeting bill uses), per UTC day, and the call that takes the day past
 * `CW_SPEND_ALARM_USD` raises one warning. A server restart forgets the day's
 * sum, so a restart can delay the alarm; it cannot raise a false one.
 *
 * What it counts is what records a usage row today: the meeting compose and
 * capture calls, which are where the money goes. A call path that records no
 * row is not counted.
 *
 * Nothing here reads the network or a file. It is a sum and a clock, driven
 * directly by `spend-alarm.test.ts`.
 */
import { type TokenUsage, dollars, isPricedModel } from '@claude-workspaces/core';

export interface SpendAlarmOptions {
  /** Dollars per UTC day; the call that reaches it raises. */
  thresholdUsd: number;
  /** Where the warning goes: the server's Sentry client in production. */
  raise: (message: string, extra: Record<string, string>) => void;
  now?: () => number;
}

/** `YYYY-MM-DD` of `ms`, in UTC. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class SpendAlarm {
  private day = '';
  private usd = 0;
  private raised = false;
  private unpriced = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly opts: SpendAlarmOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** One model call's usage, as the API reported it. */
  record(model: string, usage: TokenUsage): void {
    const day = utcDay(this.now());
    if (day !== this.day) {
      this.day = day;
      this.usd = 0;
      this.raised = false;
      this.unpriced.clear();
    }
    if (!isPricedModel(model)) this.unpriced.add(model);
    this.usd += dollars(usage, model);
    if (this.raised || this.usd < this.opts.thresholdUsd) return;
    this.raised = true;
    this.opts.raise(`Claude spend on this server is over $${this.opts.thresholdUsd} today (UTC)`, {
      day,
      spentUsd: this.usd.toFixed(2),
      thresholdUsd: String(this.opts.thresholdUsd),
      ...(this.unpriced.size ? { unpricedModels: [...this.unpriced].join(', ') } : {}),
    });
  }
}

/** The server's alarm, set at boot when a threshold is configured. */
let active: SpendAlarm | null = null;

export function setSpendAlarm(alarm: SpendAlarm | null): void {
  active = alarm;
}

/** Record one call into the server's alarm; nothing when none is set. */
export function recordModelSpend(model: string, usage: TokenUsage): void {
  active?.record(model, usage);
}
