/**
 * The five goal verdicts a replay is scored on, and the windows a
 * transcript is cut into for listing its ideas. Pure; tested in
 * `notes-replay-lib.test.ts` with invented meetings.
 */

import {
  allBullets,
  decisionsWithoutSpeaker,
  duplicateTopics,
  emptyHeadings,
  longFlatRuns,
  overlongBullets,
  parseNotesTopics,
  proseNote,
  verbatimBullets,
} from '../packages/server/src/notes-quality.ts';
import type { TranscriptRow } from './notes-replay-lib.ts';

/* ===== The five goal verdicts ===== */

/** The goal's own bars (board goal "a good meeting"). */
export const GOAL = {
  /** Lost ideas under this share passes. */
  lostPass: 0.05,
  /** Over this share is a defect. */
  lostDefect: 0.1,
  /** A note within this many ms of its turn settling is on time. */
  lateMs: 10_000,
  /** Under this share of late notes passes. */
  lateShare: 0.1,
} as const;

export interface GoalInputs {
  duplicateBulletLines: number;
  duplicateHeadings: number;
  /** Ideas judged, and how many the notes did not carry. Null if not judged. */
  ideas: { judged: number; lost: number } | null;
  /** Settled-to-written per written tick, ms. */
  waitsMs: readonly number[];
  unknownSpeakers: number;
  /** Quality-flag kinds the meeting's at-stop report filed, if any. */
  reportedKinds: readonly string[];
  /** Notes restating an earlier note under the same heading
   *  (`notes-repeat-judge.ts`). Absent: not asked. Null: asked, unread. */
  paraphrasedRepeats?: number | null;
}

export interface GoalVerdict {
  pass: boolean;
  [k: string]: unknown;
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Which report flags would name a miss on each of goals 1-4. */
const NAMED_BY: Record<string, readonly string[]> = {
  repeats: ['duplicate-bullets', 'duplicate-headings'],
  lostIdeas: ['coverage', 'notes-unread'],
  latency: ['late'],
  speakers: ['unknown-speakers'],
};

export function scoreGoals(g: GoalInputs): Record<string, GoalVerdict> {
  const lostShare = g.ideas && g.ideas.judged > 0 ? g.ideas.lost / g.ideas.judged : null;
  const med = median(g.waitsMs);
  const late = g.waitsMs.filter((w) => w > GOAL.lateMs).length;
  const lateShare = g.waitsMs.length > 0 ? late / g.waitsMs.length : null;
  const out: Record<string, GoalVerdict> = {
    repeats: {
      pass: g.duplicateBulletLines === 0 && g.duplicateHeadings === 0,
      duplicateBulletLines: g.duplicateBulletLines,
      duplicateHeadings: g.duplicateHeadings,
    },
    lostIdeas: {
      pass: lostShare !== null && lostShare < GOAL.lostPass,
      defect: lostShare !== null && lostShare > GOAL.lostDefect,
      judged: g.ideas?.judged ?? 0,
      lost: g.ideas?.lost ?? 0,
      lostShare,
    },
    latency: {
      pass: med !== null && med <= GOAL.lateMs && lateShare !== null && lateShare < GOAL.lateShare,
      notes: g.waitsMs.length,
      medianMs: med,
      lateOver10s: late,
      lateShare,
    },
    speakers: { pass: g.unknownSpeakers === 0, unknownSpeakers: g.unknownSpeakers },
  };
  const missed = Object.keys(NAMED_BY).filter((k) => out[k]?.pass === false);
  const silent = missed.filter(
    (k) => !(NAMED_BY[k] ?? []).some((kind) => g.reportedKinds.includes(kind)),
  );
  out.reported = { pass: silent.length === 0, missed, unreported: silent };
  // After `reported` on purpose: no product flag can name a paraphrase.
  if (g.paraphrasedRepeats !== undefined) {
    out.paraphrases = {
      pass: g.paraphrasedRepeats === 0,
      paraphrasedRepeats: g.paraphrasedRepeats,
    };
  }
  return out;
}

/* ===== The note-taking criteria, as counts ===== */

/**
 * How the notes are written, from the product's own free checks
 * (`notes-quality.ts`). Counts only and no verdict: none of these has a bar
 * the board has agreed, so they sit beside the goals rather than in them.
 */
export interface NoteShape {
  topics: number;
  /** Every note, bullet or paragraph: the denominator of the per-note counts. */
  notes: number;
  /** Notes written as a paragraph, not a list item (`proseNote`). */
  paragraphNotes: number;
  /** Flat runs past `MAX_FLAT_RUN_BULLETS`, and the topics holding one. */
  longFlatRuns: number;
  topicsWithLongRun: number;
  topicsWithLongRunShare: number | null;
  overlongBullets: number;
  duplicateTopics: number;
  emptyHeadings: number;
  decisionsWithoutSpeaker: number;
  verbatimBullets: number;
  decisionPrefixes: number;
  questionPrefixes: number;
}

/** Lines carrying the prefix anywhere: a speaker tag may come first. */
const PREFIXED = (word: string): RegExp => new RegExp(`^.*\\*\\*${word}:\\*\\*`, 'gm');

export function noteShape(notes: string, transcript: string): NoteShape {
  const topics = parseNotesTopics(notes).length;
  const runs = longFlatRuns(notes);
  const withRun = new Set(runs.map((r) => r.heading)).size;
  return {
    topics,
    notes: allBullets(notes).length,
    paragraphNotes: notes.split('\n').filter((line) => proseNote(line) !== undefined).length,
    longFlatRuns: runs.length,
    topicsWithLongRun: withRun,
    topicsWithLongRunShare: topics > 0 ? withRun / topics : null,
    overlongBullets: overlongBullets(notes).length,
    duplicateTopics: duplicateTopics(notes).length,
    emptyHeadings: emptyHeadings(notes).length,
    decisionsWithoutSpeaker: decisionsWithoutSpeaker(notes).length,
    verbatimBullets: verbatimBullets(notes, transcript).length,
    decisionPrefixes: notes.match(PREFIXED('Decision'))?.length ?? 0,
    questionPrefixes: notes.match(PREFIXED('Question'))?.length ?? 0,
  };
}

/**
 * Cut a transcript into windows for idea listing: a window closes at
 * `maxChars` or at a gap of `gapMs` with nothing said, whichever comes first.
 */
export function ideaWindows(
  turns: readonly TranscriptRow[],
  maxChars = 3_000,
  gapMs = 20_000,
): TranscriptRow[][] {
  const out: TranscriptRow[][] = [];
  let cur: TranscriptRow[] = [];
  let chars = 0;
  let last = Number.NEGATIVE_INFINITY;
  for (const t of turns) {
    if (cur.length > 0 && (chars + t.text.length > maxChars || t.ts - last > gapMs)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(t);
    chars += t.text.length;
    last = t.ts;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
