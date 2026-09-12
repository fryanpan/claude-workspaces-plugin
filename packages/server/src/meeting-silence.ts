/**
 * How long a recording may hear nothing before it ends itself.
 *
 * THE ONLY REASON FOR A RUNNING TIMER IS TO NOTICE A MEETING WITH NO CONTENT
 * (Bryan, 2026-09-12). A microphone left open after everyone has left costs
 * money by the second the engine socket is open (see the cost table in
 * `docs/architecture/meeting-assistant.md`) and leaves a meeting in the record
 * whose length is a fact about nobody noticing. So the window below is counted
 * from the start of the recording and from every settled turn, and when it
 * runs out the relay stops the meeting down the same path a person's Stop
 * takes.
 *
 * SETTLED TURNS, NOT AUDIO. Frames keep arriving from a silent room — a dead
 * capture delivers digital silence and a live one delivers the air — so audio
 * is no evidence at all that anything was said. A settled turn is the engine
 * saying it heard words and is finished revising them, which is the only
 * signal here that a meeting has content.
 *
 * The env override exists for the same reason `doc-store-timings.ts` has one:
 * a test that waited out the production window would pay fifteen minutes.
 * Same shape as that resolver — read once at module load, and only able to
 * SHORTEN the window, so a stray value in a production environment cannot
 * leave a microphone open longer than the rule says.
 */

import { MEETING_SILENCE_MINUTES } from '@claude-workspaces/core';

/** The production window: fifteen minutes with no settled turn. */
export const DEFAULT_SILENCE_TIMEOUT_MS = MEETING_SILENCE_MINUTES * 60_000;

/**
 * Below this the timer is at the mercy of event-loop jitter, and a meeting
 * could be stopped before its own handshake had finished.
 */
const MIN_MS = 10;

/**
 * Resolve the window from `CW_MEETING_SILENCE_MS`.
 *
 * Anything that is not a finite number in `[MIN_MS, default]` yields the
 * default untouched: undefined, an empty string, a word, a negative, a zero,
 * and anything ABOVE the default.
 */
export function resolveSilenceTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SILENCE_TIMEOUT_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < MIN_MS || ms > DEFAULT_SILENCE_TIMEOUT_MS) {
    return DEFAULT_SILENCE_TIMEOUT_MS;
  }
  return Math.round(ms);
}

/**
 * Resolved once, at module load: this feeds a `setTimeout` on every meeting
 * start and on every settled turn, and re-reading the environment there would
 * be a syscall in the hot path. A test that needs a shorter window sets the
 * variable before the process starts; a unit test injects its own scheduler
 * instead and needs no window at all.
 */
export const SILENCE_TIMEOUT_MS: number = resolveSilenceTimeoutMs(
  process.env.CW_MEETING_SILENCE_MS,
);
