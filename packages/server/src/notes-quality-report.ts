/**
 * What a meeting's notes came out like, read at the stop, WITHOUT a model.
 *
 * WHY THIS EXISTS. The end-of-meeting line already said how many settled
 * turns reached a compose, and it said every one of them had — while the doc
 * it was reporting on carried dozens of repeated lines, a subject nobody had
 * written down and names attached to voices the room never held. Every one of
 * those is decidable from the notes and the transcript alone. The only check
 * that looked at the notes themselves was the eval harness, which needs an
 * API key and SKIPS, green, without one. So the checks moved here, where they
 * run at every stop and in an ordinary unit test.
 *
 * IT IS A READER, NOT A WRITER. Nothing in this module touches the doc, the
 * board or the disk: it takes the notes as markdown and the transcript as
 * turns and answers questions about them. That is what makes it testable on
 * notes no model wrote, and it is why the wiring — the log line, the stored
 * record, the review item — lives in its own modules.
 *
 * ITS RELATIONSHIP TO `notes-quality.ts`. That module holds the checks the
 * EVAL shares with this one, and the two headline counts here (topics opened
 * twice, walls of flat bullets) are its functions called rather than
 * reimplemented. What this module adds is the three questions the eval never
 * asked — a line written twice, a voice the meeting never had, and a subject
 * that reached no note — plus the arithmetic that turns all of them into one
 * verdict.
 *
 * THE COVERAGE CHECK LIVES NEXT DOOR. "Was this idea written down" is the
 * one check whose answer depends on something outside the notes, and the one
 * whose number stays well-formed when the notes reading fails. It, its
 * limits, and the third state that keeps a failed reading from arriving here
 * as a confident 100% verdict are in `notes-quality-coverage.ts`.
 */

import { findSpeakerTags } from '@claude-workspaces/core';
import { type InvertedNote, invertedNotes } from './notes-inversions.ts';
import { type NotesCoverage, type SpokenTurn, coverageOf } from './notes-quality-coverage.ts';
import {
  LATE_NOTE_MS,
  MAX_DUPLICATE_BULLET_LINES,
  MAX_DUPLICATE_HEADINGS,
  MAX_LATE_NOTE_SHARE,
  MAX_LONG_FLAT_RUNS,
  MAX_UNCOVERED_IDEA_SHARE,
  MAX_UNKNOWN_SPEAKERS,
  MIN_IDEAS_FOR_COVERAGE,
} from './notes-quality-thresholds.ts';
import {
  type FlatRun,
  allBullets,
  duplicateTopics,
  longFlatRuns,
  plainWords,
} from './notes-quality.ts';

export type { InvertedNote } from './notes-inversions.ts';
export type { SpokenTurn } from './notes-quality-coverage.ts';

/** Who the meeting actually had, as its record knows them. */
export interface MeetingVoices {
  /** Every engine label the transcript carries. */
  labels: readonly string[];
  /**
   * Label to the name a person gave THAT label, kept as a mapping rather than
   * flattened into `names`, because which voice a name belongs to is the
   * thing being checked. Absent when no meeting record could be read, which
   * leaves every label unassigned and every name in `names` acceptable on it.
   */
  assigned?: Readonly<Record<string, string>>;
  /** Every name the record gives — the assigned ones and the participant name
   *  the client supplied. Compared case-insensitively. This is the pool a
   *  label NOBODY named may draw from. */
  names: readonly string[];
}

/** One turn's wait, as a per-tick timing record reports it. */
export interface NoteWait {
  /** Milliseconds from the turn settling to the note carrying it landing. */
  waitMs: number;
}

/** How late notes landed, and — when nothing can say — what is missing. */
export interface NotesLateness {
  /**
   * `ticks` when a per-tick timing record was read, `unavailable` when there
   * was none. The distinction is the point: a meeting with no timing record
   * must not report a lateness of zero, which is what an absent file would
   * average to.
   */
  source: 'ticks' | 'unavailable';
  /** Waits read, when there were any. */
  measured: number;
  /** The middle wait and the worst one, in milliseconds. */
  medianMs: number | null;
  maxMs: number | null;
  /** Waits past {@link LATE_NOTE_MS}, and their share of those measured. */
  late: number;
  lateShare: number | null;
  /**
   * What is missing when `source` is `unavailable`, in words, so a reader of
   * the report is told rather than left to infer it from nulls.
   */
  missing?: string;
}

/** A bullet written more than once, and how many times. */
export interface RepeatedBullet {
  bullet: string;
  times: number;
}

/** A voice in the notes that the meeting never had. */
export interface UnknownVoice {
  /** The engine label the tag carries. */
  label: string;
  /** The name shown to a reader. */
  name: string;
  /** `label` when the transcript never carried that voice at all; `name`
   *  when the voice is real and the name attached to it is not. */
  why: 'label' | 'name';
}

/** The whole reading, counts and offenders together. */
export interface NotesQualityReport {
  /** Bullets in the notes, the denominator for the repeat counts. */
  bullets: number;
  /** Topics opened twice, by heading. */
  duplicateHeadings: string[];
  /** Repeated bullets, and the number of EXTRA lines they cost a reader. */
  repeatedBullets: RepeatedBullet[];
  duplicateBulletLines: number;
  /** Topics running as a wall of flat bullets. */
  longRuns: FlatRun[];
  /** Voices the meeting never had. */
  unknownVoices: UnknownVoice[];
  /** Notes that say the opposite of the sentence they came from, each with
   *  that sentence quoted. */
  inversions: InvertedNote[];
  /** Ideas heard, how many reached a note, and whether the notes could be
   *  read at all. The third state lives here and nowhere else. */
  coverage: NotesCoverage;
  lateness: NotesLateness;
  /** Which bars this meeting passed. Empty is the healthy state. */
  flags: NotesQualityFlag[];
}

/** One bar a meeting went past, in the words the line and the item use. */
export interface NotesQualityFlag {
  kind:
    | 'duplicate-bullets'
    | 'duplicate-headings'
    | 'flat-runs'
    | 'unknown-speakers'
    | 'coverage'
    | 'notes-unread'
    | 'late';
  /** What a reader is told, already carrying its own number. */
  text: string;
}

/**
 * Words a speaker leaves in and a note-taker sometimes copies, which change
 * nothing a note says. Two notes that differ only by one of these are one
 * note twice to a reader: "Crews start on the high street in June" and
 * "Crews just start on the high street in June". Deliberately short, for the reason the
 * stoplist is: a word that can carry meaning ("only", "not", "like") must
 * never make two different notes read as one.
 */
export const FILLER_WORDS: ReadonlySet<string> = new Set(
  (
    'just really very actually basically obviously literally quite simply definitely ' +
    'totally honestly essentially anyway um uh er ah'
  ).split(' '),
);

/**
 * The key two bullets are compared on: their words alone, lowercased, with
 * punctuation, marks and filler words flattened away. A repeat that gained a
 * full stop, a bold mark or a "really" is still one line twice to a reader.
 */
export function bulletKey(bullet: string): string {
  return plainWords(bullet)
    .join(' ')
    .toLowerCase()
    .replace(/\b(?:kind|sort) of\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !FILLER_WORDS.has(w))
    .join(' ');
}

/** The bullets written more than once, worst first, compared on
 *  {@link bulletKey} — the same words-alone key `duplicateTopics` compares
 *  headings on, and for the same reason. The failure this catches is the
 *  reader's, and a reader sees two lines saying one thing. */
export function repeatedBullets(notes: string): RepeatedBullet[] {
  const seen = new Map<string, { bullet: string; times: number }>();
  for (const bullet of allBullets(notes)) {
    const key = bulletKey(bullet);
    if (!key) continue;
    const hit = seen.get(key);
    if (hit) hit.times++;
    else seen.set(key, { bullet, times: 1 });
  }
  return [...seen.values()].filter((b) => b.times > 1).sort((a, b) => b.times - a.times);
}

/** How many EXTRA lines the repeats cost a reader. */
export function duplicateBulletLines(repeats: readonly RepeatedBullet[]): number {
  return repeats.reduce((n, r) => n + (r.times - 1), 0);
}

/** A display name written the way the notes write an unnamed voice. */
const PLACEHOLDER_NAME = /^speaker\s+\S+$/i;

/**
 * Voices the notes attribute something to that the meeting never had.
 *
 * Two ways to be wrong, kept apart because they have different causes. A tag
 * whose LABEL the transcript never carried is a voice invented whole — the
 * composer wrote `speaker:C` in a two-voice room. A tag whose label is real
 * but whose NAME nobody gave it is the more common failure: a plausible name
 * attached to a voice that only ever had a placeholder.
 *
 * THE NAME IS CHECKED AGAINST ITS OWN LABEL, not against a pool. The rule has
 * two halves:
 *
 * - A label somebody NAMED must carry that name, or the placeholder. With
 *   A named Priya and B named Wren, a tag reading Priya on `speaker:B` is
 *   reported — both names are real and both labels are real, and the pairing
 *   is still a sentence attributed to the person who did not say it. Pooling
 *   the names accepted it, which is the bug this half exists to close.
 * - A label NOBODY named may carry any name the record gives, the participant
 *   included. Nothing says which of them that voice is, so reporting one
 *   would be a false alarm on the ordinary two-person meeting where only one
 *   voice got a name.
 *
 * The placeholder itself is never wrong. `Speaker B` is what the notes are
 * instructed to write until somebody names the voice, so a tag showing it is
 * obeying the instructions rather than inventing anything.
 */
export function unknownVoices(notes: string, voices: MeetingVoices): UnknownVoice[] {
  const labels = new Set(voices.labels);
  const names = new Set(voices.names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const assigned = new Map<string, string>();
  for (const [label, name] of Object.entries(voices.assigned ?? {})) {
    const own = name.trim().toLowerCase();
    if (own) assigned.set(label, own);
  }
  const out: UnknownVoice[] = [];
  const reported = new Set<string>();
  for (const tag of findSpeakerTags(notes)) {
    const name = tag.text.replace(/^@/, '').trim();
    // The name this label was given, if it was given one. `undefined` and a
    // name are different states: unassigned draws on every name the record
    // gives, assigned accepts only its own.
    const own = assigned.get(tag.label);
    const nameFits = own === undefined ? names.has(name.toLowerCase()) : own === name.toLowerCase();
    const why: UnknownVoice['why'] | null = !labels.has(tag.label)
      ? 'label'
      : PLACEHOLDER_NAME.test(name) || nameFits
        ? null
        : 'name';
    if (why === null) continue;
    const key = `${tag.label}|${name}|${why}`;
    if (reported.has(key)) continue;
    reported.add(key);
    out.push({ label: tag.label, name, why });
  }
  return out;
}

/** The lateness reading for a meeting whose waits are known. */
export function latenessFrom(waits: readonly NoteWait[]): NotesLateness {
  if (waits.length === 0) {
    return {
      source: 'unavailable',
      measured: 0,
      medianMs: null,
      maxMs: null,
      late: 0,
      lateShare: null,
      missing:
        'no per-tick timing record for this meeting, so how long a turn waited for its ' +
        'note is not known — the meeting record carries when the meeting started and ' +
        'stopped, and nothing about when any one note was written. A meeting held ' +
        'before the timing record existed has none and never will, and an operator can ' +
        'switch the record off, so an absent one is ordinary rather than a fault',
    };
  }
  const sorted = [...waits].map((w) => w.waitMs).sort((a, b) => a - b);
  const late = sorted.filter((ms) => ms > LATE_NOTE_MS).length;
  return {
    source: 'ticks',
    measured: sorted.length,
    medianMs: sorted[Math.floor((sorted.length - 1) / 2)] ?? null,
    maxMs: sorted[sorted.length - 1] ?? null,
    late,
    lateShare: late / sorted.length,
  };
}

/** What a meeting's notes came out like. */
export interface NotesQualityInput {
  /** The meeting's notes section, as markdown. */
  notes: string;
  /** Its settled turns. Empty is allowed: a meeting nobody spoke in has no
   *  coverage question to answer. */
  transcript: readonly SpokenTurn[];
  /** Who the meeting had. Absent reads as "nobody was named", which makes
   *  every name in the notes unknown — the safe direction, and the reason
   *  the caller is expected to pass the record's own speakers. */
  voices?: MeetingVoices;
  /** Per-turn waits, when a timing record was found. */
  waits?: readonly NoteWait[];
  /**
   * Whether `notes` is a reading of this meeting's notes at all.
   *
   * Default `true`, because a caller holding notes it built itself — every
   * test, the eval harness — knows it read them. The server passes the
   * reader's own answer (`notes-written.ts`), and `false` is what stops a
   * failed reading from becoming a 100%-uncovered verdict.
   */
  notesRead?: boolean;
  /** What could not be read, when `notesRead` is false. */
  notesMissing?: string;
}

export function buildNotesQualityReport(input: NotesQualityInput): NotesQualityReport {
  const { notes, transcript } = input;
  const voices = input.voices ?? { labels: [], names: [] };
  const repeats = repeatedBullets(notes);
  const coverage = coverageOf(notes, transcript, {
    read: input.notesRead ?? true,
    ...(input.notesMissing !== undefined ? { missing: input.notesMissing } : {}),
  });
  const report: Omit<NotesQualityReport, 'flags'> = {
    bullets: allBullets(notes).length,
    duplicateHeadings: duplicateTopics(notes),
    repeatedBullets: repeats,
    duplicateBulletLines: duplicateBulletLines(repeats),
    longRuns: longFlatRuns(notes),
    unknownVoices: unknownVoices(notes, voices),
    inversions: invertedNotes(notes, transcript),
    coverage,
    lateness: latenessFrom(input.waits ?? []),
  };
  return { ...report, flags: notesQualityFlags(report) };
}

/** The bars this reading went past, in the words a person is shown. */
export function notesQualityFlags(report: Omit<NotesQualityReport, 'flags'>): NotesQualityFlag[] {
  const flags: NotesQualityFlag[] = [];
  const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;
  if (report.duplicateBulletLines > MAX_DUPLICATE_BULLET_LINES) {
    flags.push({
      kind: 'duplicate-bullets',
      text: `${plural(report.duplicateBulletLines, 'repeated bullet')} of ${report.bullets}`,
    });
  }
  if (report.duplicateHeadings.length > MAX_DUPLICATE_HEADINGS) {
    flags.push({
      kind: 'duplicate-headings',
      text: `${plural(report.duplicateHeadings.length, 'topic')} opened twice`,
    });
  }
  if (report.longRuns.length > MAX_LONG_FLAT_RUNS) {
    flags.push({
      kind: 'flat-runs',
      text: `${plural(report.longRuns.length, 'topic')} left as a wall of bullets`,
    });
  }
  if (report.unknownVoices.length > MAX_UNKNOWN_SPEAKERS) {
    flags.push({
      kind: 'unknown-speakers',
      text: `${plural(report.unknownVoices.length, 'speaker')} the meeting never had`,
    });
  }
  // NO FLAG FOR `report.inversions`: counted and logged, never filed, until
  // the rules are scored against real meetings (`notes-quality-thresholds.ts`).
  const { coverage } = report;
  if (coverage.source === 'unreadable') {
    // NEVER A COVERAGE FLAG HERE. The one thing this state must not do is
    // wear the verdict it replaced: "100% of what was said reached no note"
    // is what a broken divisor says, and it is what a person answered "not
    // true" to. A reading that failed raises a flag about ITSELF.
    //
    // THE SAME FLOOR THE COVERAGE VERDICT NEEDS, and not a lower one. This
    // flag says a coverage verdict could not be reached; below
    // MIN_IDEAS_FOR_COVERAGE there would have been no verdict to reach even
    // from a perfect reading, so firing there would wake a reader about the
    // absence of something they were never going to be told. The first
    // version of this bar was `ideas > 0`, which made a failed reading
    // LOUDER than a successful one on the same short meeting.
    if (coverage.ideas >= MIN_IDEAS_FOR_COVERAGE) {
      flags.push({
        kind: 'notes-unread',
        text: `this meeting's notes could not be read, so what reached a note is not known`,
      });
    }
  } else if (
    coverage.uncoveredShare !== null &&
    coverage.uncoveredShare > MAX_UNCOVERED_IDEA_SHARE
  ) {
    flags.push({
      kind: 'coverage',
      text: `${Math.round(coverage.uncoveredShare * 100)}% of what was said reached no note`,
    });
  }
  const { lateness } = report;
  if (lateness.lateShare !== null && lateness.lateShare > MAX_LATE_NOTE_SHARE) {
    flags.push({
      kind: 'late',
      text: `${Math.round(lateness.lateShare * 100)}% of notes landed over a minute late`,
    });
  }
  return flags;
}

/**
 * The counts, as the end-of-meeting log line carries them.
 *
 * Counts only, never the notes' own words: this string goes to the process
 * log, which is a different place from the doc and is read by people looking
 * at a machine rather than at a meeting.
 */
export function notesQualityLogLine(report: NotesQualityReport): string {
  const coverage =
    report.coverage.source === 'unreadable'
      ? `notes unreadable, ${report.coverage.ideas} ideas unjudged`
      : report.coverage.ideas === 0
        ? 'no ideas heard'
        : `${report.coverage.uncoveredIdeas}/${report.coverage.ideas} ideas in no note`;
  const lateness =
    report.lateness.source === 'ticks'
      ? `${report.lateness.late}/${report.lateness.measured} notes late`
      : 'lateness unknown';
  return (
    `${report.duplicateBulletLines} repeated bullets of ${report.bullets}, ` +
    `${report.duplicateHeadings.length} topics twice, ` +
    `${report.longRuns.length} flat runs, ` +
    `${report.unknownVoices.length} unknown speakers, ` +
    `${report.inversions.length} inverted notes, ` +
    `${coverage}, ${lateness}`
  );
}
