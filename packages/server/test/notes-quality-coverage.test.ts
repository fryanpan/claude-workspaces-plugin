/**
 * Did what was said reach a note — and the third state, which is the answer
 * for a reading that never got to look.
 *
 * The cases that matter here are the pair at the end: a reading that FAILED
 * and a meeting that genuinely wrote nothing produce the same notes text, and
 * before the third state they produced the same verdict too — 100% of
 * everything uncovered. One of those is a fact about a meeting and the other
 * is a fact about a reader, and a person cannot answer the second one.
 *
 * All notes and all speech here are invented and every name is fictional.
 * The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import {
  type SpokenTurn,
  contentWords,
  coverageOf,
  spokenIdeas,
  uncoveredIdeaCount,
} from '../src/notes-quality-coverage.ts';
import { MIN_IDEAS_FOR_COVERAGE } from '../src/notes-quality-thresholds.ts';

const said = (text: string): SpokenTurn => ({ text });

/* ===== The lexical reading ===== */

describe('spoken ideas and their coverage', () => {
  it('skips a sentence with nothing in it', () => {
    expect(spokenIdeas([said('Yeah. Right, exactly.')])).toEqual([]);
  });

  it('counts a sentence carrying content as one idea', () => {
    expect(spokenIdeas([said('The harbour ferry moves to the half hour.')])).toHaveLength(1);
  });

  it('calls an idea carried when the notes keep its words', () => {
    const notes = '- The harbour ferry moves to the half hour';
    const { uncovered } = uncoveredIdeaCount(notes, [
      said('So the harbour ferry moves to the half hour from Monday.'),
    ]);
    expect(uncovered).toBe(0);
  });

  it('calls an idea uncovered when the notes are about something else', () => {
    const notes = '- Kestrel Lane keeps its winter crew';
    const { uncovered } = uncoveredIdeaCount(notes, [
      said('So the harbour ferry moves to the half hour from Monday.'),
    ]);
    expect(uncovered).toBe(1);
  });

  it('calls every idea uncovered when there are no notes at all', () => {
    const transcript = [
      said('The harbour ferry moves to the half hour from Monday.'),
      said('Kestrel Lane keeps the winter crew until April.'),
    ];
    const { ideas, uncovered } = uncoveredIdeaCount('', transcript);
    expect(ideas).toBe(2);
    expect(uncovered).toBe(2);
  });

  it('reads two forms of one word as one word', () => {
    expect(contentWords('shipping')).toEqual(contentWords('shipped'));
  });
});

/* ===== The third state ===== */

/** Enough ideas that a share is worth computing, each about its own subject
 *  so nothing in them is accidentally covered. */
const LONG_MEETING: SpokenTurn[] = Array.from({ length: MIN_IDEAS_FOR_COVERAGE + 4 }, (_, i) => ({
  text: `Riverbend jetty number ${i} keeps its winter mooring until April.`,
}));

describe('a reading that could not read the notes', () => {
  it('says so rather than reporting that nothing was covered', () => {
    const failed = coverageOf('', LONG_MEETING, { read: false, missing: 'the doc was not there' });
    expect(failed.source).toBe('unreadable');
    expect(failed.uncoveredIdeas).toBeNull();
    expect(failed.uncoveredShare).toBeNull();
    expect(failed.missing).toBe('the doc was not there');
  });

  it('still counts the ideas, because the transcript was read either way', () => {
    const failed = coverageOf('', LONG_MEETING, { read: false });
    expect(failed.ideas).toBe(LONG_MEETING.length);
  });

  it('THE CONTROL: a meeting that genuinely wrote nothing still reads 100%', () => {
    // The same empty notes text and the same transcript. The ONLY difference
    // is whether the reading is claimed as a reading — so this pair is what
    // proves the third state discriminates rather than suppressing coverage
    // for everybody.
    const real = coverageOf('', LONG_MEETING, { read: true });
    expect(real.source).toBe('notes');
    expect(real.uncoveredIdeas).toBe(LONG_MEETING.length);
    expect(real.uncoveredShare).toBe(1);
  });

  it('a reading that found notes is judged on them as it always was', () => {
    const notes = LONG_MEETING.map((t) => `- ${t.text}`).join('\n');
    const good = coverageOf(notes, LONG_MEETING, { read: true });
    expect(good.source).toBe('notes');
    expect(good.uncoveredIdeas).toBe(0);
    expect(good.uncoveredShare).toBe(0);
  });

  it('holds its judgement on a share when there were too few ideas to judge', () => {
    const thin = coverageOf('', [said('The harbour ferry moves to the half hour.')], {
      read: true,
    });
    expect(thin.source).toBe('notes');
    expect(thin.uncoveredIdeas).toBe(1);
    expect(thin.uncoveredShare).toBeNull();
  });
});
