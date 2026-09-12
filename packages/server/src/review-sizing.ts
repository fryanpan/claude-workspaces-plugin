/**
 * Puts a size on every review item row, from the item and what it links to.
 *
 * The arithmetic is `reviewSize` in core. This module supplies the inputs only
 * the server holds: how many words a linked document has, and how many files
 * a linked diff review spans. A link to a mock counts as one page.
 *
 * Linked-document words are ESTIMATED from the doc's plain-text length at six
 * characters a word (five letters and a space), because `getDocStatus` reads
 * that length without rendering the body. The count is memoised per doc for
 * ten minutes, so a queue read over many boards opens each linked doc at most
 * once in that window rather than on every read.
 */
import {
  type ReviewPayload,
  type ReviewSize,
  type ReviewSizeEstimate,
  extractWorkspaceLinks,
  reviewSize,
} from '@claude-workspaces/core';
import type { ReviewItemRow } from './review-queue.ts';

export const CHARS_PER_WORD = 6;
const DOC_WORDS_TTL_MS = 10 * 60_000;

/** What sizing reads from the doc store. */
export interface ReviewSizingSource {
  /** Plain-text length of a doc, or null when there is no such doc. */
  textLength(docId: string): number | null;
  /** Files in an attachment set (a diff review), or 0 when unknown. */
  filesInSet(setId: string): number;
}

export type SizedReviewItemRow = ReviewItemRow & { minutes: number; size: ReviewSize };

/** The size one row's own words and links add up to. */
export function sizeRow(
  row: { review?: ReviewPayload; ask: string },
  resolve: { docWords(docId: string): number; setFiles(setId: string): number },
): ReviewSizeEstimate {
  const review = row.review;
  const detail = review?.detail ?? '';
  let linkedDocWords = 0;
  let mockPages = 0;
  let diffFiles = 0;
  for (const { link } of extractWorkspaceLinks(detail)) {
    if (link.kind === 'doc') linkedDocWords += resolve.docWords(link.docId);
    else if (link.kind === 'mockup') mockPages += 1;
    else if (link.kind === 'review') diffFiles += Math.max(1, resolve.setFiles(link.reviewId));
  }
  return reviewSize({
    headline: review?.headline ?? row.ask,
    detail,
    ...(review?.options ? { options: review.options } : {}),
    linkedDocWords,
    mockPages,
    diffFiles,
  });
}

/** What `createReviewSizer` hands back: one size, or a whole row list. */
export interface ReviewSizer {
  one(row: { review?: ReviewPayload; ask: string }): ReviewSizeEstimate;
  rows(rows: ReviewItemRow[]): SizedReviewItemRow[];
}

/** A sizer that remembers doc word counts across reads. One per server. */
export function createReviewSizer(
  source: ReviewSizingSource,
  now: () => number = Date.now,
): ReviewSizer {
  const words = new Map<string, { at: number; words: number }>();
  const docWords = (docId: string): number => {
    const t = now();
    const hit = words.get(docId);
    if (hit && t - hit.at < DOC_WORDS_TTL_MS) return hit.words;
    const length = source.textLength(docId);
    const count = length === null ? 0 : Math.ceil(length / CHARS_PER_WORD);
    words.set(docId, { at: t, words: count });
    return count;
  };
  const one = (row: { review?: ReviewPayload; ask: string }) =>
    sizeRow(row, { docWords, setFiles: (id) => source.filesInSet(id) });
  return {
    one,
    rows: (rows) =>
      rows.map((row) => {
        const est = one(row);
        return { ...row, minutes: est.minutes, size: est.size };
      }),
  };
}
