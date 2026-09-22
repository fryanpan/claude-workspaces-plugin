/**
 * The two fidelity readings, driven over notes written by hand in the shapes
 * the composer produced before and after the change.
 *
 * The done-when lines this file holds: a dictation with "page", "start
 * with", "then" and "last" comes out as an ordered list under a heading in
 * the speaker's words, and the eval asserts the order; and cause retention is
 * scored per idea, 100% on the after shape and below it on the before shape.
 * The live composer's scores are `bun run notes:fidelity`, which costs money
 * and so is not a test.
 *
 * All notes are invented. The repo is public.
 */
import { describe, expect, it } from 'vitest';
import { BECAUSE_IDEAS, DICTATED_PAGES, DICTATION_TICKS } from './notes-fidelity-dictation.ts';
import { causeRetention, pageOrderScore, readPage } from './notes-fidelity-score.ts';

/** The after shape: each page a numbered list in the dictated order. */
const AFTER = [
  '## Page one: Riverbend street repairs',
  '1. Pothole count at the top, because the city reports monitor it',
  '2. List of streets to repave this summer',
  '3. Cost per block for each street',
  '   - The high street before the harbour road, because the number nine bus runs there',
  '4. Crew schedule for June and July',
  '## Page two: Saltmarsh flooding',
  '1. Map of the three drains that overflow',
  '2. Complaints from the harbour office, totals by month',
  '   - Keep the costs in one table, because the council only reads the totals',
  '3. Ask the council for forty thousand for new drain gates',
].join('\n');

/** The before shape: topics of the model's own, dashes, reasons apart. */
const BEFORE = [
  '## Riverbend Street Repairs',
  '- Streets to repave this summer',
  '- Pothole count leads the list',
  '  - The city reports monitor it',
  '- Crew schedule for June and July',
  '## Costs',
  '- Cost per block for each street',
  '- Keep costs in one table',
  '- Council reads only totals',
  '## Saltmarsh Flooding',
  '- Map of the three drains that overflow',
  '- High street before the harbour road, because the number nine bus runs there',
].join('\n');

describe('the dictation fixture', () => {
  it('says each of the layout words the done-when names', () => {
    const text = DICTATION_TICKS.flatMap((t) => t.turns.map((u) => u.text)).join(' ');
    for (const word of ['Page one', 'Start with', 'Then', 'The last thing']) {
      expect(text).toContain(word);
    }
  });
});

describe('page order', () => {
  it('keeps both pages of the after shape, in the dictated order', () => {
    const score = pageOrderScore(AFTER, DICTATED_PAGES);
    expect(score.pages.map((p) => p.why)).toEqual(['kept', 'kept']);
    expect(score.share).toBe(1);
  });

  it('keeps neither page of the before shape', () => {
    expect(pageOrderScore(BEFORE, DICTATED_PAGES).kept).toBe(0);
  });

  it('loses a page whose items are out of the dictated order', () => {
    const reordered = [
      '## Page one: Riverbend street repairs',
      '1. Cost per block for each street',
      '2. List of streets to repave this summer',
      '3. Crew schedule for June and July',
    ].join('\n');
    expect(readPage(reordered, DICTATED_PAGES[0]!).why).toBe('items out of the dictated order');
  });

  it('loses a page whose items are dashes, or whose list a note splits', () => {
    const dashes = AFTER.replace(/^\d\. /gm, '- ');
    expect(readPage(dashes, DICTATED_PAGES[0]!).why).toBe('items are not a numbered list');
    const split = AFTER.replace('   - The high street before', '- The high street before');
    expect(readPage(split, DICTATED_PAGES[0]!).why).toBe(
      'a note between two items breaks the numbered list',
    );
  });

  it("loses a page whose heading is not in the speaker's words", () => {
    const bare = AFTER.replace('## Page one: Riverbend street repairs', '## Page one');
    expect(readPage(bare, DICTATED_PAGES[0]!).why).toBe('no heading names the page');
  });
});

describe('cause retention, per idea', () => {
  it('retains every reason in the after shape', () => {
    const score = causeRetention(AFTER, BECAUSE_IDEAS);
    expect(score.ideas.map((i) => i.bullet !== null)).toEqual([true, true, true]);
    expect(score.share).toBe(1);
  });

  it('scores below that on the before shape, naming the reasons set apart', () => {
    const score = causeRetention(BEFORE, BECAUSE_IDEAS);
    expect(score.share).toBeLessThan(1);
    expect(
      score.ideas.map((i) => (i.bullet ? 'retained' : i.claimed ? 'apart' : 'missing')),
    ).toEqual(['apart', 'retained', 'apart']);
  });
});
