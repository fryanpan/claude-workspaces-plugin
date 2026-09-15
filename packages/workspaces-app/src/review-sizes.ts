/**
 * "Choose what you have time for": the fill bar in the cross-board review —
 * one control, one stored choice. **Off by default** (the owner, 2026-09-14:
 * it went unused, and its time estimates were far off), behind
 * `chooseDifficultyOn`; with it off the walk shows every item and no size or
 * time anywhere.
 *
 * Cumulative and single-choice: Easy shows easy items, Medium easy and
 * medium, Hard everything. Every stop up to the chosen one is filled in one
 * colour, with no knob (the owner's comment on the mock: "The dual tone is
 * confusing").
 *
 * The choice is a stored PREFERENCE, never a media query: a phone and an iPad
 * are the same person with different amounts of time, and width does not say
 * which (design-mobile.md). It starts on Hard.
 *
 * It belongs to the signed-in person, so the server holds it
 * (`/api/review-size`) and the choice made on the iPad is the one the phone
 * opens on. localStorage is only a cache: it paints the bar before the server
 * answers, and it is all there is for somebody not signed in.
 */
import { type ReviewSize, parseReviewSize } from '@claude-workspaces/core';
import type { BootStorage } from './boot-env.ts';

export const SIZE_PREF_KEY = 'cw.reviewSize';
export const DEFAULT_REVIEW_SIZE: ReviewSize = 'hard';

/** The stops' words. No minutes: the estimates were far off, so the flow
 *  names a size and never a time. */
export const REVIEW_SIZE_LABELS: Readonly<Record<ReviewSize, string>> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
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

/** The browser flag that brings choose-difficulty back: `on` under this key. */
export const CHOOSE_DIFFICULTY_FLAG_KEY = 'cw.flag.chooseDifficulty';

/** Whether this browser turned choose-difficulty on. Absent, anything but
 *  `on`, or a blocked storage is off. */
export function chooseDifficultyOn(storage: BootStorage): boolean {
  try {
    return storage.getItem(CHOOSE_DIFFICULTY_FLAG_KEY) === 'on';
  } catch {
    return false;
  }
}

/** Where the signed-in person's choice lives. */
export interface SizePrefRemote {
  /** Their stored choice, or null for none / not signed in / unreachable. */
  load(): Promise<ReviewSize | null>;
  /** Best effort: a refusal (not signed in) leaves the cache as the record. */
  save(size: ReviewSize): Promise<void>;
}

export function httpSizePref(fetchFn: typeof fetch = fetch): SizePrefRemote {
  return {
    async load() {
      try {
        const res = await fetchFn('/api/review-size');
        if (!res.ok) return null;
        return parseReviewSize(((await res.json()) as { size?: unknown }).size);
      } catch {
        return null;
      }
    },
    async save(size) {
      try {
        await fetchFn('/api/review-size', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ size }),
        });
      } catch {
        // Offline: the cache keeps it on this device until the next pick.
      }
    },
  };
}

export interface SizeChoice {
  level(): ReviewSize;
  pick(size: ReviewSize): void;
}

/**
 * The choice a page works from: the cache at once, then the account's once
 * the server answers — unless the reader has already picked on this page,
 * which is newer than anything the server could say. `onChange` runs only
 * for the server's answer; a pick's caller repaints for itself.
 */
export function createSizeChoice(
  storage: BootStorage,
  remote: SizePrefRemote,
  onChange: (size: ReviewSize) => void,
): SizeChoice {
  let level = readSizePref(storage);
  let picked = false;
  void remote.load().then((stored) => {
    if (!stored || picked || stored === level) return;
    level = stored;
    writeSizePref(storage, stored);
    onChange(stored);
  });
  return {
    level: () => level,
    pick(size) {
      picked = true;
      level = size;
      writeSizePref(storage, size);
      void remote.save(size);
    },
  };
}
