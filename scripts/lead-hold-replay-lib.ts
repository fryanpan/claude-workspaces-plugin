/**
 * The replay behind `scripts/lead-hold-replay.ts`: scripted meeting talk,
 * rendered as the frames a live transcriber sends, played through the lead's
 * line hold (`packages/server/src/lead-chat/lead-line-hold.ts`) on a fake
 * clock, and scored against the script's own label.
 *
 * THE LABEL IS THE SCRIPT'S. Each point is a stretch of talk with one request
 * to speak placed inside it. The right moment to speak is after the last word
 * of the talk, so a line released before that word ends is a cut-in, whatever
 * pause it found. No model decides it, and the denominator (every released
 * line) is the same set of points for every arm.
 *
 * THE FRAMES are the Soniox adapter's shape (`turn`, `text`, `final`), one
 * partial per word at `WORD_MS` a word, and a final `FINAL_LAG_MS` after a
 * segment's last word: meetings run Soniox at level 2, which settled a
 * mid-thought stop in 211ms at the median (end-of-thought survey, 15 turns).
 * Every fourth point loses its punctuation, as a transcriber's output can.
 *
 * THE JUDGE runs in real time against the fake clock: the call is awaited,
 * its measured latency is added to the fake clock as a timer, and words
 * scripted inside that latency cancel it, as they would in a meeting.
 */
import type {
  HoldOutcome,
  LeadLineHoldOpts,
} from '../packages/server/src/lead-chat/lead-line-hold.ts';
import { LeadLineHold } from '../packages/server/src/lead-chat/lead-line-hold.ts';
import type { GateTimers } from '../packages/server/src/spoken-reply/pause-gate.ts';

export const WORD_MS = 280;
export const FINAL_LAG_MS = 200;
/** Silence between a `before` line and the next. */
export const BEFORE_GAP_MS = 700;
/** How long the replay listens past the last word. Over the hold's lapse,
 *  so a line still waiting at the end is one the hold would have dropped. */
export const TAIL_MS = 25_000;

export interface Segment {
  who: string;
  text: string;
  gapAfterMs?: number;
}

export interface Point {
  id: string;
  class: number;
  before?: Array<{ who: string; text: string }>;
  talk: Segment[];
  requestAt: { segment: number; word: number };
}

export interface FixtureSet {
  set: string;
  points: Point[];
}

export interface Frame {
  atMs: number;
  turn: number;
  text: string;
  final: boolean;
  speaker: string;
}

export interface Rendered {
  frames: Frame[];
  requestMs: number;
  /** The end of the talk's last word: the earliest right moment to speak. */
  okFromMs: number;
}

const strip = (s: string): string =>
  s
    .replace(/[.,?!;:…]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Check a fixture's shape; throws naming the first bad point. */
export function checkFixture(f: FixtureSet): void {
  for (const p of f.points) {
    const bad = (why: string) => new Error(`${f.set} ${p.id}: ${why}`);
    if (!Number.isInteger(p.class) || p.class < 1 || p.class > 10) throw bad('class');
    if (!p.talk.length) throw bad('no talk');
    p.talk.forEach((s, i) => {
      if (i < p.talk.length - 1 && typeof s.gapAfterMs !== 'number') throw bad(`gap ${i}`);
    });
    const seg = p.talk[p.requestAt.segment];
    if (!seg) throw bad('request segment');
    if (p.requestAt.word >= seg.text.split(/\s+/).length) throw bad('request word');
  }
}

export function render(p: Point, index: number): Rendered {
  const plain = index % 4 === 3;
  const frames: Frame[] = [];
  let t = 0;
  let turn = 0;
  let requestMs = 0;
  let okFromMs = 0;
  const say = (who: string, text: string, gap: number, isTalk: number | null) => {
    const words = (plain ? strip(text) : text).split(/\s+/).filter(Boolean);
    for (let w = 0; w < words.length; w++) {
      t += WORD_MS;
      frames.push({
        atMs: t,
        turn,
        text: words.slice(0, w + 1).join(' '),
        final: false,
        speaker: who,
      });
      if (isTalk === p.requestAt.segment && w === p.requestAt.word) requestMs = t;
    }
    frames.push({
      atMs: t + FINAL_LAG_MS,
      turn,
      text: words.join(' '),
      final: true,
      speaker: who,
    });
    okFromMs = t;
    turn += 1;
    t += gap;
  };
  for (const b of p.before ?? []) say(b.who, b.text, BEFORE_GAP_MS, null);
  p.talk.forEach((s, i) => say(s.who, s.text, s.gapAfterMs ?? 0, i));
  frames.sort((a, b) => a.atMs - b.atMs);
  return { frames, requestMs, okFromMs };
}

/** What the replay asks the judge: a verdict and how long it took. */
export type ReplayJudge = (recent: string) => Promise<{ finished: boolean; latencyMs: number }>;

export interface PointResult {
  id: string;
  class: number;
  outcome: 'cut' | 'ok' | 'unsaid';
  /** From the end of the talk to the release; for `ok` only. */
  waitMs?: number;
  /** From the request to the release. */
  heldMs?: number;
  judged: number;
}

/** A fake clock whose timers fire one at a time, so a judge called inside
 *  one can be resolved before the next. */
function stepClock() {
  let now = 0;
  let next = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: GateTimers = {
    set: (fn, ms) => {
      const id = ++next;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (h) => void due.delete(h as number),
  };
  /** Fire the earliest timer due at or before `t`; false when none is. */
  const fireOne = (t: number): boolean => {
    const first = [...due.entries()]
      .filter(([, d]) => d.at <= t)
      .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    if (!first) return false;
    due.delete(first[0]);
    now = first[1].at;
    first[1].fn();
    return true;
  };
  return {
    timers,
    now: () => now,
    fireOne,
    set: (t: number) => {
      now = t;
    },
  };
}

export type ArmOpts = Omit<LeadLineHoldOpts, 'now' | 'timers' | 'judge'> & { judged?: boolean };

export async function replayPoint(
  p: Point,
  index: number,
  arm: ArmOpts,
  judge: ReplayJudge | null,
): Promise<PointResult> {
  const r = render(p, index);
  const clock = stepClock();
  const pending: Array<{ recent: string; done: (f: boolean) => void; cancelled: boolean }> = [];
  const hold = new LeadLineHold({
    ...arm,
    now: clock.now,
    timers: clock.timers,
    judge:
      arm.judged && judge
        ? (recent, done) => {
            const call = { recent, done, cancelled: false };
            pending.push(call);
            return () => {
              call.cancelled = true;
            };
          }
        : null,
  });
  let outcome: HoldOutcome | null = null;
  let releasedAt = 0;
  const drain = async () => {
    while (pending.length) {
      const call = pending.shift();
      if (!call || call.cancelled || !judge) continue;
      const v = await judge(call.recent);
      clock.timers.set(() => {
        if (!call.cancelled) call.done(v.finished);
      }, v.latencyMs);
    }
  };
  const runTo = async (t: number) => {
    await drain();
    while (clock.fireOne(t)) await drain();
    clock.set(t);
  };
  const events: Array<{ atMs: number; act: () => void }> = r.frames.map((f) => ({
    atMs: f.atMs,
    act: () => hold.heard({ turn: f.turn, text: f.text, final: f.final, speaker: f.speaker }),
  }));
  // The request lands just after the word it is placed on is heard.
  const reqIdx = events.findIndex((e) => e.atMs > r.requestMs);
  events.splice(reqIdx < 0 ? events.length : reqIdx, 0, {
    atMs: r.requestMs,
    act: () =>
      hold.request((o) => {
        outcome = o;
        releasedAt = clock.now();
      }),
  });
  for (const e of events) {
    if (outcome) break;
    await runTo(e.atMs);
    if (outcome) break;
    e.act();
    await drain();
  }
  if (!outcome) await runTo(r.okFromMs + TAIL_MS);
  hold.end();
  const o = outcome as HoldOutcome | null;
  if (!o || !o.said) return { id: p.id, class: p.class, outcome: 'unsaid', judged: 0 };
  const base = { id: p.id, class: p.class, heldMs: releasedAt - r.requestMs, judged: o.judged };
  return releasedAt < r.okFromMs
    ? { ...base, outcome: 'cut' }
    : { ...base, outcome: 'ok', waitMs: releasedAt - r.okFromMs };
}

export interface ArmScore {
  requests: number;
  released: number;
  cuts: number;
  unsaid: number;
  medianWaitMs: number | null;
  p90WaitMs: number | null;
  judgeCalls: number;
  byClass: Record<number, { released: number; cuts: number; unsaid: number }>;
}

function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] ?? null;
}

export function score(results: PointResult[]): ArmScore {
  const byClass: ArmScore['byClass'] = {};
  for (const r of results) {
    const c = (byClass[r.class] ??= { released: 0, cuts: 0, unsaid: 0 });
    if (r.outcome === 'unsaid') c.unsaid += 1;
    else c.released += 1;
    if (r.outcome === 'cut') c.cuts += 1;
  }
  const waits = results.flatMap((r) => (r.waitMs === undefined ? [] : [r.waitMs]));
  return {
    requests: results.length,
    released: results.filter((r) => r.outcome !== 'unsaid').length,
    cuts: results.filter((r) => r.outcome === 'cut').length,
    unsaid: results.filter((r) => r.outcome === 'unsaid').length,
    medianWaitMs: quantile(waits, 0.5),
    p90WaitMs: quantile(waits, 0.9),
    judgeCalls: results.reduce((n, r) => n + r.judged, 0),
    byClass,
  };
}

/**
 * The bar the survey set, on the held-out set: at most 5 cut-ins per 100
 * released lines and at most half the gate's rate; no class over 20%; a
 * median wait of at most 2s and a p90 of at most 4s; at most 10% unsaid.
 * Returns the clauses that fail, empty when it is met.
 */
export function failsBar(s: ArmScore, gate: ArmScore | null): string[] {
  const out: string[] = [];
  const rate = s.released ? s.cuts / s.released : 0;
  if (rate > 0.05) out.push(`cut share ${s.cuts}/${s.released} over 5%`);
  if (gate?.released && rate > gate.cuts / gate.released / 2) out.push('not half the gate’s rate');
  for (const [c, v] of Object.entries(s.byClass)) {
    if (v.released && v.cuts / v.released > 0.2) out.push(`class ${c} ${v.cuts}/${v.released}`);
  }
  if ((s.medianWaitMs ?? 0) > 2000) out.push(`median wait ${s.medianWaitMs}ms`);
  if ((s.p90WaitMs ?? 0) > 4000) out.push(`p90 wait ${s.p90WaitMs}ms`);
  if (s.unsaid / s.requests > 0.1) out.push(`unsaid ${s.unsaid}/${s.requests}`);
  return out;
}
