/**
 * The top of the all-workspaces page: what is waiting on you across every
 * board, sized, with one way in — and the projects in priority order.
 *
 * Approved mock (cross-board review task, 2026-09-12). Three decisions from
 * the owner's comments on it shape this file and are easy to undo by accident:
 *
 *  - **No counts.** The only numbers are the estimated total, each project's
 *    rank, and (in the flow) the position and the harder-items count. A row
 *    of "N for you" chips was the thing removed.
 *  - **The label stays put and only the number changes.** "Total estimated
 *    time: N min" — the number sits in a fixed-width span so moving the bar
 *    does not reflow the line.
 *  - **The bar starts on Hard** and remembers the reader's last choice in the
 *    browser (`landing.js`). The server paints Hard so the first frame is
 *    right before any script runs.
 *
 * Rendering only: the order is `cross-review-queue.ts`, the sentences are
 * `board-summary.ts`.
 */
import type { ReviewSize } from '@claude-workspaces/core';

export interface LandingReview {
  /** Every open item's size and minutes, in queue order. */
  items: ReadonlyArray<{ size: ReviewSize; minutes: number }>;
  /** Board id → 1-based project rank. */
  rankOf: ReadonlyMap<string, number>;
  /** Board id → the last hour in one sentence, when there is one. */
  summaryOf: (workspaceId: string) => string | undefined;
}

export const REVIEWS_HREF = '/reviews';

const STOPS: ReadonlyArray<{ size: ReviewSize; label: string; hint: string }> = [
  { size: 'easy', label: 'Easy', hint: '&lt; 1 min' },
  { size: 'medium', label: 'Medium', hint: '&lt; 5 min' },
  { size: 'hard', label: 'Hard', hint: 'any' },
];

/** The fill bar, painted at `level`: every stop up to it filled. Shared
 *  markup with the board's copy (`review-sizes.ts` in the app). */
export function renderFillBar(level: ReviewSize, labelledBy: string): string {
  const at = STOPS.findIndex((s) => s.size === level);
  const buttons = STOPS.map((s, i) => {
    const cls = ['board-tab', i <= at ? 'filled' : '', i === at ? 'board-tab-active' : '']
      .filter(Boolean)
      .join(' ');
    return `<button type="button" class="${cls}" data-size="${s.size}" role="radio" aria-checked="${i === at}">${s.label} <small>${s.hint}</small></button>`;
  }).join('');
  return `<div class="sizes review-sizes" role="radiogroup" aria-labelledby="${labelledBy}">${buttons}</div>`;
}

/** The review bar, or nothing when no item waits anywhere. */
export function renderReviewBar(review: LandingReview): string {
  if (review.items.length === 0) return '';
  const total = review.items.reduce((n, i) => n + i.minutes, 0);
  const sizes = JSON.stringify(review.items.map((i) => [i.size, i.minutes])).replace(
    /</g,
    '\\u003c',
  );
  return `<div class="allbar"><div class="allhead"><h2 class="alltitle">Review Items for You</h2></div><span class="sizes-label" id="sizes-label">Choose what you have time for:</span><div class="gorow">${renderFillBar('hard', 'sizes-label')}<span class="est">Total estimated time: <span class="est-n" id="est">${total}</span> min</span><a class="allgo" href="${REVIEWS_HREF}">Start review ›</a></div></div>
<script type="application/json" id="review-sizes">${sizes}</script>`;
}

/** "2 min ago" — the mock's spelling, grey after the summary. */
export function agoText(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} hr ago`;
  const days = Math.round(diff / 86_400_000);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

export const LANDING_REVIEW_CSS = `
.allbar{display:block;background:#fff8f2;border:1px solid #f5d9c2;border-radius:10px;padding:12px 14px;margin:10px 0 18px}
.allhead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.alltitle{flex:1;min-width:0;font-size:15px;font-weight:600;color:#1b1f23;margin:0;text-transform:none;letter-spacing:0;display:block}
.sizes-label{display:block;font-size:12px;color:#57606a;margin:8px 0 6px}
/* A fill bar: every stop up to the chosen one is filled, like a thermometer. */
.sizes{display:flex;gap:0;position:relative;background:#eef0f2;border-radius:99px;padding:3px;max-width:420px;width:100%}
.sizes .board-tab{flex:1;display:flex;align-items:center;justify-content:center;gap:4px;min-height:36px;padding:0 10px;border:none;border-radius:0;background:transparent;color:#57606a;font:inherit;font-size:13px;font-weight:600;position:relative;white-space:nowrap;cursor:pointer}
.sizes .board-tab small{font-size:11px;font-weight:400;color:inherit;opacity:.8}
.sizes .board-tab.filled{background:#d9803a;color:#fff}
.sizes .board-tab.filled:first-child{border-radius:99px 0 0 99px}
.sizes .board-tab-active{border-radius:0 99px 99px 0 !important;background:#d9803a !important;color:#fff}
.sizes .board-tab-active:first-child{border-radius:99px !important}
.gorow{display:flex;flex-direction:column;align-items:center;gap:6px;max-width:420px}
.allgo{font-size:14px;font-weight:600;background:#2e7dd7;color:#fff;border-radius:99px;padding:9px 16px;min-height:40px;display:inline-flex;align-items:center}
.allgo[hidden]{display:none}
.est{font-size:13px;color:#57606a;font-variant-numeric:tabular-nums}
.est-n{display:inline-block;min-width:2ch;text-align:right;font-weight:600;color:#1b1f23}
.allgo:hover{text-decoration:none;background:#2669b8}
.prio-label{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#57606a;margin:0 0 4px}
.rank{flex-shrink:0;width:22px;align-self:flex-start;padding-top:10px;color:#8b95a1;font-weight:600;font-size:14px}
.ago{color:#8b95a1;white-space:nowrap}
.grp-summary{color:#57606a;font-size:13px;margin-top:3px;line-height:1.4}
`;
