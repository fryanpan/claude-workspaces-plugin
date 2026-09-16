/**
 * What one rerun answered, as a file a person opens.
 *
 * SEVEN MEASURES AND NOT A SCORE. The meeting this harness was written for
 * produced 192 bullets, no topic heading at all, and a quality pass that read
 * 262 ideas voiced and none of them covered. No single number would have said
 * that; the shape of the failure is in which of these moved and which did
 * not, and a run that reports six of them and leaves the seventh blank is a
 * run somebody has to hold the meeting again to finish.
 *
 * NOTHING HERE IS COMPUTED TWICE. The ideas are the pipeline's own at-stop
 * quality pass (`notes-quality-report.ts`), the cost is the meeting summary's
 * own `spend`, the latency is `onFirstNote`, the tidy counts are the
 * cleanup route's own reply, and the structure counts are `notes-quality.ts`
 * called on the section this meeting wrote. A second implementation of any of
 * them would be a harness measuring itself.
 *
 * A MISSING MEASURE IS SAID IN WORDS. `null` renders as the reason it is
 * missing — "never: no note reached the doc" — because a blank cell in a
 * report about a note-taker that wrote nothing reads exactly like a report
 * that failed to look.
 */

import {
  cleanupReasonLine,
  groupCleanupReasons,
} from '../packages/core/src/notes-cleanup-report.ts';
import { flatBulletRuns, parseNotesTopics } from '../packages/server/src/notes-quality.ts';

/** What the at-stop tidy-up pass did, as its route answers. */
export interface TidyCounts {
  ok: boolean;
  /** Present when the pass refused — `no-composer`, `no-section`, … */
  reason?: string;
  proposed: number;
  applied: number;
  refused: number;
  /**
   * Every edit that did not reach the document, with the rule that dropped
   * it — `refusals` from the gate, `failures` from the applier.
   *
   * THE COUNTS ALONE WERE THE DEAD END. A row reading "16 proposed, 0
   * applied, 16 refused" is the finding this harness is run to produce and
   * says nothing about what to change; these are what the report prints
   * under it. Optional, because a run against a server that predates the
   * route's two arrays gets none — and an empty list there means "not
   * reported", not "nothing was refused", which is why the report says so
   * out loud when the count and the lines disagree.
   */
  refusals?: readonly string[];
  failures?: readonly string[];
}

/** The seven, plus what the run has to say to be reproducible. */
export interface RerunReport {
  /** Which note-taker ran, which engine heard the audio, which document it
   *  started from — the three things the run varied. */
  method: string;
  engine: string;
  docShape: string;
  docEdits: number;
  /** The audio, and how long the meeting actually ran for. */
  audioMs: number;
  elapsedMs: number;
  ticks: number;
  turnsSettled: number;
  /** 1. and 2. — the pipeline's own coverage reading. */
  ideasVoiced: number;
  ideasCovered: number;
  /** 3. Topic headings the note-taker opened in its own section. */
  topicHeadings: number;
  /** 4. The longest stretch of top-level bullets with no structure in it. */
  longestFlatRun: number;
  /** Every bullet in the document, as the denominator for the run above. */
  bullets: number;
  /**
   * The bullets inside the section this meeting opened — the slice the
   * pipeline's own coverage pass reads.
   *
   * Equal to `bullets` when the meeting started from an empty document. When
   * it started from somebody's outline the note-taker writes into THEIR
   * headings, and the coverage figures above are then a reading of a fraction
   * of the notes. Reported rather than corrected: the number is the
   * pipeline's, and quietly improving it here would hide the finding.
   */
  bulletsInSection: number;
  /** 5. */
  tidy: TidyCounts;
  /** 6. Dollars, from the usage every call reported. */
  billedUsd: number;
  billedCalls: number;
  /** Models this build has no price for — their tokens are in nobody's
   *  total, so a report that named none of them would understate itself. */
  unpricedModels: readonly string[];
  /** 7. `null` when no note ever reached the doc. */
  firstNoteMs: number | null;
  /** Where the reader goes next. */
  notesPath: string;
  logPath: string;
}

export interface RerunReportInput
  extends Omit<RerunReport, 'topicHeadings' | 'longestFlatRun' | 'bullets' | 'bulletsInSection'> {
  /** The whole document the meeting left behind, as markdown. */
  document: string;
  /** The section this meeting opened — a slice of the above. */
  section: string;
}

/**
 * The two structure counts, read off the section the meeting left behind.
 *
 * A heading with nothing under it still counts as opened: the question this
 * answers is whether the note-taker grouped what it heard, and an empty
 * heading is an attempt that the tidy pass may or may not have cleared.
 */
export function buildRerunReport(input: RerunReportInput): RerunReport {
  const { document, section, ...rest } = input;
  // READ OFF THE WHOLE DOCUMENT, not the section. A meeting that started from
  // somebody's outline writes into THEIR headings, and the section is only
  // what it appended — counting headings there answered "did it open a new
  // section" when the question was "did it group what it heard".
  const topics = parseNotesTopics(document);
  const runs = flatBulletRuns(document);
  return {
    ...rest,
    topicHeadings: topics.filter((t) => t.heading.length > 0).length,
    longestFlatRun: runs.reduce((worst, r) => Math.max(worst, r.bullets.length), 0),
    bullets: topics.reduce((n, t) => n + t.bullets.length, 0),
    bulletsInSection: parseNotesTopics(section).reduce((n, t) => n + t.bullets.length, 0),
  };
}

const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;

/** `null` says why it is null. A blank cell here has been read as "unmeasured"
 *  when it meant "the note-taker never wrote anything", which is the finding. */
function firstNoteLine(ms: number | null): string {
  return ms === null ? 'never — no note reached the doc' : `${(ms / 1000).toFixed(1)}s`;
}

function tidyLine(t: TidyCounts): string {
  const counts = `${t.proposed} proposed, ${t.applied} applied, ${t.refused} refused`;
  return t.ok ? counts : `${counts} (refused: ${t.reason ?? 'unknown'})`;
}

/**
 * Why the tidy-up did not apply what it proposed, one line per rule.
 *
 * NOT IN THE TABLE, because a table cell that holds six lines stops being a
 * table. It sits under it, and only when there is something to say — a run
 * whose tidy-up applied everything prints nothing here.
 *
 * AND A DISAGREEMENT IS SAID OUT LOUD. `refused` is a count the route has
 * always sent and the lines are newer, so a run against an older server has
 * the count with no lines. Printing nothing there would read as "nothing was
 * refused" on the exact run where the most was.
 */
export function tidyReasonLines(t: TidyCounts): string[] {
  const groups = groupCleanupReasons([...(t.refusals ?? []), ...(t.failures ?? [])]);
  if (groups.length === 0) {
    return t.refused > 0
      ? ['', `Why the tidy-up refused ${t.refused} edit(s): not reported by this server.`]
      : [];
  }
  return [
    '',
    'Why the tidy-up did not apply what it proposed:',
    ...groups.map((g) => `- ${cleanupReasonLine(g)}`),
  ];
}

/** The report as the file a person opens. Markdown, one table, no prose the
 *  reader has to join two rows to use. */
export function renderRerunReport(r: RerunReport): string {
  const covered =
    r.ideasVoiced > 0
      ? `${r.ideasCovered} of ${r.ideasVoiced} (${Math.round((r.ideasCovered / r.ideasVoiced) * 100)}%)`
      : `${r.ideasCovered} of 0 — nothing in this meeting read as an idea`;
  // The one number in this table that is read off a slice. Said out loud when
  // the slice is not the whole, because otherwise a coverage figure from a
  // third of the notes reads as a note-taker that lost the rest.
  const outside = r.bullets - r.bulletsInSection;
  const coverageNote =
    outside > 0
      ? ` — read over the ${r.bulletsInSection} bullet(s) in the section this meeting opened, ` +
        `not the ${outside} it wrote into the starting document's own headings`
      : '';
  return [
    '# Meeting rerun',
    '',
    `Note-taker **${r.method}** · engine **${r.engine}** · starting document **${r.docShape}**` +
      (r.docEdits > 0 ? ` with ${r.docEdits} edit(s) mid-run` : ''),
    '',
    `${minutes(r.audioMs)} of audio, replayed at audio rate; the meeting ran ${minutes(r.elapsedMs)} ` +
      `over ${r.ticks} tick(s) and ${r.turnsSettled} settled turn(s).`,
    '',
    '| Measure | This run |',
    '| --- | --- |',
    `| Ideas voiced | ${r.ideasVoiced} |`,
    `| Ideas covered | ${covered}${coverageNote} |`,
    `| Topic headings opened | ${r.topicHeadings} |`,
    `| Longest flat run of bullets | ${r.longestFlatRun} of ${r.bullets} bullet(s) |`,
    `| Tidy-up | ${tidyLine(r.tidy)} |`,
    `| Billed | $${r.billedUsd.toFixed(4)} over ${r.billedCalls} model call(s)${
      r.unpricedModels.length > 0 ? ` — short: no price for ${r.unpricedModels.join(', ')}` : ''
    } |`,
    `| Latency to first note | ${firstNoteLine(r.firstNoteMs)} |`,
    ...tidyReasonLines(r.tidy),
    '',
    `Notes: \`${r.notesPath}\``,
    `Run log: \`${r.logPath}\``,
    '',
  ].join('\n');
}
