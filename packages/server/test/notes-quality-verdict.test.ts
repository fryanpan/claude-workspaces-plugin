/**
 * What counts as a different verdict, driven directly rather than through the
 * filer.
 *
 * The filer's own cases prove the behaviour a reader sees — one item, revised
 * when the meeting has something new to say. These prove the rule underneath
 * it, including the two asymmetries that are easy to get backwards: a count
 * moving is news and a rate moving by the same visible amount is not, and the
 * denominator a count is quoted against is not part of the verdict at all.
 *
 * Every fixture is invented. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { buildNotesQualityReport } from '../src/notes-quality-report.ts';
import { REVISE_RATIO_BAND } from '../src/notes-quality-thresholds.ts';
import { verdictChanged, verdictOf } from '../src/notes-quality-verdict.ts';

const SPOKEN = 'The Riverbend ferry timetable changed again in March.';
const UNNOTED = 'Harborlight slipway repairs slipped past the autumn window.';
const REPEAT = '- The Saltmarsh ferry keeps its winter crew until April';

/** A reading whose uncovered share is exactly `missed / total`. */
const atShare = (total: number, missed: number) =>
  verdictOf(
    buildNotesQualityReport({
      notes: `## Meeting notes\n- ${SPOKEN}`,
      transcript: [
        ...Array.from({ length: total - missed }, () => ({ text: SPOKEN })),
        ...Array.from({ length: missed }, () => ({ text: UNNOTED })),
      ],
    }),
  );

/** A reading with `repeats` copies of one bullet among `extra` other lines. */
const withRepeats = (repeats: number, extra = 0) =>
  verdictOf(
    buildNotesQualityReport({
      notes: [
        '## Meeting notes',
        ...Array.from({ length: repeats }, () => REPEAT),
        ...Array.from({ length: extra }, (_, i) => `- Berth ${i} was signed off`),
      ].join('\n'),
      transcript: [],
    }),
  );

describe('the verdict a reading came to', () => {
  it('carries the bars crossed and the number behind each', () => {
    const v = atShare(100, 60);
    expect(v.kinds).toEqual(['coverage']);
    expect(v.ratios.coverage).toBeCloseTo(0.6, 10);
    expect(v.counts.coverage).toBeUndefined();
  });

  it('gives an unreadable reading no number at all', () => {
    // The count of what was heard is not a second verdict about notes nobody
    // could read, and it is the number that grew at every leg on 2026-09-15.
    const v = verdictOf(
      buildNotesQualityReport({
        notes: '',
        transcript: Array.from({ length: 40 }, () => ({ text: SPOKEN })),
        notesRead: false,
      }),
    );
    expect(v.kinds).toEqual(['notes-unread']);
    expect(v.counts['notes-unread']).toBeUndefined();
    expect(v.ratios['notes-unread']).toBeUndefined();
  });
});

describe('whether a reading says something the item does not', () => {
  it('a different set of bars is always news', () => {
    expect(verdictChanged(atShare(100, 60), withRepeats(6))).toBe(true);
  });

  it('the same reading twice is not', () => {
    expect(verdictChanged(atShare(100, 60), atShare(100, 60))).toBe(false);
  });

  /* ===== A rate moving is the denominator talking ===== */

  it('holds a rate that moved less than the band', () => {
    expect(verdictChanged(atShare(100, 55), atShare(100, 60))).toBe(false);
  });

  it('reports a rate that moved more than the band', () => {
    expect(verdictChanged(atShare(100, 55), atShare(100, 85))).toBe(true);
  });

  it('puts the boundary exactly where the band says', () => {
    // Just inside and just outside, so the case fails if the band is read as
    // a different number or the comparison flips to >=.
    const band = Math.round(REVISE_RATIO_BAND * 100);
    expect(verdictChanged(atShare(1000, 550), atShare(1000, 550 + band * 10 - 1))).toBe(false);
    expect(verdictChanged(atShare(1000, 550), atShare(1000, 550 + band * 10 + 1))).toBe(true);
  });

  it('holds a move of EXACTLY the band, which is the decision on the record', () => {
    // Hand-built rather than built from two reports, because no pair of real
    // shares lands on the band exactly: 0.65 - 0.55 is 0.09999999999999998 in
    // binary floating point, which is inside the band whichever comparison is
    // used and so proves nothing about it. 0.1 - 0 is exactly 0.1, and it is
    // the only arrangement that tells `>` from `>=`.
    //
    // The rule is "more than its own band", so a move of exactly the band
    // does NOT revise: the band is a noise floor rather than a boundary
    // anything real sits on, and the tie goes to the reader's quiet.
    const at = (share: number) => ({
      kinds: ['coverage' as const],
      counts: {},
      ratios: { coverage: share },
    });
    expect(verdictChanged(at(0), at(REVISE_RATIO_BAND))).toBe(false);
    // And a hair past it does revise, so the case above cannot pass on a
    // comparison that has stopped firing altogether.
    expect(verdictChanged(at(0), at(REVISE_RATIO_BAND * 1.5))).toBe(true);
  });

  /* ===== A count moving is the meeting talking ===== */

  it('reports a count that moved by one', () => {
    // The asymmetry, stated: a rate moving five points is held above and a
    // count moving by one is news, because a sixth repeated bullet is a
    // sixth defect a reader has not been told about.
    expect(verdictChanged(withRepeats(5), withRepeats(6))).toBe(true);
  });

  it('holds a count whose DENOMINATOR moved but whose count did not', () => {
    // "4 repeated bullets of 5" becomes "4 repeated bullets of 7" when the
    // notes grow. The rendered words differ; the four defects are the same
    // four, and this is the half of the old flag-text comparison that made a
    // growing meeting revise its item for nothing.
    const before = withRepeats(5);
    const after = withRepeats(5, 6);
    expect(before.counts['duplicate-bullets']).toBe(after.counts['duplicate-bullets']);
    expect(verdictChanged(before, after)).toBe(false);
  });
});
