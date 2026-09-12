/**
 * How long a review item will take a person, and which of the three sizes
 * that puts it in.
 *
 * Bryan runs several boards and, when low on energy, picks whatever is in
 * front of him rather than the top priority. Sizing lets him say "only what
 * I have time for" and still walk the queue in priority order. The rates are
 * his (task on the cross-board review flow, 2026-09-12): reading at 150 words
 * a minute, typing at 60, and about a minute per mock page or diff file.
 *
 * Pure, and computed on READ from the item as it stands: a revision that
 * rewrites the detail re-sizes the item, with nothing stored to go stale.
 * The server resolves the linked documents (word counts, mock pages, diff
 * files) because only it holds them; everything else is arithmetic here, so
 * the client and the server cannot disagree about a size.
 */
import { wordCount } from './word-count.ts';

export type ReviewSize = 'easy' | 'medium' | 'hard';

/** Smallest first. The filter is cumulative, so this order IS the filter. */
export const REVIEW_SIZES: readonly ReviewSize[] = ['easy', 'medium', 'hard'];

export const READING_WPM = 150;
export const TYPING_WPM = 60;
/** Words a reply that is not an option pick is assumed to take. */
export const TYPED_REPLY_WORDS = 30;
/** Minutes per mock page and per diff file. */
export const MINUTES_PER_PAGE = 1;

export interface ReviewSizeInput {
  headline: string;
  detail?: string;
  /** The asker's candidates. Any at all means the reply can be a tap. */
  options?: ReadonlyArray<{ label: string; detail?: string }>;
  /** Words in the documents the detail links to. */
  linkedDocWords?: number;
  /** Mock pages the detail links to. */
  mockPages?: number;
  /** Diff files the detail links to. */
  diffFiles?: number;
}

export interface ReviewSizeEstimate {
  /** Whole minutes, at least one: the number the total adds up. */
  minutes: number;
  size: ReviewSize;
}

/** Under one minute is easy, under five medium, anything else hard. */
export function sizeOfMinutes(rawMinutes: number): ReviewSize {
  if (rawMinutes < 1) return 'easy';
  if (rawMinutes < 5) return 'medium';
  return 'hard';
}

export function reviewSize(input: ReviewSizeInput): ReviewSizeEstimate {
  const options = input.options ?? [];
  const readWords =
    wordCount(input.headline) +
    wordCount(input.detail ?? '') +
    options.reduce((n, o) => n + wordCount(o.label) + wordCount(o.detail ?? ''), 0) +
    Math.max(0, input.linkedDocWords ?? 0);
  const typedWords = options.length > 0 ? 0 : TYPED_REPLY_WORDS;
  const pages = Math.max(0, input.mockPages ?? 0) + Math.max(0, input.diffFiles ?? 0);
  const raw = readWords / READING_WPM + typedWords / TYPING_WPM + pages * MINUTES_PER_PAGE;
  return { minutes: Math.max(1, Math.ceil(raw)), size: sizeOfMinutes(raw) };
}

/** Whether an item of `size` shows when the reader chose `level`:
 *  Easy shows easy, Medium adds medium, Hard shows everything. */
export function sizeAllowed(size: ReviewSize, level: ReviewSize): boolean {
  return REVIEW_SIZES.indexOf(size) <= REVIEW_SIZES.indexOf(level);
}

/** A stored or requested level, or null when it names none. */
export function parseReviewSize(value: unknown): ReviewSize | null {
  return value === 'easy' || value === 'medium' || value === 'hard' ? value : null;
}
