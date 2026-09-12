/**
 * "Choose what you have time for": the fill bar on the all-workspaces page,
 * in the cross-board review, and on a board's Home — one control, one stored
 * choice.
 *
 * Cumulative and single-choice: Easy shows easy items, Medium easy and
 * medium, Hard everything. Every stop up to the chosen one is filled in one
 * colour, with no knob (the owner's comment on the mock: "The dual tone is
 * confusing").
 *
 * The choice is a stored PREFERENCE, never a media query: a phone and an iPad
 * are the same person with different amounts of time, and width does not say
 * which (design-mobile.md). It starts on Hard.
 */
import { type ReviewSize, parseReviewSize, sizeAllowed } from '@claude-workspaces/core';
import type { BootStorage } from './boot-env.ts';

export const SIZE_PREF_KEY = 'cw.reviewSize';
export const DEFAULT_REVIEW_SIZE: ReviewSize = 'hard';

export const REVIEW_SIZE_LABELS: Readonly<Record<ReviewSize, { label: string; hint: string }>> = {
  easy: { label: 'Easy', hint: '< 1 min' },
  medium: { label: 'Medium', hint: '< 5 min' },
  hard: { label: 'Hard', hint: 'any' },
};

/** The stored choice, or Hard. A blocked storage reads as no choice. */
export function readSizePref(storage: BootStorage): ReviewSize {
  try {
    return parseReviewSize(storage.getItem(SIZE_PREF_KEY)) ?? DEFAULT_REVIEW_SIZE;
  } catch {
    return DEFAULT_REVIEW_SIZE;
  }
}

export function writeSizePref(storage: BootStorage, size: ReviewSize): void {
  try {
    storage.setItem(SIZE_PREF_KEY, size);
  } catch {
    // Private mode: the choice lasts this page and no longer.
  }
}

/** Paint `level` onto a bar: that stop active, it and every smaller one filled. */
export function paintFillBar(bar: ParentNode, level: ReviewSize): void {
  for (const b of bar.querySelectorAll<HTMLElement>('[data-size]')) {
    const size = parseReviewSize(b.dataset.size);
    if (!size) continue;
    const on = size === level;
    b.classList.toggle('board-tab-active', on);
    b.classList.toggle('filled', sizeAllowed(size, level));
    b.setAttribute('aria-checked', String(on));
  }
}

/** Route a click inside a bar to `onPick`, when it landed on a stop. */
export function onFillBarPick(bar: HTMLElement, onPick: (size: ReviewSize) => void): () => void {
  const handler = (ev: Event) => {
    const t = (ev.target as Element | null)?.closest?.('[data-size]') as HTMLElement | null;
    const size = t ? parseReviewSize(t.dataset.size) : null;
    if (size) onPick(size);
  };
  bar.addEventListener('click', handler);
  return () => bar.removeEventListener('click', handler);
}

/** Total minutes of the items a level lets through. */
export function totalMinutes(
  items: ReadonlyArray<{ size: ReviewSize; minutes: number }>,
  level: ReviewSize,
): number {
  return items.reduce((n, i) => (sizeAllowed(i.size, level) ? n + i.minutes : n), 0);
}
