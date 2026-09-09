/**
 * WHERE A NOTE'S MINUTE WENT.
 *
 * The notes lagged the room by about a minute against a fifteen-second
 * ceiling, and the only numbers anybody had were a mean tick interval and a
 * synthetic replay that said nine seconds. Neither can name the half of the
 * pipeline at fault, because they measure the gap between TICKS — and a tick
 * is the middle of the story. The number Bryan feels is the one this file
 * writes down: from the moment he finished a sentence to the moment its note
 * is in the doc.
 *
 * One line per tick, JSONL, beside the meeting's transcript. Every line
 * carries the whole chain — when the words settled, when the tick fired and
 * why, how long it waited behind the tick before it, what the compose cost,
 * and what the write cost — so a slow meeting can be read back without
 * re-running it. It also names the hypothesis its shape settles, because a
 * file of timings nobody can interpret is a file nobody opens twice.
 *
 * NOTHING IN HERE IS MEETING CONTENT. Sizes and counts only: no words, no
 * speaker labels, no prompt text. The transcript beside it is the record of
 * what was said, and it is already as private as the meeting was; a second
 * file repeating it in a different shape would be a second thing to protect.
 */
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Why the tick fired, as the ticker reported it. */
export type NotesTimingReason = 'pause' | 'cadence' | 'end';

/** How the tick ended: the note reached the doc, or it did not. */
export type NotesTimingOutcome = 'written' | 'failed' | 'empty';

/**
 * One tick, end to end. Every duration is milliseconds; `null` means the
 * pipeline genuinely does not know, never zero.
 */
export interface NotesTickTiming {
  tick: number;
  reason: NotesTimingReason;
  /**
   * The turn numbers this tick carried, in the order the compose saw them —
   * carried words from a failed earlier tick first. Turn numbers, never
   * words: they index the transcript beside this file, which is where the
   * words already are, so a reader that wants both can join on them.
   */
  turns: readonly number[];
  /** Epoch ms at which the OLDEST words in this tick stopped changing. */
  settledAt: number | null;
  /** Epoch ms at which the tick fired. */
  startedAt: number;
  /** How long this tick sat behind the previous one before composing. */
  waitedMs: number;
  /** Characters of prompt sent, and of reply read back. Null: no LLM. */
  promptChars: number | null;
  replyChars: number | null;
  /**
   * Time to the first token of the reply. Null on a composer that does not
   * stream — today's does not, so this reads null in every live meeting and
   * `composeMs` is the whole request.
   */
  firstTokenMs: number | null;
  /** The compose call, first byte of request to parsed edit list. */
  composeMs: number;
  model: string | null;
  /** Applying the edits to the doc. */
  applyMs: number;
  edits: number;
  /** Distinct blocks the edits addressed. */
  blocks: number;
  /** How many ticks' words this one carried, when ticks coalesced. */
  merged: number;
  outcome: NotesTimingOutcome;
  /** THE NUMBER: settling to in-the-doc. Null when nothing settled. */
  settledToWrittenMs: number | null;
}

/**
 * Which hypothesis this line's shape is evidence about.
 *
 * A timing file is only useful if a reader can tell which of the five
 * failures they are looking at, and the tick itself knows: a ceiling tick
 * carrying words that had not settled is H1 doing its job; a pause tick that
 * fired on the endpoint window is H2; a tick that carried more than one
 * tick's words is H3; a failed write is H4; and a tick whose words waited
 * behind another tick is H5's cost.
 */
export function hypothesisFor(t: NotesTickTiming): string {
  if (t.outcome === 'failed') return 'H4 doc write skipped';

  if (t.merged > 1) return 'H3 ticks coalesced';
  if (t.reason === 'cadence') return 'H1 ceiling armed on a word';
  if (t.reason === 'pause') return 'H2 endpoint became a pause';
  if (t.waitedMs > 0) return 'H5 waited behind the previous tick';
  return 'H1 ceiling armed on a word';
}

/** The middle value, taking the upper of two for an even count. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/** What the composer may report about one compose, if it knows. */
export interface NotesComposeMeasure {
  promptChars?: number;
  replyChars?: number;
  firstTokenMs?: number;
  model?: string;
}

/** Where a composer reports what its call cost. Never given the words. */
export type NotesComposeMeasureSink = (m: NotesComposeMeasure) => void;

export interface NotesTimingLog {
  /** Write one tick's line. */
  record(t: NotesTickTiming): void;
  /**
   * One line naming the median and the worst settled-to-written of the
   * meeting, plus how many ticks never got there. Returns null when no tick
   * produced a latency to report — an empty meeting has no verdict.
   */
  summary(): string | null;
  /** Every line recorded, for a caller measuring rather than logging. */
  rows(): readonly NotesTickTiming[];
}

export interface NotesTimingLogOpts {
  /**
   * The JSONL file to append to. Absent keeps every row in memory only —
   * which is what the replay harness and the tests want, and what a server
   * with timing off does not pay for at all.
   */
  path?: string;
  /** Where a write failure is reported. Defaults to the console. */
  onError?: (message: string) => void;
}

/**
 * Open a timing log. Appending is best-effort by design: a meeting must not
 * lose a note because its instrumentation could not write.
 */
export function createNotesTimingLog(opts: NotesTimingLogOpts = {}): NotesTimingLog {
  const rows: NotesTickTiming[] = [];
  const onError = opts.onError ?? ((m: string) => console.error(m));
  let dirReady = false;

  const append = (line: string): void => {
    const path = opts.path;
    if (path === undefined) return;
    try {
      if (!dirReady) {
        mkdirSync(dirname(path), { recursive: true });
        dirReady = true;
      }
      appendFileSync(path, `${line}\n`);
    } catch (err) {
      onError(`[notes-timing] could not write ${path}: ${String(err)}`);
    }
  };

  return {
    record(t: NotesTickTiming): void {
      rows.push(t);
      append(JSON.stringify({ ...t, hypothesis: hypothesisFor(t) }));
    },
    rows: () => rows,
    summary(): string | null {
      const latencies = rows
        .map((r) => r.settledToWrittenMs)
        .filter((v): v is number => v !== null);
      if (latencies.length === 0) return null;
      const worst = Math.max(...latencies);
      const mid = median(latencies) ?? 0;
      const failed = rows.filter((r) => r.outcome === 'failed').length;
      const line =
        `[notes-timing] ${rows.length} tick(s): settled-to-written median ` +
        `${Math.round(mid)}ms, worst ${Math.round(worst)}ms` +
        (failed > 0 ? `, ${failed} write(s) skipped` : '');
      append(
        JSON.stringify({
          summary: true,
          ticks: rows.length,
          medianMs: mid,
          worstMs: worst,
          failed,
        }),
      );
      return line;
    },
  };
}
