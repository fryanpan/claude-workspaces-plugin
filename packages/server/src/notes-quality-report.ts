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
 * THE COVERAGE CHECK IS LEXICAL AND ITS LIMITS ARE REAL. "Was this idea
 * written down" is answered by content-word overlap between one settled
 * sentence and the whole notes text. Three things it cannot do, and a reader
 * of its number has to know all three:
 *
 *   - **A paraphrase with no shared nouns reads as a miss.** "We'll ship it
 *     Tuesday" noted as "release lands early next week" shares nothing this
 *     can see. So the number is an UPPER bound on what was lost.
 *   - **An unrelated bullet about the same subject reads as coverage.** The
 *     overlap is against the whole notes text rather than against one bullet,
 *     so a topic mentioned anywhere absolves every sentence about it.
 *   - **It has no idea what mattered.** A settled sentence is an idea if it
 *     carries enough content words, which counts a long aside and skips a
 *     short decision.
 *
 * The model-judged version of the same question lives in the eval harness,
 * over a corpus, and is the number to trust about the RATE. This one is the
 * number to trust about THIS meeting having gone wrong, and its errors are
 * deliberately asymmetric: it over-reports misses, so a meeting it calls
 * clean is very likely clean.
 */

import { findSpeakerTags } from '@claude-workspaces/core';
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

/** One settled turn, as much of it as this module reads. Structural on
 *  purpose: `TranscriptTurn` from `meetings.ts` satisfies it, and so does a
 *  literal in a test, without this module importing anything that reads a
 *  file. */
export interface SpokenTurn {
  text: string;
  /** The engine's label for the voice. */
  speaker?: string;
  /** When the turn settled. Only the lateness reading uses it. */
  ts?: number;
}

/** Who the meeting actually had, as its record knows them. */
export interface MeetingVoices {
  /** Every engine label the transcript carries. */
  labels: readonly string[];
  /** The names a person gave those labels, and the participant name the
   *  client supplied. Compared case-insensitively. */
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
  /** Ideas heard, and the ones no note accounts for. */
  ideas: number;
  uncoveredIdeas: number;
  /** `null` when there were too few ideas for a share to mean anything. */
  uncoveredShare: number | null;
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
    | 'late';
  /** What a reader is told, already carrying its own number. */
  text: string;
}

/** Words too common to say anything about whether two texts are about the
 *  same thing. Small on purpose: a long list starts throwing away the nouns
 *  that carry a short sentence. */
const STOPWORDS = new Set(
  (
    'a about all also an and any are as at be been but by can could did do does for from get go' +
    ' had has have he her here him his how i if in into is it its just like me more most my no' +
    ' not of on one or our out over said say see she should so some than that the their them' +
    ' then there these they this those to too up us very was we well were what when where which' +
    ' who will with would yeah yes you your'
  ).split(' '),
);

/** A word reduced to the part two forms of it share. Not a stemmer: it drops
 *  the three endings that change a word without changing its subject, which
 *  is what keeps "shipping" and "shipped" from reading as different ideas. */
function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** The words of a text that say what it is about. */
export function contentWords(text: string): string[] {
  return plainWords(text)
    .map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

/** The bullets written more than once, worst first. Compared on their words
 *  alone, so a repeat that gained a full stop or a bold mark still counts —
 *  the failure this catches is the reader's, and a reader sees two lines
 *  saying one thing. */
export function repeatedBullets(notes: string): RepeatedBullet[] {
  const seen = new Map<string, { bullet: string; times: number }>();
  for (const bullet of allBullets(notes)) {
    // Words alone, punctuation and marks flattened away — the same key
    // `duplicateTopics` compares headings on, and for the same reason: a
    // repeat that gained a full stop is still one line twice to a reader.
    const key = plainWords(bullet)
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
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
 * The placeholder itself is never wrong. `Speaker B` is what the notes are
 * instructed to write until somebody names the voice, so a tag showing it is
 * obeying the instructions rather than inventing anything.
 */
export function unknownVoices(notes: string, voices: MeetingVoices): UnknownVoice[] {
  const labels = new Set(voices.labels);
  const names = new Set(voices.names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const out: UnknownVoice[] = [];
  const reported = new Set<string>();
  for (const tag of findSpeakerTags(notes)) {
    const name = tag.text.replace(/^@/, '').trim();
    const why: UnknownVoice['why'] | null = !labels.has(tag.label)
      ? 'label'
      : PLACEHOLDER_NAME.test(name) || names.has(name.toLowerCase())
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

/**
 * The share of an idea's content words that has to appear in the notes before
 * it counts as written down. Two fifths, for the reason
 * {@link MAX_UNCOVERED_IDEA_SHARE} gives: notes paraphrase, so an exact-words
 * test would report every good note as a miss.
 */
export const IDEA_OVERLAP_SHARE = 0.4;

/** The fewest content words a settled sentence needs before it is an idea at
 *  all. "Right." and "Yeah, exactly" are not ideas; "we ship Tuesday" is, and
 *  it is two content words, so the floor cannot be higher than two. */
export const MIN_IDEA_CONTENT_WORDS = 4;

/** The sentences of a meeting that carried enough to be worth a note. */
export function spokenIdeas(transcript: readonly SpokenTurn[]): string[][] {
  const out: string[][] = [];
  for (const turn of transcript) {
    for (const sentence of turn.text.split(/(?<=[.?!])\s+/)) {
      const words = contentWords(sentence);
      if (words.length >= MIN_IDEA_CONTENT_WORDS) out.push(words);
    }
  }
  return out;
}

/** The ideas whose words the notes do not carry. */
export function uncoveredIdeaCount(
  notes: string,
  transcript: readonly SpokenTurn[],
): {
  ideas: number;
  uncovered: number;
} {
  const ideas = spokenIdeas(transcript);
  const noted = new Set(contentWords(notes));
  let uncovered = 0;
  for (const idea of ideas) {
    const hit = idea.filter((w) => noted.has(w)).length;
    if (hit / idea.length < IDEA_OVERLAP_SHARE) uncovered++;
  }
  return { ideas: ideas.length, uncovered };
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
        'stopped, and nothing about when any one note was written. The record is ' +
        'written only when the server was booted with notes timing switched on, so an ' +
        'absent one is ordinary rather than a fault',
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
}

export function buildNotesQualityReport(input: NotesQualityInput): NotesQualityReport {
  const { notes, transcript } = input;
  const voices = input.voices ?? { labels: [], names: [] };
  const repeats = repeatedBullets(notes);
  const coverage = uncoveredIdeaCount(notes, transcript);
  const report: Omit<NotesQualityReport, 'flags'> = {
    bullets: allBullets(notes).length,
    duplicateHeadings: duplicateTopics(notes),
    repeatedBullets: repeats,
    duplicateBulletLines: duplicateBulletLines(repeats),
    longRuns: longFlatRuns(notes),
    unknownVoices: unknownVoices(notes, voices),
    ideas: coverage.ideas,
    uncoveredIdeas: coverage.uncovered,
    uncoveredShare:
      coverage.ideas >= MIN_IDEAS_FOR_COVERAGE ? coverage.uncovered / coverage.ideas : null,
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
  if (report.uncoveredShare !== null && report.uncoveredShare > MAX_UNCOVERED_IDEA_SHARE) {
    flags.push({
      kind: 'coverage',
      text: `${Math.round(report.uncoveredShare * 100)}% of what was said reached no note`,
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
    report.ideas === 0
      ? 'no ideas heard'
      : `${report.uncoveredIdeas}/${report.ideas} ideas in no note`;
  const lateness =
    report.lateness.source === 'ticks'
      ? `${report.lateness.late}/${report.lateness.measured} notes late`
      : 'lateness unknown';
  return (
    `${report.duplicateBulletLines} repeated bullets of ${report.bullets}, ` +
    `${report.duplicateHeadings.length} topics twice, ` +
    `${report.longRuns.length} flat runs, ` +
    `${report.unknownVoices.length} unknown speakers, ` +
    `${coverage}, ${lateness}`
  );
}
