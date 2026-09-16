/**
 * Two reruns of the same audio, side by side — which is the only way a
 * measure of a note-taker means anything.
 *
 * WHY THE HARNESS OWNS THIS AT ALL. A number from one run says nothing: the
 * question every change to the note-taker is judged on is whether THIS audio
 * comes out better than it did on the old code, and the answer has been
 * assembled by hand, from two report files, by a reader holding both. Two
 * readings assembled by hand is how a measure whose DEFINITION moved between
 * the runs gets reported as an improvement.
 *
 * SO EVERY ROW NAMES WHAT IT COUNTS. The middle column is the definition, not
 * a label, and a row whose definition changed between the two runs says so in
 * it. `--compare` is the flag; `report.json` beside every run's `report.md`
 * is what it reads, because parsing a rendered table back is a way to be
 * wrong quietly.
 *
 * It judges nothing. No row is green or red and no total is computed: the
 * harness puts the two numbers next to each other and the reader decides,
 * which is the same rule the report itself follows.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RerunReport } from './rerun-meeting-report.ts';

/** Where a run's machine-readable report sits, beside the one people read. */
export const REPORT_JSON = 'report.json';

/** Raised for a `--compare` that names something this cannot read. Carries
 *  the path it tried, because "not a rerun" without one is unactionable. */
export class CompareTargetError extends Error {}

/**
 * The `report.json` a `--compare` value points at.
 *
 * Three spellings, because all three are things a person has in their hand: a
 * run directory, the `report.md` they were just reading, and the json itself.
 * A `report.md` from a run before this file existed has no json beside it and
 * is refused by name rather than half-read.
 */
export function resolveComparePath(target: string): string {
  const candidates = ((): string[] => {
    if (existsSync(target) && statSync(target).isDirectory()) return [join(target, REPORT_JSON)];
    if (target.endsWith('.json')) return [target];
    return [target.replace(/report\.md$/, REPORT_JSON), join(target, REPORT_JSON)];
  })();
  const hit = candidates.find((path) => existsSync(path));
  if (hit === undefined) {
    throw new CompareTargetError(
      `--compare ${target}: no ${REPORT_JSON} here. Point it at a rerun folder, its ` +
        `${REPORT_JSON}, or a report.md with one beside it. Runs from before ${REPORT_JSON} ` +
        'existed cannot be compared — rerun that audio on that commit.',
    );
  }
  return hit;
}

/** Every field the table reads, so a file that is JSON but not a report is
 *  refused here rather than rendering a row of `undefined` — or throwing on
 *  `billedUsd.toFixed` halfway down the table. A report from a build with a
 *  measure this one does not have still loads: extra fields are ignored, and
 *  a MISSING one is the thing that cannot be rendered. */
const NUMBERS = [
  'audioMs',
  'ideasVoiced',
  'ideasCovered',
  'sectionIdeasVoiced',
  'sectionIdeasCovered',
  'bulletsWritten',
  'bullets',
  'topicHeadings',
  'longestFlatRun',
  'unnamedVoiceBullets',
  'billedUsd',
] as const satisfies readonly (keyof RerunReport)[];
const STRINGS = [
  'method',
  'engine',
  'docShape',
  'commit',
] as const satisfies readonly (keyof RerunReport)[];

/** What a report is missing, in the order the table would have read it.
 *  Empty for one this can render. */
function missingFields(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return ['(not an object)'];
  const r = raw as Record<string, unknown>;
  const missing = [
    ...STRINGS.filter((key) => typeof r[key] !== 'string'),
    ...NUMBERS.filter((key) => typeof r[key] !== 'number'),
  ] as string[];
  if (!(typeof r.firstNoteMs === 'number' || r.firstNoteMs === null)) missing.push('firstNoteMs');
  const tidy = r.tidy as Record<string, unknown> | undefined;
  if (typeof tidy?.applied !== 'number' || typeof tidy.proposed !== 'number') missing.push('tidy');
  return missing;
}

/** The earlier run, read back. Throws {@link CompareTargetError} for a file
 *  that is not one, so a typo does not render a table of `undefined`. */
export function loadRerunReport(target: string): RerunReport {
  const path = resolveComparePath(target);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new CompareTargetError(`--compare ${path}: ${(err as Error).message}`);
  }
  const missing = missingFields(raw);
  if (missing.length > 0) {
    throw new CompareTargetError(
      `--compare ${path} is not a rerun report this build can read: no ${missing.join(', ')}. ` +
        'A run from before a measure existed cannot be compared on it — rerun that audio.',
    );
  }
  return raw as RerunReport;
}

/** One row: what it counts, and the two runs' readings of it. */
interface CompareRow {
  measure: string;
  counts: string;
  of: (r: RerunReport) => string;
}

const share = (covered: number, voiced: number): string =>
  voiced > 0 ? `${covered} of ${voiced} (${Math.round((covered / voiced) * 100)}%)` : `${covered}`;

/**
 * The rows, in the order a reader asks them.
 *
 * COVERAGE IS TWO ROWS AND NOT ONE, for as long as reruns on both sides of
 * 2026-09-16 exist. The whole-doc row is the reading to judge on; the
 * section-only row is what the older run's headline number WAS, so a reader
 * comparing across that commit can see the step the definition took and the
 * step the note-taker took, separately.
 */
const ROWS: readonly CompareRow[] = [
  {
    measure: 'Ideas voiced',
    counts: 'settled sentences carrying enough content words to be an idea',
    of: (r) => `${r.ideasVoiced}`,
  },
  {
    measure: 'Ideas covered — whole doc',
    counts: 'ideas whose words appear in a bullet this meeting wrote, anywhere',
    of: (r) => share(r.ideasCovered, r.ideasVoiced),
  },
  {
    measure: 'Ideas covered — section only',
    counts: 'the same, over the section this meeting opened (the old reading)',
    of: (r) => share(r.sectionIdeasCovered, r.sectionIdeasVoiced),
  },
  {
    measure: 'Bullets this meeting wrote',
    counts: 'bullets carrying the note-taker’s mark, anywhere in the document',
    of: (r) => `${r.bulletsWritten}`,
  },
  {
    measure: 'Topic headings opened',
    counts: 'headings in the document when the meeting stopped',
    of: (r) => `${r.topicHeadings}`,
  },
  {
    measure: 'Longest flat run',
    counts: 'consecutive top-level bullets with no nesting or heading between',
    of: (r) => `${r.longestFlatRun} of ${r.bullets}`,
  },
  {
    measure: 'Bullets on an unnamed voice',
    counts: 'bullets tagged with a label nobody gave a name',
    of: (r) => `${r.unnamedVoiceBullets}`,
  },
  {
    measure: 'Tidy-up applied',
    counts: 'edits the at-stop pass landed',
    of: (r) => `${r.tidy.applied} of ${r.tidy.proposed} proposed`,
  },
  {
    measure: 'Billed',
    counts: 'dollars of model calls this harness metered',
    of: (r) => `$${r.billedUsd.toFixed(4)}`,
  },
  {
    measure: 'Latency to first note',
    counts: 'seconds from the meeting starting to the first note landing',
    of: (r) => (r.firstNoteMs === null ? 'never' : `${(r.firstNoteMs / 1000).toFixed(1)}s`),
  },
];

/** A run named the way a reader tells two of them apart. */
function runLabel(r: RerunReport): string {
  return `${r.method} · ${r.engine} · ${r.commit}`;
}

/**
 * The before/after table, as the lines of the report that carries it.
 *
 * Nothing here says which run is better. Where the two ran different audio,
 * different methods or different engines, the table says so under it rather
 * than refusing: a comparison a person asked for is a comparison they get,
 * with what makes it uneven named.
 */
export function renderComparison(before: RerunReport, after: RerunReport): string[] {
  const uneven: string[] = [];
  if (Math.abs(before.audioMs - after.audioMs) > 1000) {
    uneven.push(
      `the audio is not the same length (${(before.audioMs / 60_000).toFixed(1)} min before, ` +
        `${(after.audioMs / 60_000).toFixed(1)} min after)`,
    );
  }
  if (before.method !== after.method) uneven.push('the note-taker is not the same method');
  if (before.engine !== after.engine) uneven.push('the audio was heard by different engines');
  if (before.docShape !== after.docShape) uneven.push('the starting document is not the same');
  return [
    '## Before and after, on this audio',
    '',
    `| Measure | What it counts | Before — ${runLabel(before)} | After — ${runLabel(after)} |`,
    '| --- | --- | --- | --- |',
    ...ROWS.map(
      (row) => `| ${row.measure} | ${row.counts} | ${row.of(before)} | ${row.of(after)} |`,
    ),
    ...(uneven.length === 0
      ? []
      : ['', `Not a clean comparison: ${uneven.join('; ')}. Read every row against that.`]),
  ];
}

/**
 * The commit the code this run measured itself on came from.
 *
 * Here rather than in the run, because it exists for the comparison: a row
 * saying 19 of 24 means nothing without which build produced it, and "old
 * code against new on the same audio" is the whole claim a before/after
 * table makes. `unknown` for a checkout git cannot answer about — a worse
 * report, never a failed run.
 */
export function headCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: dirname(new URL(import.meta.url).pathname),
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}
