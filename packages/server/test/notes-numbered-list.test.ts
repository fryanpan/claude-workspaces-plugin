/**
 * An order the speaker dictated is structure, not a wall: a numbered list is
 * never read as a flat run to regroup, by the stop-time check or by the
 * per-tick scan, while the same notes as dashes still are.
 *
 * All notes are invented. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { NOTES_AUTHOR_ID } from '../src/notes-doc-access.ts';
import { MAX_FLAT_RUN_BULLETS, flatBulletRuns, longFlatRuns } from '../src/notes-quality.ts';
import { scanRuns } from '../src/notes-regroup.ts';
import { bullet, heading } from './notes-regroup-fixtures.ts';

const COUNT = MAX_FLAT_RUN_BULLETS + 2;
const items = Array.from({ length: COUNT }, (_, i) => `Riverbend item ${i + 1}`);

describe('the stop-time flat-run check', () => {
  it('reads a long dash list as a flat run, and the same list numbered as none', () => {
    const dashes = ['## Page one', ...items.map((t) => `- ${t}`)].join('\n');
    const numbered = ['## Page one', ...items.map((t, i) => `${i + 1}. ${t}`)].join('\n');
    expect(longFlatRuns(dashes)).toHaveLength(1);
    expect(flatBulletRuns(numbered)).toEqual([]);
  });
});

describe('the per-tick regroup scan', () => {
  it('asks to regroup a long dash run and leaves the numbered one alone', () => {
    const h = heading('Page one');
    const dashes = [h, ...items.map((t) => bullet(t, { under: h.id }))];
    const numbered = [
      h,
      ...items.map((t) => ({ ...bullet(t, { under: h.id }), ordered: true as const })),
    ];
    expect(scanRuns(dashes, { author: NOTES_AUTHOR_ID }).targets).toHaveLength(1);
    expect(scanRuns(numbered, { author: NOTES_AUTHOR_ID }).targets).toEqual([]);
  });
});
