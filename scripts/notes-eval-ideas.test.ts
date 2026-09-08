/**
 * The gate's arithmetic, which is the part of `notes-eval-ideas.ts` that
 * decides whether a push is red.
 *
 * The model halves — listing the ideas, judging which survived — are not
 * testable without a network and are not tested here. What IS testable is
 * every way the verdict can be wrong while looking right: a rate computed off
 * an empty sample, a partial judge reply scored as loss, and a gate that
 * passes because it measured nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_LOST_IDEA_RATE,
  MIN_GATED_IDEAS,
  type MeetingIdeaRate,
  rateOf,
  reportIdeaRates,
} from './notes-eval-ideas.ts';

const row = (meeting: string, ideas: number, lost: number): MeetingIdeaRate => ({
  meeting,
  ideas,
  lost,
  unjudged: 0,
  examples: [],
});

/** Run the report with its console silenced, and give back the exit code. */
function verdict(rows: MeetingIdeaRate[], gate: boolean): number {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    return reportIdeaRates(rows, gate);
  } finally {
    log.mockRestore();
  }
}

describe('the lost-idea rate', () => {
  it('is loss over ideas, and zero when nothing was measured', () => {
    expect(rateOf({ ideas: 100, lost: 4 })).toBeCloseTo(0.04);
    expect(rateOf({ ideas: 0, lost: 0 })).toBe(0);
  });

  it('passes under the bar and fails over it, on the WHOLE corpus', () => {
    // Four in a hundred passes; six fails. And the verdict is the overall
    // rate, not the worst meeting: a short meeting that lost one idea of
    // three must not fail a corpus that is otherwise clean.
    expect(verdict([row('a', 200, 8)], true)).toBe(0);
    expect(verdict([row('a', 200, 12)], true)).toBe(1);
    expect(verdict([row('a', 200, 2), row('b', 3, 1)], true)).toBe(0);
  });

  it('reports without gating on a sample too thin to hold the bar', () => {
    // The CI smoke slice is three ticks of one meeting. One judgement call
    // about one bullet is twelve per cent of eight ideas, and a gate that
    // goes red on that gets turned off rather than read.
    expect(verdict([row('a', 8, 8)], true)).toBe(0);
    expect(verdict([row('a', MIN_GATED_IDEAS, MIN_GATED_IDEAS)], true)).toBe(1);
  });

  it('fails a gated run that measured nothing at all', () => {
    // The failure this whole change is about, in miniature: a check that
    // cannot fail reads exactly like a check that passed. No ground truth
    // means no verdict, and no verdict is not a pass.
    expect(verdict([], true)).toBe(1);
    // Ungated, the same absence is a report and nothing more.
    expect(verdict([], false)).toBe(0);
  });

  it('never fails an ungated run, however bad the rate', () => {
    expect(verdict([row('a', 10, 10)], false)).toBe(0);
  });

  it('states the bar the row asked for', () => {
    expect(MAX_LOST_IDEA_RATE).toBe(0.05);
  });
});
