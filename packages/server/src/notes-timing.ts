/**
 * WHERE A NOTE'S MINUTE WENT.
 *
 * The notes lagged the room by about a minute against what was then a
 * fifteen-second ceiling (six today), and the only numbers anybody had were a mean tick interval and a
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
 * IT IS WRITTEN FOR EVERY MEETING, not only when somebody asks. It was
 * opt-in at first, which made it useless to anything downstream: the at-stop
 * quality report scores how late the notes landed from these rows, and a
 * file that exists only when an operator remembered a flag is a file that
 * reader can never rely on. `CW_NOTES_TIMING=0` turns it off.
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
  /**
   * Epoch ms at which the OLDEST words in this tick were SPOKEN, and at which
   * the newest of them stopped being spoken.
   *
   * WHY THE FILE NEEDED A SECOND CLOCK. `settledAt` is when the pipeline
   * first heard the words — the engine's frame arriving on the socket. Every
   * number derived from it therefore starts AFTER endpointing and
   * transcription have already run, which is why this file could report a
   * seventeen-second median while the wait a person feels was longer and
   * nothing here could say by how much. These two are read off the audio's
   * own clock: `EngineTurn.audioEndMs` is the offset of the last word in a
   * frame, and the relay knows which chunk of audio carried that offset and
   * when that chunk arrived, so the instant a word was said is arithmetic.
   *
   * `spokenAt - settledAt` is the endpointing-and-transcription leg, which
   * had never been measured in a live meeting at all.
   *
   * Null on an engine that reports no word offsets (the mock), on a word
   * whose chunk has fallen out of the relay's ring, and in every harness that
   * drives the notes session without a relay in front of it. Null is the
   * honest answer, never zero.
   *
   * WHAT THEY DO NOT COUNT: the browser's own capture framing and the uplink
   * to this server, because the instant is read from when the audio ARRIVED
   * here. `scripts/word-latency-check.ts` prices those two legs; on this
   * machine they are tens of milliseconds against a wait measured in seconds.
   */
  spokenAt: number | null;
  lastSpokenAt: number | null;
  /** Epoch ms at which the tick fired. */
  startedAt: number;
  /** How long this tick sat behind the previous one before composing. */
  waitedMs: number;
  /** Characters of prompt sent, and of reply read back. Null: no LLM. */
  promptChars: number | null;
  replyChars: number | null;
  /**
   * What the API says this call cost, in tokens. Null on a tick that never
   * reached a model, and on a composer that reports no usage.
   *
   * Kept as four numbers rather than one total because the four are billed at
   * four different rates, and the whole point of reading them is to price a
   * meeting-hour without multiplying a character count by a fudge factor.
   */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
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
  /**
   * THE NUMBER A PERSON FEELS: from the last word of this tick's newest
   * speech to that speech being in the doc.
   *
   * This is the wait the board's ten-second goal is about — "I stopped
   * talking; when do I see it" — and it is the newest words rather than the
   * oldest because that is the sentence the speaker is watching for. The
   * oldest words' version of the same wait is `spokenToWrittenMs`; it is the
   * larger of the two and it is what a tick that coalesced several ticks'
   * speech costs the person who spoke first.
   */
  spokenToWrittenMs: number | null;
  lastSpokenToWrittenMs: number | null;
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

/**
 * What a compose costs, as the API itself reported it.
 *
 * CHARACTERS WERE NEVER THE BILL. `promptChars` is what the composer knew
 * before it sent anything, and it is still recorded because it is the only
 * number a tick that never reached the API can report — but it cannot say
 * what was charged, and once part of a prompt is served from cache at a tenth
 * of the price it cannot even say the ratio. These four come off
 * `response.usage`, so "what did a meeting-hour cost" is arithmetic over a
 * measured quantity rather than a guess with a divisor in it.
 *
 * `cacheReadTokens` is also the only honest answer to "is the cache working".
 * A `cache_control` marker on a prompt below the model's minimum cacheable
 * size is silently ignored — no error, no entry — so a layout that caches
 * nothing looks exactly like one that caches everything until this is read
 * back.
 */
export interface NotesTokenUsage {
  /** Fresh input tokens, billed at the full rate. */
  inputTokens: number;
  outputTokens: number;
  /** Served from an existing cache entry, billed at a tenth. */
  cacheReadTokens: number;
  /** Written into a new cache entry, billed at 1.25x. */
  cacheWriteTokens: number;
}

/** What the composer may report about one compose, if it knows. */
export interface NotesComposeMeasure {
  promptChars?: number;
  replyChars?: number;
  firstTokenMs?: number;
  model?: string;
  /** Absent on a compose that never reached the API, and on one whose reply
   *  carried no usage block. */
  usage?: NotesTokenUsage;
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
      // The wait a PERSON felt, when the audio clock reached this meeting.
      // Reported beside the older number rather than instead of it: they
      // measure different starts, and a meeting whose engine reports no word
      // offsets still has the older one.
      const spoken = rows
        .map((r) => r.lastSpokenToWrittenMs)
        .filter((v): v is number => v !== null);
      const spokenMid = spoken.length > 0 ? (median(spoken) ?? 0) : null;
      const spokenWorst = spoken.length > 0 ? Math.max(...spoken) : null;
      const failed = rows.filter((r) => r.outcome === 'failed').length;
      const line =
        `[notes-timing] ${rows.length} tick(s): settled-to-written median ` +
        `${Math.round(mid)}ms, worst ${Math.round(worst)}ms` +
        (spokenMid !== null
          ? `; spoken-to-written median ${Math.round(spokenMid)}ms, worst ` +
            `${Math.round(spokenWorst ?? 0)}ms over ${spoken.length} tick(s)`
          : '') +
        (failed > 0 ? `, ${failed} write(s) skipped` : '');
      append(
        JSON.stringify({
          summary: true,
          ticks: rows.length,
          medianMs: mid,
          worstMs: worst,
          spokenMedianMs: spokenMid,
          spokenWorstMs: spokenWorst,
          spokenTicks: spoken.length,
          failed,
        }),
      );
      return line;
    },
  };
}
