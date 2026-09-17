/**
 * What a meeting's quality reading SAYS, as something two readings can be
 * compared on — and the rule for when the difference is worth re-asking a
 * person about.
 *
 * WHY THIS IS NOT THE RENDERED WORDS. The filer used to compare the headline
 * and detail already on the item. Every leg of one meeting sees a longer
 * transcript, so any number those strings interpolate differs at every stop
 * while the reading says the same thing, and the comparison suppressed
 * nothing. The first fix compared the FLAGS instead, which closed the
 * unreadable path — its flag text carries no number — and left the commonest
 * path open, because `buildFlags` puts numbers in the other six.
 *
 * A RATIO MOVING IS THE DENOMINATOR TALKING; A COUNT MOVING IS THE MEETING
 * TALKING. That is the distinction this module is built on and it is the
 * whole design:
 *
 *   - A **count** — repeated bullets, topics opened twice, walls of bullets,
 *     voices the meeting never had — goes up because something new happened
 *     in the notes. A second repeated bullet is a second defect, and its
 *     reader should hear about it. Counts are compared exactly.
 *   - A **ratio** — the uncovered share, the late share — moves whenever the
 *     denominator moves, which on a multi-leg meeting is every leg. Held to
 *     the same note-taking quality throughout, a six-leg meeting's uncovered
 *     share still wanders a point or two per leg as pure sampling noise.
 *     Ratios are compared with a band.
 *
 * The denominator a count carries is NOT part of the verdict for the same
 * reason. "4 repeated bullets of 5" becomes "4 repeated bullets of 7" when
 * the notes grow, and the four defects are the same four.
 *
 * AND THE BAND IS AGAINST THE FILED VALUE, not against the previous reading.
 * Comparing consecutive readings lets 45, 50, 55, 60 slide past a ten-point
 * band in three steps that each clear it, and the item ends up fifteen points
 * out of date having never been revised. Comparing against what the item
 * currently SAYS is what makes a slow ramp eventually cross.
 */

import type { NotesQualityFlag, NotesQualityReport } from './notes-quality-report.ts';
import { REVISE_RATIO_BAND } from './notes-quality-thresholds.ts';

type FlagKind = NotesQualityFlag['kind'];

/**
 * One reading's verdict: which bars it went past, and the number behind each
 * one in the form the comparison needs rather than the form a reader sees.
 */
export interface NotesQualityVerdict {
  /** The bars this reading went past, in the order they are raised. */
  kinds: FlagKind[];
  /** The exact count behind each counting flag. Compared exactly. */
  counts: Partial<Record<FlagKind, number>>;
  /** The raw share behind each rate flag, unrounded. Compared with a band. */
  ratios: Partial<Record<FlagKind, number>>;
}

/**
 * The verdict a reading came to.
 *
 * Read off the REPORT rather than off the flag text, so that the numbers this
 * compares are the measurements themselves and not a rounded rendering of
 * them. A percentage that a reader sees as "50%" is 0.4951 here, and two
 * readings a tenth of a point apart are not made different by the rounding.
 */
export function verdictOf(report: NotesQualityReport): NotesQualityVerdict {
  const counts: Partial<Record<FlagKind, number>> = {};
  const ratios: Partial<Record<FlagKind, number>> = {};
  const kinds: FlagKind[] = [];
  for (const flag of report.flags) {
    kinds.push(flag.kind);
    switch (flag.kind) {
      case 'duplicate-bullets':
        counts[flag.kind] = report.duplicateBulletLines;
        break;
      case 'duplicate-headings':
        counts[flag.kind] = report.duplicateHeadings.length;
        break;
      case 'flat-runs':
        counts[flag.kind] = report.longRuns.length;
        break;
      case 'unknown-speakers':
        counts[flag.kind] = report.unknownVoices.length;
        break;
      case 'coverage':
        // Non-null whenever this flag is raised: the bar it crossed is a
        // comparison against the share.
        if (report.coverage.uncoveredShare !== null)
          ratios[flag.kind] = report.coverage.uncoveredShare;
        break;
      case 'late':
        if (report.lateness.lateShare !== null) ratios[flag.kind] = report.lateness.lateShare;
        break;
      case 'notes-unread':
        // Deliberately numberless. The reading could not be read; how much
        // was said while it could not be read is not a different verdict.
        break;
    }
  }
  return { kinds, counts, ratios };
}

/**
 * Whether `next` is a different verdict from the one an item already
 * carries — the question "is this worth re-asking about", not "are these two
 * readings identical".
 *
 * `filed` is what the standing item SAYS, which is why the caller keeps it
 * across legs rather than keeping the previous reading. See the module
 * header.
 */
export function verdictChanged(filed: NotesQualityVerdict, next: NotesQualityVerdict): boolean {
  if (filed.kinds.length !== next.kinds.length) return true;
  if (filed.kinds.some((kind, i) => kind !== next.kinds[i])) return true;
  for (const kind of next.kinds) {
    // A count is exact: it went up because the notes gained a defect.
    if (next.counts[kind] !== filed.counts[kind]) return true;
    const to = next.ratios[kind];
    const from = filed.ratios[kind];
    if (to === undefined || from === undefined) {
      // One reading had a share and the other did not, under the same flag.
      if (to !== from) return true;
      continue;
    }
    // STRICTLY GREATER, deliberately: a move of exactly the band does not
    // revise. "More than its own band" is the rule, the band is a noise
    // floor rather than a boundary anything real sits on, and the tie going
    // to the reader's quiet is the direction this whole module leans. On the
    // record so it reads as a decision rather than an off-by-one.
    if (Math.abs(to - from) > REVISE_RATIO_BAND) return true;
  }
  return false;
}
