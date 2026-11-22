/**
 * How much of a meeting reached the transcript, said in minutes.
 *
 * A 188-minute public meeting once reached the transcript for about 68 of
 * them, and nothing said so: not the page while it ran, and not the notes
 * afterwards. Coverage is the number that would have told someone, in two
 * forms that share this file:
 *
 * - LIVE: `MeetingCoverageLive` rides the board's meeting to every open page,
 *   so the lead chat can say "Recording · 42 min" and raise the alert when no
 *   audio has arrived for a minute. The server sends it only when the state
 *   changes; a page counts the minutes forward itself (`capturedMsAt`).
 * - AT THE END: `coverageStampLine` is the one line the notes section gets,
 *   e.g. "Coverage: captured 68 of 188 minutes; gaps at 18:02–18:11."
 *
 * "Captured" is audio the server received, counted in bytes, not time the
 * socket was open. Elapsed is the meeting's start to its last leg's end.
 */

/** A stretch with no audio longer than this is a gap: it raises the alert
 *  and appears in the stamp. A page move (well under a second) never does. */
export const COVERAGE_GAP_MS = 60_000;

/** Why no audio is arriving: the socket is up but silent, or the recording
 *  device's connection went and has not come back. */
export type CoverageGapReason = 'no-audio' | 'connection';

/**
 * - `recording`: audio is arriving.
 * - `paused`: the recording socket closed under a minute ago and may come
 *   back (a page move does this).
 * - `gap`: no audio for over a minute; `gap` says since when and why.
 * - `stopped`: the recording ended.
 */
export type CoverageState = 'recording' | 'paused' | 'gap' | 'stopped';

export interface MeetingCoverageLive {
  /** The recording's own id (`MeetingRecord.meetingId`). */
  meetingId: string;
  startedAt: number;
  /** Audio received up to `asOf`, across every leg of the meeting. */
  capturedMs: number;
  /** When `capturedMs` was read, on the server's clock. */
  asOf: number;
  state: CoverageState;
  /** The gap open now. Present exactly when `state` is `gap`. */
  gap?: { from: number; reason: CoverageGapReason };
  /** Gaps of over a minute that have already closed. */
  gapsClosed: number;
}

/** Audio received by `now`: a recording page counts forward from `asOf`. */
export function capturedMsAt(c: MeetingCoverageLive, now: number): number {
  if (c.state !== 'recording') return c.capturedMs;
  return c.capturedMs + Math.max(0, now - c.asOf);
}

/** Elapsed since the start; a stopped meeting stops counting at `asOf`. */
export function elapsedMsAt(c: MeetingCoverageLive, now: number): number {
  const end = c.state === 'stopped' ? c.asOf : now;
  return Math.max(0, end - c.startedAt);
}

const MINUTE = 60_000;

/** Whole minutes, floored: a page never claims a minute not yet recorded. */
export function wholeMinutes(ms: number): number {
  return Math.max(0, Math.floor(ms / MINUTE));
}

/**
 * The short status the lead chat's heading shows: what the recording is
 * doing, then the minutes. "of N" appears once anything has been lost, so a
 * closed gap stays visible after its alert goes.
 */
export function coverageStatusLabel(c: MeetingCoverageLive, now: number): string {
  const captured = wholeMinutes(capturedMsAt(c, now));
  const elapsed = wholeMinutes(elapsedMsAt(c, now));
  const word =
    c.state === 'recording'
      ? 'Recording'
      : c.state === 'paused'
        ? 'Reconnecting'
        : c.state === 'gap'
          ? 'No audio'
          : 'Stopped';
  const lost = c.state === 'gap' || c.gapsClosed > 0 || elapsed - captured >= 2;
  return lost ? `${word} · ${captured} of ${elapsed} min` : `${word} · ${captured} min`;
}

/**
 * The alert sentence for an open gap, or empty. `clock` formats an instant
 * as the reader's HH:MM.
 */
export function coverageAlert(c: MeetingCoverageLive, clock: (ms: number) => string): string {
  if (c.state !== 'gap' || !c.gap) return '';
  const at = clock(c.gap.from);
  return c.gap.reason === 'connection'
    ? `The recording device lost its connection at ${at}. Nothing is being recorded.`
    : `No audio has reached the meeting since ${at}. Check the microphone on the recording device.`;
}

/** One stretch of the meeting, start inclusive. `to` null is still open. */
export interface CoverageSpan {
  from: number;
  to: number | null;
}

/**
 * The stretches where EVERY stream of the meeting delivered nothing, at least
 * `minMs` long. A two-stream meeting whose Mac audio died while its
 * microphone kept going lost one source, not the meeting, so that is not a
 * coverage gap. An open span ends at `endedAt`.
 */
export function wholeMeetingGaps(
  streams: readonly string[],
  gaps: ReadonlyArray<CoverageSpan & { stream: string }>,
  endedAt: number,
  minMs = COVERAGE_GAP_MS,
): Array<{ from: number; to: number }> {
  if (streams.length === 0) return [];
  let common: Array<{ from: number; to: number }> | null = null;
  for (const stream of streams) {
    const own = merge(
      gaps
        .filter((g) => g.stream === stream)
        .map((g) => ({ from: g.from, to: Math.min(g.to ?? endedAt, endedAt) }))
        .filter((g) => g.to > g.from),
    );
    common = common === null ? own : intersect(common, own);
  }
  return (common ?? []).filter((g) => g.to - g.from >= minMs);
}

function merge(spans: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  const out: Array<{ from: number; to: number }> = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

function intersect(
  a: ReadonlyArray<{ from: number; to: number }>,
  b: ReadonlyArray<{ from: number; to: number }>,
): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  for (const x of a) {
    for (const y of b) {
      const from = Math.max(x.from, y.from);
      const to = Math.min(x.to, y.to);
      if (to > from) out.push({ from, to });
    }
  }
  return out;
}

/** What the stamp says: the two totals, the gaps, and how it ended. */
export interface CoverageSummary {
  capturedMs: number;
  elapsedMs: number;
  gaps: ReadonlyArray<{ from: number; to: number }>;
  /** The recording's connection went at this instant and never came back. */
  droppedAt?: number;
}

/**
 * Captured is the smaller of the audio received and the time outside the
 * gaps, so the two figures in the stamp can never add up to more than the
 * meeting.
 */
export function summarizeCoverage(args: {
  audioMs: number;
  startedAt: number;
  endedAt: number;
  gaps: ReadonlyArray<{ from: number; to: number }>;
  droppedAt?: number;
}): CoverageSummary {
  const elapsedMs = Math.max(0, args.endedAt - args.startedAt);
  const lost = args.gaps.reduce((sum, g) => sum + (g.to - g.from), 0);
  const capturedMs = Math.max(0, Math.min(args.audioMs, elapsedMs - lost));
  return {
    capturedMs,
    elapsedMs,
    gaps: args.gaps,
    ...(args.droppedAt !== undefined ? { droppedAt: args.droppedAt } : {}),
  };
}

/** The stamp's first word, which is also how a later stamp finds it. */
export const COVERAGE_STAMP_PREFIX = 'Coverage:';

/** "68 of 188 minutes", or seconds for a meeting under a minute long. */
function spanWords(captured: number, elapsed: number): string {
  if (elapsed < MINUTE) {
    const s = (ms: number) => Math.round(ms / 1000);
    return `${s(captured)} of ${s(elapsed)} seconds`;
  }
  const m = (ms: number) => Math.round(ms / MINUTE);
  return `${m(captured)} of ${m(elapsed)} minute${m(elapsed) === 1 ? '' : 's'}`;
}

/**
 * The one line the notes section gets when the meeting ends:
 * "Coverage: captured 68 of 188 minutes; gaps at 18:02–18:11, 19:40–19:43."
 */
export function coverageStampLine(s: CoverageSummary, clock: (ms: number) => string): string {
  const parts = [`${COVERAGE_STAMP_PREFIX} captured ${spanWords(s.capturedMs, s.elapsedMs)}`];
  if (s.gaps.length > 0) {
    parts.push(`gaps at ${s.gaps.map((g) => `${clock(g.from)}–${clock(g.to)}`).join(', ')}`);
  }
  let line = `${parts.join('; ')}.`;
  if (s.droppedAt !== undefined) {
    line += ` The recording stopped at ${clock(s.droppedAt)} when its connection was lost.`;
  }
  return line;
}

/** HH:MM on the clock of whoever formats it. */
export function localClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
