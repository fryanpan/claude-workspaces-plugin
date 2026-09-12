import { describe, expect, it } from 'bun:test';
import type { ReviewPayload } from '@claude-workspaces/core';
import { CHARS_PER_WORD, createReviewSizer, sizeRow } from '../src/review-sizing.ts';

const pick = (detail: string): { review: ReviewPayload; ask: string } => ({
  ask: 'Pick one',
  review: {
    shape: 'decision',
    headline: 'Which tide table should Saltmarsh show?',
    detail,
    options: [
      { id: 'a', label: 'Harbour gauge' },
      { id: 'b', label: 'Offshore buoy' },
    ],
  },
});

const noLinks = { docWords: () => 0, setFiles: () => 0 };

describe('sizeRow', () => {
  it('reads a linked doc at its word count', () => {
    const row = pick('Background is in [the plan](/workspaces/w-salt/docs/d-plan).');
    expect(sizeRow(row, noLinks).size).toBe('easy');
    const long = sizeRow(row, {
      docWords: (id) => (id === 'd-plan' ? 1500 : 0),
      setFiles: () => 0,
    });
    expect(long).toEqual({ minutes: 11, size: 'hard' });
  });

  it('adds a page per mock and a page per file in a linked diff review', () => {
    const mock = pick('See /workspaces/w-salt/mockups/m-tides for the layout.');
    expect(sizeRow(mock, noLinks)).toEqual({ minutes: 2, size: 'medium' });
    const diff = pick('The change is at /workspaces/w-salt/attachments/set-tides.');
    expect(sizeRow(diff, { docWords: () => 0, setFiles: () => 6 })).toEqual({
      minutes: 7,
      size: 'hard',
    });
    // A diff whose files are not known still costs a page, never zero.
    expect(sizeRow(diff, noLinks)).toEqual({ minutes: 2, size: 'medium' });
  });

  it('charges a typed reply on an inferred row with no payload', () => {
    expect(sizeRow({ ask: 'Can you check the harbour copy?' }, noLinks)).toEqual({
      minutes: 1,
      size: 'easy',
    });
  });
});

describe('createReviewSizer', () => {
  it('estimates doc words from text length and remembers them for ten minutes', () => {
    let reads = 0;
    let clock = 0;
    const sizer = createReviewSizer(
      {
        textLength: () => {
          reads += 1;
          return 900 * CHARS_PER_WORD;
        },
        filesInSet: () => 0,
      },
      () => clock,
    );
    const row = pick('Read /workspaces/w-salt/docs/d-plan first.');
    expect(sizer.one(row)).toEqual({ minutes: 7, size: 'hard' });
    sizer.one(row);
    expect(reads).toBe(1);
    clock += 10 * 60_000;
    sizer.one(row);
    expect(reads).toBe(2);
  });
});
