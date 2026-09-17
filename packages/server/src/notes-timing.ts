import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
import type { TokenUsage } from '@claude-workspaces/core';
import type { ClaudeKeySlot } from './claude-key-slot.ts';

/** Why the tick fired, as the ticker reported it. */
export type NotesTimingReason = 'pause' | 'cadence' | 'end';

/**
 * One edit the doc would not take where it was addressed.
 *
 * `recovered` is the difference between a note that is somewhere in the doc
 * and one that is nowhere: the address repair re-homes a failed note under
 * this meeting's own section (`notes-edit-address.ts`), so its words ARE in
 * the notes — under the section rather than under its topic, and for a
 * rewrite, BESIDE the wording it was meant to replace rather than over it. A
 * move or a removal carries no words, so nothing can be re-homed and the edit
 * simply did not happen.
 */
export interface NotesDroppedEdit {
  /** The edit's op, as `prose.BlockEdit` names it. */
  op: string;
  /** The applier's verdict — `unknown-block`, `not-a-heading`, `empty`, … */
  why: string;
  /** Whether the words it carried were re-homed into the notes anyway. */
  recovered: boolean;
}

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
   * WHY THIS TICK READ WHAT IT READ — the shape of the prefix it offered the
   * cache, which the four token counts above cannot say.
   *
   * `cacheStableBlocks` is the one to read first: 0 says the first cached
   * block's own text moved since the last tick, so there was nothing to read
   * whatever the tokens say; a number above 0 says the head repeated and a
   * zero read is the model's minimum cacheable prefix (or the entry's life),
   * not the prompt. `cacheFirstBlockChars` is what that minimum is judged
   * against — the first breakpoint has to clear it on its own.
   *
   * Null on a tick that reached no model, and on a composer that sends no
   * breakpoints. `cacheStableBlocks` is ALSO null on a meeting's first tick,
   * where there is no previous prompt to have repeated.
   */
  cacheBlocks: number | null;
  cacheFirstBlockChars: number | null;
  cacheStableBlocks: number | null;
  /**
   * EVERY MODEL CALL THIS TICK MADE, compose and capture alike, each with the
   * model that billed it.
   *
   * The four flat fields above are the COMPOSE call and only ever were, which
   * is how the capture pass came to be invisible on a bill it was adding a
   * dollar an hour to. They stay because the timing file has readers that
   * know that shape; this is the one a total is summed over, and a tick that
   * made no priced call carries an empty array rather than a zero.
   */
  calls: readonly NotesCallUsage[];
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
  /**
   * EVERY EDIT THIS TICK COMPOSED THAT THE DOC DID NOT TAKE WHERE IT WAS
   * ADDRESSED — one entry per failed edit, and an empty list when the batch
   * landed whole.
   *
   * WHY THE ROW CARRIES IT. `outcome` is the tick's verdict, and a tick that
   * wrote four notes and dropped a fifth reads `written`, exactly as one that
   * wrote all five does. The fifth was usually a CORRECTION — a rewrite or a
   * removal of a bullet the note-taker had already written — and those are
   * the edits a stale address costs, because they are the only ones that name
   * a block at all. Dropped with no row, the doc keeps the wording the
   * note-taker decided was wrong and the meeting's own record says the tick
   * was fine. So: either the correction is in the notes, or this list says it
   * is not and why.
   *
   * COUNTS AND VERDICTS, NEVER WORDS — the same rule as every other field in
   * this file. `op` is the edit's own name and `why` the applier's error
   * code; the words are in the transcript beside this file.
   *
   * It is the APPLIER's verdicts. A batch the edit guard or the dedupe pass
   * emptied never reached the applier; those refusals are named on the
   * `[meeting-notes]` log lines `notes-edit-guard.ts` and
   * `notes-edit-dedupe.ts` write, and the tick's own `outcome` carries the
   * `guard-refused` case.
   */
  dropped: readonly NotesDroppedEdit[];
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
export type NotesTokenUsage = TokenUsage;

/**
 * WHICH CALL A TICK MADE. A tick is not one model call: the capture pass runs
 * first and the compose runs after it, on the same words, and the two are
 * billed separately.
 *
 * Named rather than counted, because the two answer different questions. The
 * compose is what the notes cost; the capture is what listening for asks
 * costs, and it is the one a person might reasonably turn off
 * (`CW_MEETING_TASKS=0`). A meeting total that cannot be split into the two
 * cannot answer "what would turning capture off save".
 */
export type NotesCallKind = 'compose' | 'capture';

/**
 * One model call a tick made, as the API itself reported it.
 *
 * THE MODEL IS PART OF THE RECORD, not a lookup against whatever the server
 * composes with today. A meeting composed on Haiku and captured on Haiku
 * still costs what those calls cost at the time, and a tick recorded before a
 * model change must not be re-priced by the change.
 */
export interface NotesCallUsage {
  call: NotesCallKind;
  model: string;
  usage: NotesTokenUsage;
  /**
   * WHICH CONFIGURED SLOT PAID FOR THIS CALL — the Keychain item or the
   * environment variable, and the role it holds, as the RUN resolved them.
   *
   * Never the key, never a prefix of it and never a hash of it: a slot is
   * configuration that is already written down in this repo in plain text,
   * and anything derived from the value would let somebody look the value up
   * again. The point of the field is that "eval spend landed on the prod
   * bill" becomes a question a stored row answers, rather than one that has
   * to be re-argued from config every time it is asked.
   *
   * Null on a call whose adapter reported no slot — a stub composer in a
   * harness, and any recorded call made before this field existed.
   */
  keySlot: ClaudeKeySlot | null;
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
  /** The slot this composer resolved. Absent on a composer that spends
   *  nothing — the stub the replay harness uses. */
  keySlot?: ClaudeKeySlot;
  /**
   * The shape of the cacheable prefix this call sent — see
   * `notes-prompt-cache-shape.ts` for what each number separates. Absent on a
   * composer that sends no cache breakpoints, which is every stub.
   */
  cacheBlocks?: number;
  cacheFirstBlockChars?: number;
  cacheStableBlocks?: number | null;
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
      // THE EDITS THAT NEVER LANDED WHERE THEY WERE AIMED, over the whole
      // meeting. Counted apart from `failed`, which is ticks: the case this
      // exists for is a tick that wrote its notes and dropped its correction,
      // and that tick is not a failure by any other number here.
      const dropped = rows.reduce((n, r) => n + r.dropped.length, 0);
      const lost = rows.reduce((n, r) => n + r.dropped.filter((d) => !d.recovered).length, 0);
      const line =
        `[notes-timing] ${rows.length} tick(s): settled-to-written median ` +
        `${Math.round(mid)}ms, worst ${Math.round(worst)}ms` +
        (spokenMid !== null
          ? `; spoken-to-written median ${Math.round(spokenMid)}ms, worst ` +
            `${Math.round(spokenWorst ?? 0)}ms over ${spoken.length} tick(s)`
          : '') +
        (failed > 0 ? `, ${failed} write(s) skipped` : '') +
        (dropped > 0
          ? `, ${dropped} edit(s) the doc would not take where they were addressed ` +
            `(${lost} whose words are nowhere in the notes)`
          : '');
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
          droppedEdits: dropped,
          lostEdits: lost,
        }),
      );
      return line;
    },
  };
}
