import { describe, expect, it } from 'vitest';
import { parseReviewSize, reviewSize, sizeAllowed, sizeOfMinutes } from './review-size.ts';

const words = (n: number): string => Array.from({ length: n }, () => 'word').join(' ');

describe('reviewSize', () => {
  it('sizes a short option pick as easy: reading only, no typing', () => {
    const est = reviewSize({
      headline: 'Which forecast source should the digest use?',
      detail: words(40),
      options: [{ label: 'Coastal feed' }, { label: 'National feed' }],
    });
    expect(est).toEqual({ minutes: 1, size: 'easy' });
  });

  it('charges thirty typed words at 60 wpm when there is nothing to tap', () => {
    // 7 read words is ~0.05 min; the typed reply alone is half a minute.
    expect(reviewSize({ headline: 'How early should a delay alert go?' })).toEqual({
      minutes: 1,
      size: 'easy',
    });
    // 90 read words (0.6) + 30 typed (0.5) crosses one minute.
    expect(reviewSize({ headline: 'Look', detail: words(89) }).size).toBe('medium');
  });

  it('reads linked documents at 150 wpm', () => {
    const est = reviewSize({
      headline: 'Approve the plan',
      options: [{ label: 'Yes' }],
      linkedDocWords: 3000,
    });
    expect(est.size).toBe('hard');
    expect(est.minutes).toBe(21);
  });

  it('adds a minute per mock page and per diff file', () => {
    const base = { headline: 'Check it', options: [{ label: 'Fine' }] };
    expect(reviewSize({ ...base, mockPages: 2 })).toEqual({ minutes: 3, size: 'medium' });
    expect(reviewSize({ ...base, mockPages: 2, diffFiles: 3 })).toEqual({
      minutes: 6,
      size: 'hard',
    });
  });

  it('re-sizes when the detail is revised', () => {
    const before = reviewSize({ headline: 'Q', options: [{ label: 'A' }], detail: words(10) });
    const after = reviewSize({ headline: 'Q', options: [{ label: 'A' }], detail: words(1000) });
    expect(before.size).toBe('easy');
    expect(after.size).toBe('hard');
  });
});

describe('sizes', () => {
  it('puts the boundaries at one and five minutes', () => {
    expect(sizeOfMinutes(0.99)).toBe('easy');
    expect(sizeOfMinutes(1)).toBe('medium');
    expect(sizeOfMinutes(4.99)).toBe('medium');
    expect(sizeOfMinutes(5)).toBe('hard');
  });

  it('filters cumulatively', () => {
    expect(sizeAllowed('easy', 'easy')).toBe(true);
    expect(sizeAllowed('medium', 'easy')).toBe(false);
    expect(sizeAllowed('medium', 'medium')).toBe(true);
    expect(sizeAllowed('hard', 'medium')).toBe(false);
    expect(sizeAllowed('hard', 'hard')).toBe(true);
  });

  it('parses only the three names', () => {
    expect(parseReviewSize('medium')).toBe('medium');
    expect(parseReviewSize('huge')).toBeNull();
    expect(parseReviewSize(undefined)).toBeNull();
  });
});
