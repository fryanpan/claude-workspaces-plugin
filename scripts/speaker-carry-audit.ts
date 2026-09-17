/**
 * What the speaker-name carry (PRs 1052 / 1058 / 1059) reaches on a meeting
 * ALREADY ON DISK, counted without a single model call.
 *
 * WHAT THIS IS NOT. It is not the "87 of 140 attributed bullets" line in
 * `docs/architecture/meeting-assistant.md`. That number counts BULLETS, and a
 * bullet's speaker tag is written by the note-taker: the composer is told to
 * emit `[@Name](speaker:LABEL)` (`packages/server/src/notes-prompt-store.ts:152`)
 * from transcript lines it is handed as "Name (LABEL): "
 * (`packages/server/src/notes-prompt-build.ts:494`, whose name half is
 * `speakerDisplayName`). No bullets exist until a model writes them, which is
 * why `scripts/rerun-meeting.ts:133-137` refuses a rerun on a machine with no
 * key rather than holding a meeting that writes nothing. Re-counting 87/140
 * after the fix therefore needs quota, and nothing here substitutes for it.
 *
 * WHAT THIS IS. The carry changed which NAMES the composer is handed, and that
 * half is pure bookkeeping over the doc's own index. The same stored
 * `meetings.jsonl` folds two ways:
 *
 * - per meeting — `MeetingRecord.speakers`, "for THIS meeting only"
 *   (`packages/server/src/meetings.ts:81`), which is the behaviour the 15
 *   September recording ran under; and
 * - doc-wide in write order — `docSpeakerNames`
 *   (`packages/server/src/meetings.ts:336`), which is what `MeetingStore.open`
 *   now carries into every leg.
 *
 * So this reports, per label and in total, how many settled TURNS and how many
 * WORDS sat on a voice that came out nameless under each fold. That is the
 * carry's reach over the transcript. It is a DIFFERENT METRIC from 87/140 —
 * turns and words, not bullets — and it is reported as such.
 *
 * WHICH QUESTION THE "AFTER" COLUMN ANSWERS. The doc-wide fold reads the index
 * AS IT STANDS, so a name typed in the last leg counts for the first one. That
 * is right for a REPLAY RUN TODAY — `MeetingStore.open` folds the whole index
 * at `meetings.ts:853`, which is what a rerun seeded with `--cast` carries in.
 * It is NOT a claim about what the meeting would have produced live on the day,
 * when the later legs' names had not been typed yet. Read the after column as
 * "what a replay starting from today's cast would have to work with", not as
 * "what the fix would have done at the time".
 *
 * PRIVACY. The meeting this exists for is confidential, so the output is
 * labels, counts, totals and booleans. A speaker's name is reduced to a
 * boolean inside the reader and never stored on a reading; a turn's text is
 * reduced to a word count at the same place. Nothing that reaches stdout has
 * ever held either. Every write goes through `out` / `fail` below.
 *
 * Usage:
 *   bun scripts/speaker-carry-audit.ts --data-dir <dir> --doc <docId> [--notes <notes.md>]
 *   bun scripts/speaker-carry-audit.ts --data-dir <dir>        # lists docs that have meetings
 *
 * `--notes` additionally counts the bullets on an unnamed voice in a notes
 * markdown file with `unnamedVoiceBullets`, the report's own instrument. Over
 * the notes the 15 September meeting ALREADY left behind that re-measures the
 * 87-of-140 BASELINE with no model; it says nothing about the after.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { speakerGivenName } from '../packages/core/src/speaker-name.ts';
import {
  docSpeakerNames,
  listMeetings,
  meetingDirPath,
  readTranscript,
} from '../packages/server/src/meetings.ts';
import { unnamedVoiceBullets } from './rerun-meeting-report.ts';

/** One engine label inside one meeting. Numbers and booleans only: the name
 *  that decided `namedPerMeeting` / `namedDocWide` is not kept. */
export interface LabelReading {
  label: string;
  turns: number;
  words: number;
  /** Named by the fold the recording ran under — this meeting's own map. */
  namedPerMeeting: boolean;
  /** Named by the fold that shipped — the doc's whole index, write order. */
  namedDocWide: boolean;
}

export interface MeetingReading {
  /** Position in the index, oldest first. The meeting id is not printed: it
   *  is built from the docId and would put it in the output twice. */
  ordinal: number;
  segment: number | null;
  mode: string;
  labels: LabelReading[];
  /** Settled turns the engine attached no label to at all. */
  turnsUnlabelled: number;
  wordsUnlabelled: number;
}

export interface CarryTotals {
  meetings: number;
  /** Distinct (meeting, label) pairs — an "A" in two legs is two voices. */
  voices: number;
  turns: number;
  words: number;
  voicesUnnamedPerMeeting: number;
  voicesUnnamedDocWide: number;
  turnsUnnamedPerMeeting: number;
  turnsUnnamedDocWide: number;
  wordsUnnamedPerMeeting: number;
  wordsUnnamedDocWide: number;
}

export interface CarryReading {
  meetings: MeetingReading[];
  totals: CarryTotals;
}

/** Words in a turn, which is all this ever learns about one. */
function wordCount(text: string): number {
  const t = text.trim();
  return t.length === 0 ? 0 : t.split(/\s+/).length;
}

/**
 * Fold the doc's stored meetings both ways.
 *
 * Returns `null` when the doc has no meetings at all, so the caller can say
 * so rather than printing a clean-looking zero.
 */
export function readCarry(dataDir: string, docId: string): CarryReading | null {
  const records = listMeetings(dataDir, docId);
  if (records.length === 0) return null;
  const docWide = docSpeakerNames(dataDir, docId);

  const meetings: MeetingReading[] = [];
  const totals: CarryTotals = {
    meetings: records.length,
    voices: 0,
    turns: 0,
    words: 0,
    voicesUnnamedPerMeeting: 0,
    voicesUnnamedDocWide: 0,
    turnsUnnamedPerMeeting: 0,
    turnsUnnamedDocWide: 0,
    wordsUnnamedPerMeeting: 0,
    wordsUnnamedDocWide: 0,
  };

  records.forEach((record, i) => {
    const perMeeting = record.speakers ?? {};
    const tally = new Map<string, { turns: number; words: number }>();
    let turnsUnlabelled = 0;
    let wordsUnlabelled = 0;

    for (const turn of readTranscript(dataDir, docId, record.meetingId)) {
      const words = wordCount(turn.text);
      totals.turns++;
      totals.words += words;
      if (turn.speaker === undefined) {
        turnsUnlabelled++;
        wordsUnlabelled += words;
        continue;
      }
      const seen = tally.get(turn.speaker) ?? { turns: 0, words: 0 };
      seen.turns++;
      seen.words += words;
      tally.set(turn.speaker, seen);
    }

    const labels: LabelReading[] = [...tally.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([label, seen]) => {
        // The two names are tested here and discarded here. Only the verdict
        // leaves this function.
        const namedPerMeeting = speakerGivenName(label, perMeeting) !== undefined;
        const namedDocWide = speakerGivenName(label, docWide) !== undefined;
        totals.voices++;
        if (!namedPerMeeting) {
          totals.voicesUnnamedPerMeeting++;
          totals.turnsUnnamedPerMeeting += seen.turns;
          totals.wordsUnnamedPerMeeting += seen.words;
        }
        if (!namedDocWide) {
          totals.voicesUnnamedDocWide++;
          totals.turnsUnnamedDocWide += seen.turns;
          totals.wordsUnnamedDocWide += seen.words;
        }
        return { label, turns: seen.turns, words: seen.words, namedPerMeeting, namedDocWide };
      });

    meetings.push({
      ordinal: i + 1,
      segment: record.segment ?? null,
      mode: record.mode,
      labels,
      turnsUnlabelled,
      wordsUnlabelled,
    });
  });

  return { meetings, totals };
}

function pct(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(1)}%`;
}

/** The reading as lines. Every value here is a number, a label or a boolean. */
export function renderCarry(reading: CarryReading): string[] {
  const lines: string[] = [];
  const t = reading.totals;
  lines.push('## Per meeting (oldest first)');
  lines.push('');
  lines.push(
    '| Meeting | Segment | Mode | Label | Turns | Words | Named per-meeting | Named doc-wide |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const m of reading.meetings) {
    if (m.labels.length === 0) {
      lines.push(
        `| ${m.ordinal} | ${m.segment ?? '-'} | ${m.mode} | (no labelled turns) | 0 | 0 | - | - |`,
      );
    }
    for (const l of m.labels) {
      lines.push(
        `| ${m.ordinal} | ${m.segment ?? '-'} | ${m.mode} | ${l.label} | ${l.turns} | ${l.words} | ` +
          `${l.namedPerMeeting ? 'yes' : 'NO'} | ${l.namedDocWide ? 'yes' : 'NO'} |`,
      );
    }
    if (m.turnsUnlabelled > 0) {
      lines.push(
        `| ${m.ordinal} | ${m.segment ?? '-'} | ${m.mode} | (no label) | ${m.turnsUnlabelled} | ` +
          `${m.wordsUnlabelled} | - | - |`,
      );
    }
  }
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(`Meetings: ${t.meetings}`);
  lines.push(`Voices (meeting x label): ${t.voices}`);
  lines.push(`Settled turns: ${t.turns}    Words: ${t.words}`);
  lines.push('');
  lines.push('| Fold | Nameless voices | Turns on them | Words on them | Share of words |');
  lines.push('| --- | --- | --- | --- | --- |');
  lines.push(
    `| per-meeting (before) | ${t.voicesUnnamedPerMeeting} of ${t.voices} | ${t.turnsUnnamedPerMeeting} | ` +
      `${t.wordsUnnamedPerMeeting} | ${pct(t.wordsUnnamedPerMeeting, t.words)} |`,
  );
  lines.push(
    `| doc-wide (after) | ${t.voicesUnnamedDocWide} of ${t.voices} | ${t.turnsUnnamedDocWide} | ` +
      `${t.wordsUnnamedDocWide} | ${pct(t.wordsUnnamedDocWide, t.words)} |`,
  );
  lines.push('');
  lines.push(
    'These are TURNS and WORDS, not bullets. They are not the 87-of-140 line, ' +
      'which counts composed bullets and needs the note-taker to run.',
  );
  return lines;
}

/** Docs under the data dir that have a meetings folder, for the not-found path. */
function docsWithMeetings(dataDir: string): string[] {
  const root = join(dataDir, 'meetings');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => {
    const dir = join(root, name);
    return statSync(dir).isDirectory() && existsSync(join(dir, 'meetings.jsonl'));
  });
}

function arg(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

/** The only two writers in this file. */
function out(line: string): void {
  console.log(line);
}
function fail(line: string): void {
  console.error(line);
}

export function main(argv: readonly string[]): number {
  const dataDir = arg(argv, '--data-dir');
  if (dataDir === undefined) {
    fail('speaker-carry-audit: --data-dir <dir> is required.');
    fail(
      '  bun scripts/speaker-carry-audit.ts --data-dir <dir> --doc <docId> [--notes <notes.md>]',
    );
    return 2;
  }
  if (!existsSync(dataDir)) {
    fail(`speaker-carry-audit: no such data dir: ${dataDir}`);
    return 2;
  }

  const docId = arg(argv, '--doc');
  const docs = docsWithMeetings(dataDir);
  if (docId === undefined) {
    if (docs.length === 0) {
      fail(`speaker-carry-audit: no meeting found — no doc under ${dataDir} has a meetings.jsonl.`);
      return 2;
    }
    fail(
      `speaker-carry-audit: --doc <docId> is required. ${docs.length} doc(s) here have meetings:`,
    );
    for (const d of docs) fail(`  ${d}`);
    return 2;
  }

  const dir = meetingDirPath(dataDir, docId);
  if (!existsSync(dir)) {
    fail(`speaker-carry-audit: no meeting found for doc "${docId}" — no such folder: ${dir}`);
    fail(
      docs.length === 0
        ? '  No doc under this data dir has meetings at all.'
        : `  ${docs.length} doc(s) here do have meetings; run without --doc to list them.`,
    );
    return 2;
  }

  const reading = readCarry(dataDir, docId);
  if (reading === null) {
    fail(`speaker-carry-audit: no meeting found for doc "${docId}" — its index lists none.`);
    return 2;
  }

  out(`# Speaker-name carry over stored meetings of ${docId}`);
  out('');
  for (const line of renderCarry(reading)) out(line);

  const notes = arg(argv, '--notes');
  if (notes !== undefined) {
    if (!existsSync(notes)) {
      fail(`speaker-carry-audit: --notes file not found: ${notes}`);
      return 2;
    }
    const counted = unnamedVoiceBullets(readFileSync(notes, 'utf8'));
    out('');
    out('## Bullets on an unnamed voice, in the notes as they stand');
    out('');
    out(`Bullets pointing at a nameless voice: ${counted.bullets}`);
    out(
      `Labels they point at: ${counted.labels.length === 0 ? '(none)' : counted.labels.join(', ')}`,
    );
    out('');
    out(
      'This is the BASELINE re-measured off bullets already written. The after ' +
        'number needs a replay through the note-taker, which needs quota.',
    );
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
