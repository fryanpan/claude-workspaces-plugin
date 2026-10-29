/**
 * The pure half of `notes-replay.ts`: a recorded meeting folder turned into a
 * replay plan, the clock the replay runs on, and the five goal verdicts a
 * replay is scored against. Nothing here reads a key or calls a model, so all
 * of it is tested with invented meetings (`notes-replay-lib.test.ts`).
 *
 * WHAT A REPLAY IS. The settled turns a meeting left in its transcript JSONL,
 * fed back through the CURRENT notes pipeline in the order and at the times
 * they settled — never the audio, so nothing is re-transcribed and the words
 * the note-taker reads are exactly the ones it read the first time.
 *
 * THE RECORDING'S LEGS ARE KEPT. A meeting that reconnected twenty times was
 * twenty notes sessions, and every reconnect resets the note-taker's
 * per-session state (`meeting-assistant.md`, "What a reconnect resets"). A
 * replay that ran it as one session would measure a meeting nobody had, so
 * the index's `resumedAt` / `endedAt` lines cut the turns into legs and each
 * leg is a session of its own. `--one-leg` is the control.
 */

import { dollars } from '../packages/core/src/model-cost.ts';
import type { TickScheduler } from '../packages/server/src/pause-ticker.ts';
import type { EngineTurn } from '../packages/server/src/transcribe.ts';

/** One settled turn as the relay writes it. */
export interface TranscriptRow {
  turn: number;
  text: string;
  ts: number;
  speaker?: string;
}

/** One stretch of a meeting during which one socket was open. */
export interface ReplayLeg {
  startAt: number;
  /** Null for a leg the index never saw stop. */
  endAt: number | null;
  /** Index lines that opened this leg (start or resume, gaps, names). */
  openLines: Record<string, unknown>[];
  /** The line that closed it, written when the leg ends. */
  endLine: Record<string, unknown> | null;
  /** Names given during this leg, label → name. */
  names: Record<string, string>;
  turns: TranscriptRow[];
}

export interface ReplayMeeting {
  meetingId: string;
  startedAt: number;
  legs: ReplayLeg[];
}

/** Settled turns, one per turn number (a later line revises an earlier one),
 *  in the order they settled. Lines with no words are relabels and dropped. */
export function parseTranscript(text: string): TranscriptRow[] {
  const byTurn = new Map<number, TranscriptRow>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const { turn, text: words, ts, speaker } = row;
    if (typeof turn !== 'number' || typeof words !== 'string' || typeof ts !== 'number') continue;
    if (words.trim() === '') continue;
    const prior = byTurn.get(turn);
    byTurn.set(turn, {
      turn,
      text: words,
      // A revision keeps the moment the turn first settled.
      ts: prior?.ts ?? ts,
      ...(typeof speaker === 'string' ? { speaker } : {}),
    });
  }
  return [...byTurn.values()].sort((a, b) => a.ts - b.ts || a.turn - b.turn);
}

export function parseJsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v: unknown = JSON.parse(line);
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch {
      // A torn line is skipped, as the server's own index reader does.
    }
  }
  return out;
}

/**
 * Cut every meeting in a doc's index into legs, and its transcript into them.
 * A meeting with no settled turns is dropped: it composed nothing the first
 * time and has nothing to replay.
 */
export function planMeetings(
  index: readonly Record<string, unknown>[],
  transcripts: ReadonlyMap<string, readonly TranscriptRow[]>,
  opts: { oneLeg?: boolean } = {},
): ReplayMeeting[] {
  const meetings = new Map<string, ReplayMeeting>();
  for (const line of index) {
    const id = line.meetingId;
    if (typeof id !== 'string') continue;
    let m = meetings.get(id);
    const opens = typeof line.startedAt === 'number' || typeof line.resumedAt === 'number';
    if (!m) {
      if (typeof line.startedAt !== 'number') continue;
      m = { meetingId: id, startedAt: line.startedAt, legs: [] };
      meetings.set(id, m);
    }
    const open = m.legs[m.legs.length - 1];
    if (opens && !(opts.oneLeg && open)) {
      const at = (line.startedAt ?? line.resumedAt) as number;
      m.legs.push({
        startAt: at,
        endAt: null,
        openLines: [line],
        endLine: null,
        names: {},
        turns: [],
      });
      continue;
    }
    if (!open) continue;
    if (typeof line.endedAt === 'number') {
      open.endAt = line.endedAt;
      open.endLine = line;
      continue;
    }
    const speakers = line.speakers;
    if (speakers && typeof speakers === 'object') {
      for (const [label, name] of Object.entries(speakers as Record<string, unknown>)) {
        if (typeof name === 'string') open.names[label] = name;
      }
    }
    open.openLines.push(line);
  }
  const out: ReplayMeeting[] = [];
  for (const m of meetings.values()) {
    const rows = transcripts.get(m.meetingId) ?? [];
    if (rows.length === 0 || m.legs.length === 0) continue;
    for (const row of rows) {
      // The last leg that had opened by the time the turn settled.
      let leg = m.legs[0] as ReplayLeg;
      for (const l of m.legs) if (l.startAt <= row.ts) leg = l;
      leg.turns.push(row);
    }
    out.push(m);
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** One frame the engine would have emitted, and when. */
export interface ReplayFrame {
  at: number;
  frame: EngineTurn;
  spokenAt?: number;
}

export const PARTIAL_EVERY_MS = 400;
/** Median endpoint lag on the shipped engine setting
 *  (`notes-latency-check.ts`, ENDPOINT_LAG_AFTER_MS). */
export const DEFAULT_ENDPOINT_LAG_MS = 211;

/**
 * The frames one leg's turns imply. A transcript keeps settled turns only, so
 * the partials are MODELLED the way `notes-latency-check.ts --replay` models
 * them: the turn was spoken between the previous turn's end and its own,
 * with a growing prefix every 400ms. Partials matter because they are what
 * defers a pause tick; the words they carry are the turn's own.
 */
export function legFrames(
  turns: readonly TranscriptRow[],
  legStart: number,
  endpointLagMs: number = DEFAULT_ENDPOINT_LAG_MS,
): ReplayFrame[] {
  const frames: ReplayFrame[] = [];
  let previousEnd = legStart;
  for (const t of turns) {
    const words = t.text.trim().split(/\s+/);
    const speechEnd = Math.max(previousEnd, t.ts - endpointLagMs);
    const spokenFor = Math.max(PARTIAL_EVERY_MS, speechEnd - previousEnd);
    const speechStart = speechEnd - spokenFor;
    const speaker = t.speaker !== undefined ? { speaker: t.speaker } : {};
    for (let i = PARTIAL_EVERY_MS; i < spokenFor; i += PARTIAL_EVERY_MS) {
      const upto = Math.max(1, Math.round((words.length * i) / spokenFor));
      frames.push({
        at: speechStart + i,
        spokenAt: speechStart,
        frame: {
          turn: t.turn,
          text: words.slice(0, upto).join(' '),
          final: false,
          ...(upto > 1 ? { settledText: words.slice(0, upto - 1).join(' ') } : {}),
          ...speaker,
        },
      });
    }
    frames.push({
      at: t.ts,
      spokenAt: speechEnd,
      frame: { turn: t.turn, text: t.text, final: true, ...speaker },
    });
    previousEnd = speechEnd;
  }
  return frames.sort((a, b) => a.at - b.at);
}

/**
 * The clock a replay runs on: VIRTUAL while nothing is waiting on a model,
 * REAL while something is.
 *
 * Idle, it jumps straight to the next frame or timer, so an hour of talk
 * between ticks costs nothing. While a compose is in flight it runs at wall
 * speed from where it stood, so the model's real reply time lands on the
 * meeting's timeline — frames due during the call arrive during the call,
 * and a note's settled-to-written wait includes the compose it waited on.
 * That is the one part of a note's latency a stub composer cannot model.
 */
export class ReplayClock implements TickScheduler {
  private frozen: number;
  private live: { vBase: number; wBase: number } | null = null;
  private inflight = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private n = 0;
  private waiters: Array<() => void> = [];

  constructor(
    start: number,
    private readonly wall: () => number = () => performance.now(),
  ) {
    this.frozen = start;
  }

  now(): number {
    return this.live ? this.live.vBase + (this.wall() - this.live.wBase) : this.frozen;
  }

  set(fn: () => void, ms: number): unknown {
    this.n++;
    this.timers.set(this.n, { at: this.now() + ms, fn });
    return this.n;
  }

  clear(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get busy(): boolean {
    return this.inflight > 0;
  }

  /** A model call started: time now flows with the wall. */
  begin(): void {
    if (this.inflight++ === 0) this.live = { vBase: this.frozen, wBase: this.wall() };
  }

  /** A model call ended: time stops where the call left it. */
  finish(): void {
    if (this.inflight === 0) return;
    if (--this.inflight > 0) return;
    this.frozen = this.now();
    this.live = null;
    for (const w of this.waiters.splice(0)) w();
  }

  /** Resolves when no call is in flight. */
  idle(): Promise<void> {
    return this.inflight === 0 ? Promise.resolve() : new Promise((r) => this.waiters.push(r));
  }

  /** Move an idle clock forward; never back, never while live. */
  jumpTo(at: number): void {
    if (!this.live && at > this.frozen) this.frozen = at;
  }

  nextTimerAt(): number {
    let at = Number.POSITIVE_INFINITY;
    for (const t of this.timers.values()) at = Math.min(at, t.at);
    return at;
  }

  /** Run the earliest timer due by now. True if one ran. */
  fireDue(): boolean {
    let due: number | null = null;
    let dueAt = Number.POSITIVE_INFINITY;
    for (const [h, t] of this.timers) {
      if (t.at <= this.now() && t.at < dueAt) {
        due = h;
        dueAt = t.at;
      }
    }
    if (due === null) return false;
    const timer = this.timers.get(due);
    this.timers.delete(due);
    timer?.fn();
    return true;
  }
}

const drain = (): Promise<void> => new Promise((r) => setImmediate(r));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Something that happens at a moment of the replay. */
export interface ReplayEvent {
  at: number;
  run: () => void | Promise<void>;
}

/**
 * Drive events and the session's own timers in time order on `clock`, and
 * return once both are exhausted and no call is in flight. A timer due at the
 * same instant as an event runs first, as a deadline that has passed would.
 * Once the events are spent, timers due after `until` are left unrun.
 */
export async function driveReplay(
  clock: ReplayClock,
  events: readonly ReplayEvent[],
  until: number = Number.POSITIVE_INFINITY,
): Promise<void> {
  let i = 0;
  while (true) {
    const nextEvent = events[i]?.at ?? Number.POSITIVE_INFINITY;
    const nextTimer = clock.nextTimerAt();
    const next = Math.min(nextEvent, nextTimer);
    if (!clock.busy) {
      // A timer past `until` is one nothing in the replay is waiting on.
      if (next === Number.POSITIVE_INFINITY || (i >= events.length && next > until)) return;
      clock.jumpTo(next);
    } else if (clock.now() < next) {
      const wait = next === Number.POSITIVE_INFINITY ? 1_000 : Math.min(1_000, next - clock.now());
      await Promise.race([clock.idle(), sleep(Math.max(1, wait))]);
      continue;
    }
    if (nextTimer <= nextEvent && clock.fireDue()) {
      await drain();
      continue;
    }
    const event = events[i];
    if (event && event.at <= clock.now()) {
      i++;
      await event.run();
      await drain();
    }
  }
}

/* ===== What the run spent ===== */

/** A running dollar total, refused past a cap so a run cannot overspend. */
export class SpendMeter {
  spentUsd = 0;
  calls = 0;
  constructor(readonly capUsd: number) {}
  get over(): boolean {
    return this.spentUsd >= this.capUsd;
  }
  /** Book one reply's `usage` block (the Messages API's field names). */
  book(model: string, usage: Record<string, unknown> | undefined): void {
    const n = (k: string): number => (typeof usage?.[k] === 'number' ? (usage[k] as number) : 0);
    this.calls++;
    this.spentUsd += dollars(
      {
        inputTokens: n('input_tokens'),
        outputTokens: n('output_tokens'),
        cacheReadTokens: n('cache_read_input_tokens'),
        cacheWriteTokens: n('cache_creation_input_tokens'),
      },
      model,
    );
  }
  /**
   * A fetch that books every JSON reply and refuses to send once the cap is
   * reached. A refused call fails its compose, which the pipeline carries;
   * the run then reports that it hit the cap rather than a meeting it did
   * not finish.
   */
  fetch(inner: typeof fetch = fetch): typeof fetch {
    const wrapped = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (this.over) throw new Error(`spend cap $${this.capUsd} reached`);
      const res = await inner(url, init);
      try {
        const body = (await res.clone().json()) as {
          model?: string;
          usage?: Record<string, unknown>;
        };
        if (body.usage) this.book(body.model ?? 'unknown', body.usage);
      } catch {
        // A streamed or non-JSON reply is not booked here.
      }
      return res;
    };
    return wrapped as typeof fetch;
  }
}
