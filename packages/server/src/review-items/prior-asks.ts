/**
 * What this reader has been asked on this row and NOT YET ANSWERED — the fact
 * the quality gate could not see.
 *
 * A row can be asked about through two channels that know nothing of each
 * other: `add_review_item` writes an item into `task.reviews`, and
 * `create_thread(docId: 'task:<id>', review)` writes a review payload onto a
 * comment in the ticket's body doc. `persistence.ts` says as much where it
 * has to count the second kind — "a doc-thread item never lands there ...
 * which this store cannot see". The judge reads one item at a time, so a
 * question still sitting on the queue down one channel is invisible to the
 * same question filed down the other.
 *
 * This module gathers both channels for one row and hands the judge the
 * result. It decides nothing: whether an item is a repeat is a judgement
 * about meaning, and two headlines for one question can share three content
 * words out of nine, which is why the comparison is the judge's and this file
 * only supplies the evidence.
 *
 * ── An ANSWERED question is not evidence ────────────────────────────────
 *
 * This used to hand over answered asks too, with their answers, so the judge
 * could hold a question the reader had already settled. It held the wrong
 * things: on 2026-09-14 three of five items filed on the board were held as
 * repeats of an answered item whose answer did not settle them — a phone test
 * after the design was approved, a follow-up after "I'll fix this with Team
 * Lead". The owner's call that day: the gate must not hold an item as a
 * duplicate of one already answered. Leaving answered asks out of the prompt
 * makes that a property of the evidence rather than a request the model may
 * or may not honour — the judge cannot match on an ask it is never shown. A
 * duplicate of a question STILL OPEN is still held: answering the new one
 * would leave the old one sitting on the queue.
 */
import { type Thread, reviewAnswered } from '@claude-workspaces/core';
import type { PriorAsk } from '@claude-workspaces/core/review-judge-prompt';
import type { Task } from '../tasks.ts';

/** Everything this module needs from the two stores, and nothing else. */
export interface PriorAskSource {
  /** The live ticket, or undefined when no such row exists. */
  getTask: (taskId: string) => Task | undefined;
  /** Every thread on a doc, including resolved ones — a resolved thread is
   *  exactly where an answered question goes to sit. */
  listThreads: (docId: string) => Thread[];
}

/**
 * How far back an open question still counts as one the reader is being
 * asked.
 *
 * Thirty days. What the window does is stop a question filed last quarter
 * and never answered from holding a fair re-ask when the ground has since
 * moved. A row nobody has touched in a month asking the same thing again is
 * usually a new question wearing old words.
 */
export const PRIOR_ASK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The most prior asks handed to the judge, newest first.
 *
 * Eight. Every one costs prompt tokens on a call that sits inside a filing
 * route the agent is waiting on, and a row with more than eight open
 * questions on it is one where the newest are the ones a repeat would be
 * repeating.
 */
export const PRIOR_ASK_MAX = 8;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * The date as the reader would say it: "6 September", with the year only
 * when it is not the current one.
 *
 * Formatted here rather than in the prompt module because the clock and the
 * timezone live on this side; the prompt stays pure and holds no date logic.
 */
export function formatAskedAt(at: number, now: number): string {
  const d = new Date(at);
  const stamp = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date(now).getFullYear() ? stamp : `${stamp} ${d.getFullYear()}`;
}

/** The row a review item hangs on, as far as prior asks are concerned. */
export type PriorAskRow =
  | { kind: 'task'; taskId: string; exceptItemId?: string; exceptCommentId?: string }
  | { kind: 'doc'; docId: string; exceptCommentId?: string };

interface Gathered {
  at: number;
  ask: PriorAsk;
}

/**
 * Is this item a question still in front of the reader?
 *
 * Answered is out — see the header. A withdrawn item is off the queue by
 * definition, and a HELD one never reached it — the gate's whole job is to
 * keep it there until it passes. Both used to be gathered anyway, so the
 * judge was told "asked on 7 September, still unanswered" about an item that
 * had been held and withdrawn the same hour, and held the next filing for
 * repeating a question nobody had read (2026-09-07, twice on one row).
 */
function stillOpen(
  review: { withdrawnAt?: number },
  judge: { verdict: string } | undefined,
  answered: boolean,
): boolean {
  if (answered) return false;
  if (review.withdrawnAt !== undefined) return false;
  return judge?.verdict !== 'held';
}

/** The ticket channel: items in `task.reviews`. */
function fromTask(task: Task, exceptItemId: string | undefined, now: number): Gathered[] {
  const out: Gathered[] = [];
  for (const item of task.reviews ?? []) {
    if (item.id === exceptItemId) continue;
    if (now - item.createdAt > PRIOR_ASK_WINDOW_MS) continue;
    if (!stillOpen(item.review, item.judge, item.answer !== undefined)) continue;
    out.push({
      at: item.createdAt,
      ask: {
        id: item.id,
        headline: item.review.headline,
        askedAt: formatAskedAt(item.createdAt, now),
      },
    });
  }
  return out;
}

/**
 * The thread channel: a review payload riding on a comment.
 *
 * The comment's own timestamp is when the question was put, which is what
 * the reader would recognise — the payload carries no filed-at of its own.
 */
function fromThreads(
  threads: readonly Thread[],
  exceptCommentId: string | undefined,
  now: number,
): Gathered[] {
  const out: Gathered[] = [];
  for (const thread of threads) {
    for (const comment of thread.comments) {
      const review = comment.review;
      if (!review) continue;
      if (comment.id === exceptCommentId) continue;
      if (now - comment.ts > PRIOR_ASK_WINDOW_MS) continue;
      if (!stillOpen(review, review.judge, reviewAnswered(review))) continue;
      out.push({
        at: comment.ts,
        ask: {
          id: comment.id,
          headline: review.headline,
          askedAt: formatAskedAt(comment.ts, now),
        },
      });
    }
  }
  return out;
}

/**
 * Every question put to the reader on this row and still open, newest first.
 *
 * Empty for a row with no history, which leaves the judge exactly as it
 * behaved before — the prompt omits the block entirely.
 */
export function priorAsksFor(row: PriorAskRow, source: PriorAskSource, now: number): PriorAsk[] {
  const gathered: Gathered[] =
    row.kind === 'task'
      ? [
          ...fromTask(source.getTask(row.taskId) ?? emptyTask, row.exceptItemId, now),
          ...fromThreads(source.listThreads(`task:${row.taskId}`), row.exceptCommentId, now),
        ]
      : fromThreads(source.listThreads(row.docId), row.exceptCommentId, now);
  gathered.sort((a, b) => b.at - a.at);
  return gathered.slice(0, PRIOR_ASK_MAX).map((g) => g.ask);
}

/** A row that has gone contributes nothing, without a null check at every
 *  use. `reviews` is the only field read off it. */
const emptyTask = { reviews: [] } as unknown as Task;
