/**
 * The three-clock detector: when is a "notes moment"?
 *
 * A pause, the cadence ceiling, or the meeting ending. Read
 * [meeting-assistant.md](../../../docs/architecture/meeting-assistant.md)
 * before changing any of the numbers: they were set against measured runs of
 * `scripts/notes-latency-check.ts`, and a tick is two model calls.
 *
 * It knows nothing about notes, docs or models — turns in, ticks out, and
 * every timer through an injectable seam so a test asserts a sequence rather
 * than waiting out real quiet.
 *
 * WHAT A PAUSE IS, AND WHY THERE ARE TWO WAYS TO SEE ONE. The engines behind
 * this seam run their own endpoint detectors, and a settled turn IS that
 * detector saying the speaker stopped — measured at about 200ms after the
 * last word (`scripts/endpoint-latency-check.ts`). Waiting a further four
 * seconds of wall clock to agree with it added four seconds to every note in
 * a meeting with ordinary gaps in it. So a settled turn arms a SHORT confirm
 * window instead: quiet for `endpointConfirmMs` after an endpoint is a pause,
 * because the engine already said so and nothing has contradicted it. The
 * four-second quiet clock survives as the fallback — it is what covers a
 * stream of partials that never endpoints, and it is what runs on an engine
 * whose detector is wrong or absent.
 *
 * WHY THERE IS A CEILING AT ALL (owner, 2026-08-30: "waits too long to update
 * notes"). Every frame replaces the quiet countdown, so a conversation where
 * nobody stops never fires a pause tick — and the meeting that most needs
 * notes, the one where people talk without a break, produced nothing until it
 * ended. The ceiling is not reset by speech, so no unwritten speech waits
 * longer than `cadenceMs` to reach the doc.
 *
 * WHY THE CEILING ARMS ON THE FIRST UNWRITTEN WORD AND NOT THE FIRST SETTLED
 * TURN. It used to arm only when a turn settled, which made the ceiling
 * unreachable in exactly the case it exists for: a turn is one person talking
 * until they stop, somebody making an argument talks for a minute, and for
 * that minute there was no settled turn to start the clock. The ceiling
 * measured the wait of sentences that had ALREADY finished rather than the
 * wait of the words a person was actually waiting to see. A word is now
 * enough to start it.
 *
 * WHAT A CEILING TICK CARRIES WHEN NOTHING HAS SETTLED. The engine's own
 * already-final tokens of the turn in progress (`EngineTurn.settledText`):
 * words the engine will not revise, inside a sentence it has not finished.
 * They are unformatted, so they ride the tick flagged `partial` exactly as
 * the end tick's tail does — the composer is told it is holding mid-sentence
 * words rather than left to read them as finished speech. The ticker
 * remembers how many words of a turn it has handed out this way, and when
 * that turn finally settles it emits only what is left, marked `continued`.
 * Without that bookkeeping every carried word would reach the notes twice.
 *
 * THE END TICK IS THE ONE THAT CARRIES UNSETTLED WORDS WHOLE. Every other
 * tick takes settled turns and engine-final prefixes; at `end()` there is no
 * next tick, so the ticker hands over the latest partial of every turn it
 * has not seen settle — minus whatever a ceiling tick already carried.
 */

import type { NotesTurn } from './meeting-notes.ts';
import type { EngineTurn } from './transcribe.ts';

/**
 * Why a tick fired: the speaker went quiet, the cadence ceiling was reached
 * while they kept talking, or the meeting ended.
 */
export type NotesTickReason = 'pause' | 'cadence' | 'end';

/** One "notes moment": the new settled words since the previous tick. */
export interface NotesTick {
  /** 1-based, per meeting. */
  tick: number;
  reason: NotesTickReason;
  /**
   * Settled turns since the previous tick, in the order they settled — plus
   * the mid-sentence words a ceiling or end tick carries, each flagged
   * `partial` and ordered after the settled ones by turn number.
   */
  turns: NotesTurn[];
}

/**
 * The timer seam. Injectable for the same reason the mock engine advances
 * per chunk: a test asserts a sequence, never waits out real quiet.
 */
export interface TickScheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTickScheduler: TickScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Long enough that a breath between sentences is not a pause, short enough
 * that notes land while the topic is still the topic.
 *
 * THE FALLBACK CLOCK, not the usual one. On an engine with an endpoint
 * detector the confirm window below is what fires the pause; this covers the
 * stream of partials that never endpoints at all.
 */
export const DEFAULT_NOTES_QUIET_MS = 4_000;

/**
 * How long a settled turn must stand unanswered before the endpoint that
 * produced it counts as a pause.
 *
 * The engine has already decided the speaker stopped — this is only long
 * enough for the next speaker to start, so a handover inside a conversation
 * is not read as the end of the exchange. Measured endpoint lag on the
 * default engine is ~200ms (`scripts/endpoint-latency-check.ts`), so a
 * second is comfortably more than the detector's own jitter and four times
 * less than the clock it replaces.
 */
export const DEFAULT_NOTES_ENDPOINT_CONFIRM_MS = 1_000;

/**
 * The longest any unwritten speech may wait for a note, however continuously
 * people are talking. Long enough that a tick still covers a stretch of
 * conversation worth summarizing rather than one sentence at a time — and
 * short enough that the notes read as keeping up rather than catching up
 * (owner's number, 2026-08-30: "about 15 seconds").
 *
 * Unlike `DEFAULT_NOTES_QUIET_MS` this is a CEILING, not a threshold: a pause
 * still fires sooner whenever it comes.
 */
export const DEFAULT_NOTES_CADENCE_MS = 15_000;

export interface PauseTickerOpts {
  /** How long the transcript stream must be quiet before a tick fires, when
   *  no endpoint has been seen. */
  quietMs: number;
  /**
   * The ceiling on how long unwritten speech waits, measured from the first
   * word of it rather than from the last frame. Omitted or non-finite means
   * no ceiling — pause ticks only, which is what every meeting did before
   * this clock existed.
   */
  cadenceMs?: number;
  /**
   * How long an engine endpoint stands unanswered before it is a pause.
   * Defaults to {@link DEFAULT_NOTES_ENDPOINT_CONFIRM_MS}; non-finite or
   * zero turns the short window off and leaves `quietMs` as the only pause
   * clock, which is what this ticker did before the window existed.
   */
  endpointConfirmMs?: number;
  onTick: (tick: NotesTick) => void;
  /**
   * A settled turn the engine has changed its mind about AFTER its words
   * already went out in a tick.
   *
   * The ticker itself can do nothing with one — its delta is gone — so it
   * hands it up. Words still WAITING on a tick are patched in place below
   * and never reach here: they compose under the new label on their own,
   * which is not a correction, just the right answer arriving in time.
   */
  onRevised?: (revision: { turn: number; speaker?: string }) => void;
  schedule?: TickScheduler;
}

export interface PauseTicker {
  /** Every transcript frame, partials included — a partial defers the tick. */
  onTurn(turn: EngineTurn): void;
  /**
   * The meeting ended: flush any tail delta as a final `end` tick, including
   * whatever was still being said. Nothing is scheduled afterwards, so this
   * is the last chance the words have.
   */
  end(): void;
}

/**
 * The words of a phrase, as the carry bookkeeping counts them.
 *
 * A COUNT AND NOT A CHARACTER OFFSET, because the settled text is not the
 * prefix with more added: `format_turns` re-cases it and puts punctuation
 * in, so "we should measure" becomes "We should measure first." A word count
 * survives all of that — no engine behind this seam adds or removes words
 * when it formats — while a character offset would cut the settled sentence
 * in the wrong place and put half a word in the notes.
 */
export function wordsOf(text: string): string[] {
  const trimmed = text.trim();
  return trimmed === '' ? [] : trimmed.split(/\s+/);
}

/** `text` with its first `n` words removed. Empty when it has no more. */
export function wordsAfter(text: string, n: number): string {
  return wordsOf(text).slice(n).join(' ');
}

export function createPauseTicker(opts: PauseTickerOpts): PauseTicker {
  const schedule = opts.schedule ?? realTickScheduler;
  /**
   * Turn numbers already in a delta. An engine that settles the same turn
   * twice (the formatted-final quirk, should an adapter ever leak it) must
   * not double the words in the notes.
   */
  const seen = new Set<number>();
  let pending: NotesTurn[] = [];
  /**
   * The latest partial of each turn that has NOT settled yet.
   *
   * Read by `end()`, and by a ceiling tick for the engine-final prefix a
   * frame reported. Keyed by turn so a growing partial replaces its own
   * earlier draft rather than stacking three prefixes of one sentence.
   */
  const unsettled = new Map<number, NotesTurn>();
  /**
   * The engine's already-final prefix of each unsettled turn, as its latest
   * frame reported it. Separate from `unsettled` because the two answer
   * different questions: that map holds everything heard so far, this holds
   * only the part the engine will not take back.
   */
  const engineFinal = new Map<number, string>();
  /**
   * How many words of each turn a tick has already carried, so the same
   * words never reach the notes twice. Survives the turn settling — that is
   * the moment it is needed — and is dropped only when the remainder goes
   * out.
   */
  const carried = new Map<number, number>();
  let timer: unknown = null;
  /**
   * The endpoint-confirm countdown. Its own handle, because it is armed by a
   * different event from `timer` (an endpoint, not any frame) and cleared on
   * a different one (any later frame at all).
   */
  let confirm: unknown = null;
  /**
   * The cadence countdown. Held separately from `timer` because the two
   * clocks answer different questions — `timer` asks "has speech stopped?"
   * and restarts on every frame, `cadence` asks "how long has the oldest
   * unwritten word been waiting?" and must not.
   */
  let cadence: unknown = null;
  let ticks = 0;
  let ended = false;
  const cadenceMs = opts.cadenceMs;
  const hasCadence = cadenceMs !== undefined && Number.isFinite(cadenceMs) && cadenceMs > 0;
  const confirmMs = opts.endpointConfirmMs ?? DEFAULT_NOTES_ENDPOINT_CONFIRM_MS;
  const hasConfirm = Number.isFinite(confirmMs) && confirmMs > 0;

  const disarm = (): void => {
    if (timer !== null) {
      schedule.clear(timer);
      timer = null;
    }
  };

  const disarmConfirm = (): void => {
    if (confirm !== null) {
      schedule.clear(confirm);
      confirm = null;
    }
  };

  const disarmCadence = (): void => {
    if (cadence !== null) {
      schedule.clear(cadence);
      cadence = null;
    }
  };

  /** Start the ceiling if unwritten speech is waiting and none is running. */
  const armCadence = (): void => {
    if (!hasCadence || cadence !== null) return;
    cadence = schedule.set(() => {
      cadence = null;
      fire('cadence');
    }, cadenceMs);
  };

  /**
   * The mid-sentence words this tick may carry, and the bookkeeping that
   * stops them being carried again.
   *
   * A ceiling tick takes the engine's already-final prefix, because those
   * words are settled in everything but the sentence they sit in. The end
   * tick takes the whole latest partial, because there is no later tick to
   * hold out for. Both subtract what has already gone out.
   */
  const midSentence = (reason: NotesTickReason): NotesTurn[] => {
    const source: Array<[number, NotesTurn, string]> = [];
    for (const [turn, held] of unsettled) {
      const text = reason === 'end' ? held.text : (engineFinal.get(turn) ?? '');
      if (text.trim() === '') continue;
      source.push([turn, held, text]);
    }
    const out: NotesTurn[] = [];
    for (const [turn, held, text] of source.sort((a, b) => a[0] - b[0])) {
      const already = carried.get(turn) ?? 0;
      const rest = wordsAfter(text, already);
      if (rest === '') continue;
      carried.set(turn, already + wordsOf(rest).length);
      out.push({
        turn,
        text: rest,
        ...(held.speaker !== undefined ? { speaker: held.speaker } : {}),
        partial: true,
        ...(already > 0 ? { continued: true } : {}),
      });
    }
    return out;
  };

  const fire = (reason: NotesTickReason): void => {
    const tail = reason === 'pause' ? [] : midSentence(reason);
    // Quiet with nothing new said is just quiet, not an empty tick.
    //
    // AND THE CEILING IS LEFT RUNNING. A pause with an empty delta is a gap
    // inside a turn the engine has not endpointed — the words of it are
    // waiting, and disarming here would restart their wait on the next
    // syllable, which is the bug the ceiling exists to close. A ceiling that
    // reaches this line simply clears its own handle and re-arms with the
    // next word.
    if (pending.length === 0 && tail.length === 0) return;
    const turns = [...pending, ...tail];
    pending = [];
    // Only the END tick consumes them. A ceiling tick took a PREFIX of the
    // sentence in progress and that sentence is still in progress: dropping
    // it here would lose whatever is said between now and the stop.
    if (reason === 'end') unsettled.clear();
    // Whatever fired, every wait any of the three clocks was measuring is
    // over: this delta has gone. The next tick's clocks start from the next
    // word, not from a countdown a previous tick has already answered — two
    // pause clocks run at once, and without this the slower one fires a
    // second tick for words the faster one has already carried.
    disarm();
    disarmConfirm();
    disarmCadence();
    ticks++;
    opts.onTick({ tick: ticks, reason, turns });
  };

  return {
    onTurn(turn: EngineTurn): void {
      if (ended) return;
      if (turn.final) {
        // Whatever this turn last looked like mid-flight, the settled text
        // supersedes it — and a turn that settles is never a tail.
        unsettled.delete(turn.turn);
        engineFinal.delete(turn.turn);
        if (seen.has(turn.turn)) {
          // A settled turn arriving AGAIN is the engine's end-of-session
          // speaker pass changing its mind. One still waiting to compose
          // simply takes the new label. One that already went out in a tick
          // is a CORRECTION to words in the doc: the ticker has no delta
          // left to change, so it is reported up to the session, which can
          // find the mentions those words produced.
          const at = pending.findIndex((t) => t.turn === turn.turn);
          const waiting = pending[at];
          // Rebuilt rather than patched: a revision can take the label away
          // as well as change it, and an absent `speaker` is what "nobody"
          // looks like everywhere else on this path.
          if (waiting) {
            pending[at] = {
              turn: waiting.turn,
              text: waiting.text,
              ...(turn.speaker !== undefined ? { speaker: turn.speaker } : {}),
              ...(waiting.continued ? { continued: true } : {}),
            };
          } else {
            opts.onRevised?.({
              turn: turn.turn,
              ...(turn.speaker !== undefined ? { speaker: turn.speaker } : {}),
            });
          }
        } else {
          seen.add(turn.turn);
          // Only the part no tick has carried. A ceiling tick may have
          // written the opening of this sentence already, and re-emitting it
          // whole would put those words in the notes a second time.
          const already = carried.get(turn.turn) ?? 0;
          const rest = already > 0 ? wordsAfter(turn.text, already) : turn.text;
          carried.delete(turn.turn);
          if (rest.trim() !== '') {
            pending.push({
              turn: turn.turn,
              text: rest,
              ...(turn.speaker !== undefined ? { speaker: turn.speaker } : {}),
              ...(already > 0 ? { continued: true } : {}),
            });
          }
        }
        // The engine says the speaker stopped. Give the next one a moment to
        // start; if nobody does, that is the pause.
        disarmConfirm();
        if (hasConfirm) {
          confirm = schedule.set(() => {
            confirm = null;
            fire('pause');
          }, confirmMs);
        }
      } else {
        // Any frame at all contradicts a standing endpoint: somebody carried
        // on, so the short window is off and the fallback clock is what is
        // left.
        disarmConfirm();
        if (turn.text.trim().length > 0 && !seen.has(turn.turn)) {
          // A partial of a turn nobody has seen settle. Held so `end()` has
          // something to say about the sentence that was interrupted, and so
          // a ceiling tick can take the part of it the engine has finalized.
          unsettled.set(turn.turn, {
            turn: turn.turn,
            text: turn.text,
            ...(turn.speaker !== undefined ? { speaker: turn.speaker } : {}),
          });
          if (turn.settledText !== undefined && turn.settledText.trim() !== '') {
            engineFinal.set(turn.turn, turn.settledText);
          }
        }
      }
      // Any frame is speech: replace whatever quiet countdown was running.
      disarm();
      timer = schedule.set(() => {
        timer = null;
        fire('pause');
      }, opts.quietMs);
      // A WORD is enough to start the ceiling — see the header. Waiting for a
      // sentence to finish is what made the ceiling unreachable during the
      // long turns it exists for.
      if (turn.text.trim().length > 0) armCadence();
    },
    end(): void {
      if (ended) return;
      ended = true;
      disarm();
      disarmConfirm();
      disarmCadence();
      fire('end');
    },
  };
}
