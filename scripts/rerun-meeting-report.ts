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
 * A MEASURE THAT CHANGED DEFINITION PRINTS BOTH READINGS. Coverage used to be
 * read over the section the meeting opened, and is now read over every bullet
 * the meeting wrote anywhere in the doc (`notes-written.ts`). A run that
 * printed only the new number would read as a note-taker that suddenly
 * improved, so both are in the table, each labelled with what it counted.
 * That is the rule for any measure this plan is judged on, not a courtesy for
 * this one.
 *
 * A MISSING MEASURE IS SAID IN WORDS. `null` renders as the reason it is
 * missing — "never: no note reached the doc" — because a blank cell in a
 * report about a note-taker that wrote nothing reads exactly like a report
 * that failed to look.
 */

import { normalizeSpeakerName } from '../packages/core/src/speaker-name.ts';
import {
  allBullets,
  flatBulletRuns,
  parseNotesTopics,
} from '../packages/server/src/notes-quality.ts';
import { renderComparison } from './rerun-meeting-compare.ts';

/** A speaker tag as the notes carry it in markdown: `[@Devi](speaker:A)`. */
const SPEAKER_TAG = /\[@([^\]]+)\]\(speaker:([^)\s]+)\)/g;

/**
 * Bullets attributed to a voice NOBODY HAS NAMED, and the labels they point
 * at.
 *
 * The measure the speaker-continuity work is read against: on the meeting
 * that prompted it, 87 of 140 attributed bullets pointed at one label that
 * was never named, because every reconnect and every stop-and-start opened an
 * engine session that labelled the same room from "A" again. A tag reading
 * "Speaker A" (or "Room Speaker A") is the placeholder, which
 * `normalizeSpeakerName` is the one place that recognises.
 *
 * To grep for the same thing by hand in a notes file:
 * `grep -oE '\[@(Room |Remote )?Speaker [^]]*\]' <notes.md> | sort | uniq -c`
 */
export function unnamedVoiceBullets(document: string): { bullets: number; labels: string[] } {
  const labels = new Set<string>();
  let bullets = 0;
  for (const topic of parseNotesTopics(document)) {
    for (const bullet of topic.bullets) {
      let unnamed = false;
      for (const [, text, label] of bullet.matchAll(SPEAKER_TAG)) {
        if (normalizeSpeakerName(text) !== undefined) continue;
        unnamed = true;
        labels.add(label ?? '');
      }
      if (unnamed) bullets++;
    }
  }
  return { bullets, labels: [...labels].sort() };
}

/** What the at-stop tidy-up pass did, as its route answers. */
export interface TidyCounts {
  ok: boolean;
  /** Present when the pass refused — `no-composer`, `no-section`, … */
  reason?: string;
  proposed: number;
  applied: number;
  refused: number;
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
  /** 1. and 2. — the pipeline's own coverage reading, over every bullet this
   *  meeting wrote wherever it sits. */
  ideasVoiced: number;
  ideasCovered: number;
  /** The SAME run read the old way — over the section the meeting opened
   *  alone — so the change of definition is visible rather than banked. */
  sectionIdeasVoiced: number;
  sectionIdeasCovered: number;
  /** The commit this run's server was built from, so two rows of a
   *  comparison say which code each was. */
  commit: string;
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
   * KEPT NOW THAT IT IS NO LONGER THE COVERAGE SLICE. It was the whole of
   * what a meeting's coverage was read over, and the finding that ended that
   * is what this number now exists to show: on a meeting that wrote into
   * somebody's outline it is a small fraction of {@link bulletsWritten}, and
   * the report prints the coverage reading over each so the step the
   * definition took is visible beside the step the note-taker took.
   */
  bulletsInSection: number;
  /**
   * The bullets THIS MEETING WROTE, anywhere in the document — the notes the
   * coverage reading above was taken over, and the bullet count of the
   * `notes-meeting.md` the run writes beside this report.
   */
  bulletsWritten: number;
  /** Where those bullets were written out, for a reader checking the count. */
  writtenNotesPath: string;
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
  /** 8. Bullets pointing at a voice nobody named, and which labels they are.
   *  See {@link unnamedVoiceBullets} for why this is a measure at all. */
  unnamedVoiceBullets: number;
  unnamedVoiceLabels: readonly string[];
  /** Where the reader goes next. */
  notesPath: string;
  logPath: string;
}

export interface RerunReportInput
  extends Omit<
    RerunReport,
    | 'topicHeadings'
    | 'longestFlatRun'
    | 'bullets'
    | 'bulletsInSection'
    | 'bulletsWritten'
    | 'unnamedVoiceBullets'
    | 'unnamedVoiceLabels'
  > {
  /** The whole document the meeting left behind, as markdown. */
  document: string;
  /** The section this meeting opened — a slice of the above. */
  section: string;
  /** Every bullet this meeting wrote, wherever it sits — the other slice, and
   *  the one the coverage reading is taken over. */
  written: string;
}

/**
 * The two structure counts, read off the section the meeting left behind.
 *
 * A heading with nothing under it still counts as opened: the question this
 * answers is whether the note-taker grouped what it heard, and an empty
 * heading is an attempt that the tidy pass may or may not have cleared.
 */
export function buildRerunReport(input: RerunReportInput): RerunReport {
  const { document, section, written, ...rest } = input;
  // READ OFF THE WHOLE DOCUMENT, not the section. A meeting that started from
  // somebody's outline writes into THEIR headings, and the section is only
  // what it appended — counting headings there answered "did it open a new
  // section" when the question was "did it group what it heard".
  const topics = parseNotesTopics(document);
  const runs = flatBulletRuns(document);
  const unnamed = unnamedVoiceBullets(document);
  return {
    ...rest,
    unnamedVoiceBullets: unnamed.bullets,
    unnamedVoiceLabels: unnamed.labels,
    topicHeadings: topics.filter((t) => t.heading.length > 0).length,
    longestFlatRun: runs.reduce((worst, r) => Math.max(worst, r.bullets.length), 0),
    bullets: topics.reduce((n, t) => n + t.bullets.length, 0),
    bulletsInSection: parseNotesTopics(section).reduce((n, t) => n + t.bullets.length, 0),
    bulletsWritten: allBullets(written).length,
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

/** One coverage reading as a share, with the `0 of 0` case said in words. */
function coveredCell(covered: number, voiced: number): string {
  return voiced > 0
    ? `${covered} of ${voiced} (${Math.round((covered / voiced) * 100)}%)`
    : `${covered} of 0 — nothing in this meeting read as an idea`;
}

/**
 * The two coverage readings of one run, side by side.
 *
 * BOTH, ALWAYS, and not only when they differ. The definition changed in the
 * commit that added this table: a reader who sees one number cannot tell a
 * note-taker that improved from a measure that widened, and a table that
 * hides the old reading whenever the two agree teaches the reader to trust
 * one number on the runs where it matters least.
 */
export function coverageTable(r: RerunReport): string[] {
  return [
    '| Coverage reading | Ideas voiced | Ideas covered | Read over |',
    '| --- | --- | --- | --- |',
    `| Whole doc — every bullet this meeting wrote, wherever it sits | ${r.ideasVoiced} | ` +
      `${coveredCell(r.ideasCovered, r.ideasVoiced)} | ${r.bulletsWritten} bullet(s), ` +
      `\`${r.writtenNotesPath}\` |`,
    '| Section only — bullets under the heading this meeting opened (the reading ' +
      `before 2026-09-16) | ${r.sectionIdeasVoiced} | ` +
      `${coveredCell(r.sectionIdeasCovered, r.sectionIdeasVoiced)} | ` +
      `${r.bulletsInSection} bullet(s) of the ${r.bullets} in the document |`,
  ];
}

/** The report as the file a person opens. Markdown, one table, no prose the
 *  reader has to join two rows to use. */
export function renderRerunReport(r: RerunReport, before?: RerunReport): string {
  return [
    '# Meeting rerun',
    '',
    `Note-taker **${r.method}** · engine **${r.engine}** · starting document **${r.docShape}**` +
      (r.docEdits > 0 ? ` with ${r.docEdits} edit(s) mid-run` : ''),
    '',
    `${minutes(r.audioMs)} of audio, replayed at audio rate; the meeting ran ${minutes(r.elapsedMs)} ` +
      `over ${r.ticks} tick(s) and ${r.turnsSettled} settled turn(s), on commit \`${r.commit}\`.`,
    '',
    '| Measure | This run |',
    '| --- | --- |',
    `| Ideas voiced | ${r.ideasVoiced} |`,
    `| Ideas covered | ${coveredCell(r.ideasCovered, r.ideasVoiced)} |`,
    `| Topic headings opened | ${r.topicHeadings} |`,
    `| Longest flat run of bullets | ${r.longestFlatRun} of ${r.bullets} bullet(s) |`,
    `| Bullets this meeting wrote | ${r.bulletsWritten} of ${r.bullets} in the document |`,
    `| Tidy-up | ${tidyLine(r.tidy)} |`,
    `| Billed | $${r.billedUsd.toFixed(4)} over ${r.billedCalls} model call(s)${
      r.unpricedModels.length > 0 ? ` — short: no price for ${r.unpricedModels.join(', ')}` : ''
    } |`,
    `| Latency to first note | ${firstNoteLine(r.firstNoteMs)} |`,
    `| Bullets on an unnamed voice | ${r.unnamedVoiceBullets} of ${r.bullets} bullet(s)${
      r.unnamedVoiceLabels.length > 0 ? ` — ${r.unnamedVoiceLabels.join(', ')}` : ''
    } |`,
    '',
    '## Coverage, both ways of counting it',
    '',
    ...coverageTable(r),
    '',
    ...(before === undefined ? [] : [...renderComparison(before, r), '']),
    `Notes: \`${r.notesPath}\``,
    `What this meeting wrote: \`${r.writtenNotesPath}\``,
    `Run log: \`${r.logPath}\``,
    '',
  ].join('\n');
}
