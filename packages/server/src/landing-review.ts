/**
 * The top of the all-workspaces page: what is waiting on you across every
 * board, counted by project, with one way in — and the projects in priority
 * order.
 *
 * Approved mock (queue blocks, 2026-09-14). It replaced the size bar and the
 * estimated total, and three decisions from it are easy to undo by accident:
 *
 *  - **Count items, never time.** The estimates were far off (two hours
 *    estimated, twenty minutes spent), so no minutes appear anywhere here.
 *  - **One group per project, in queue order**: the name, its count, and a
 *    run of fixed blocks in the board's colour. Every five items fold into
 *    one shiny block, still rather than animated, so a long queue stays a
 *    short line. A group opens the queue at that project's first item.
 *  - **No bar when nothing waits**, as before.
 *
 * Rendering only: the order is `cross-review-queue.ts`, the sentences are
 * `board-summary.ts`.
 */
import { escapeHtml } from '@claude-workspaces/core';

export interface LandingReview {
  /** Every open item's board, in queue order. */
  items: ReadonlyArray<{ workspaceId: string; project: string }>;
  /** Board id → 1-based project rank. */
  rankOf: ReadonlyMap<string, number>;
  /** Board id → the last hour in one sentence, when there is one. */
  summaryOf: (workspaceId: string) => string | undefined;
}

export const REVIEW_HREF = '/review';

/** How many items one shiny block stands for. */
export const ITEMS_PER_SHINY_BLOCK = 5;

export interface WaitingGroup {
  workspaceId: string;
  project: string;
  count: number;
}

/** The items as one group per board, in the order each board first appears. */
export function waitingGroups(items: LandingReview['items']): WaitingGroup[] {
  const groups = new Map<string, WaitingGroup>();
  for (const item of items) {
    const group = groups.get(item.workspaceId);
    if (group) group.count += 1;
    else
      groups.set(item.workspaceId, {
        workspaceId: item.workspaceId,
        project: item.project,
        count: 1,
      });
  }
  return [...groups.values()];
}

/** A count as blocks: one shiny per five, the remainder plain. */
export function blockRun(count: number): { shiny: number; plain: number } {
  const n = Math.max(0, Math.floor(count));
  return { shiny: Math.floor(n / ITEMS_PER_SHINY_BLOCK), plain: n % ITEMS_PER_SHINY_BLOCK };
}

/**
 * The muted colours a board's blocks are drawn in — the mock's four and four
 * more of the same weight, each dark enough to hold white. No board had a
 * colour of its own before this bar, so one is picked by hashing the board id:
 * a board keeps its colour however the ranking moves.
 */
export const BOARD_BLOCK_COLOURS: readonly string[] = [
  '#4f86c6',
  '#4e9e6b',
  '#c7684f',
  '#8d6cc0',
  '#b8872f',
  '#3f95a0',
  '#b35d88',
  '#6b7c8f',
];

export function boardColour(workspaceId: string): string {
  let h = 0;
  for (let i = 0; i < workspaceId.length; i++) h = (h * 31 + workspaceId.charCodeAt(i)) >>> 0;
  return BOARD_BLOCK_COLOURS[h % BOARD_BLOCK_COLOURS.length] ?? '#6b7c8f';
}

/** Where a group's tap lands: the queue, at that project's first item. */
export function reviewHrefFor(workspaceId: string): string {
  return `${REVIEW_HREF}?from=${encodeURIComponent(workspaceId)}`;
}

function renderGroup(g: WaitingGroup): string {
  const { shiny, plain } = blockRun(g.count);
  const blocks =
    '<span class="qb qb5"></span>'.repeat(shiny) + '<span class="qb"></span>'.repeat(plain);
  const name = escapeHtml(g.project);
  return `<a class="qgrp" href="${escapeHtml(reviewHrefFor(g.workspaceId))}" style="--c:${boardColour(g.workspaceId)}" aria-label="${name}, ${g.count} waiting"><span class="qname">${name}<span class="qn">${g.count}</span></span><span class="qrun" aria-hidden="true">${blocks}</span></a>`;
}

/** The review bar, or nothing when no item waits anywhere. */
export function renderReviewBar(review: LandingReview): string {
  if (review.items.length === 0) return '';
  const groups = waitingGroups(review.items).map(renderGroup).join('');
  return `<div class="allbar"><h2 class="alltitle">Review Items for You</h2><div class="allline"><div class="qblocks">${groups}</div><a class="allgo" href="${REVIEW_HREF}">Start review ›</a></div></div>`;
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
.alltitle{font-size:15px;font-weight:600;color:#1b1f23;margin:0 0 2px;text-transform:none;letter-spacing:0;display:block}
/* The groups and Start review share one line; on a narrow screen the button wraps below. */
.allline{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap}
.allline .allgo{margin-left:auto}
.allgo{font-size:14px;font-weight:600;background:#2e7dd7;color:#fff;border-radius:99px;padding:9px 16px;min-height:40px;display:inline-flex;align-items:center}
.allgo:hover{text-decoration:none;background:#2669b8}
/* One group per project, in queue order; the group is the tap target. */
.qblocks{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0 -6px;padding:0;flex:1 1 auto;min-width:0}
.qgrp{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-height:44px;padding:5px 6px 6px;border-radius:8px;color:inherit}
.qgrp:hover{text-decoration:none;background:rgba(27,31,35,.05)}
.qgrp:focus-visible{outline:2px solid #2e7dd7;outline-offset:1px}
.qgrp:active{background:rgba(27,31,35,.09)}
.qname{font-size:13px;font-weight:600;color:#1b1f23;line-height:1.2;white-space:nowrap}
.qn{font-weight:400;color:#57606a;margin-left:5px;font-variant-numeric:tabular-nums}
/* Ten blocks to a row, so a long run wraps inside its own group. */
.qrun{display:flex;flex-wrap:wrap;gap:3px;max-width:230px}
.qb{width:20px;height:20px;border-radius:4px;background:var(--c)}
/* One shiny block stands for five: the board colour under a still sheen and a gold rim. */
.qb5{position:relative;overflow:hidden;background:linear-gradient(135deg,rgba(255,255,255,.55) 0%,rgba(255,255,255,0) 45%),linear-gradient(315deg,rgba(0,0,0,.18) 0%,rgba(0,0,0,0) 50%),var(--c);box-shadow:0 0 0 1.5px #e0a82e,0 1px 3px rgba(224,168,46,.55)}
.qb5::after{content:"";position:absolute;left:4px;top:3px;width:6px;height:3px;border-radius:2px;background:rgba(255,255,255,.85);transform:rotate(-35deg)}
.prio-label{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#57606a;margin:0 0 4px}
.rank{flex-shrink:0;width:22px;align-self:flex-start;padding-top:10px;color:#8b95a1;font-weight:600;font-size:14px}
.ago{color:#8b95a1;white-space:nowrap}
.grp-summary{color:#57606a;font-size:13px;margin-top:3px;line-height:1.4}
`;
