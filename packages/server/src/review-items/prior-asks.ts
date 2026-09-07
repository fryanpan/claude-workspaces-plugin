/**
 * What this reader has ALREADY been asked on this row — the fact the quality
 * gate could not see.
 *
 * A row can be asked about through two channels that know nothing of each
 * other: `add_review_item` writes an item into `task.reviews`, and
 * `create_thread(docId: 'task:<id>', review)` writes a review payload onto a
 * comment in the ticket's body doc. `persistence.ts` says as much where it
 * has to count the second kind — "a doc-thread item never lands there ...
 * which this store cannot see". The judge reads one item at a time, so a
 * question asked down one channel and answered is invisible to the same
 * question filed down the other.
 *
 * That is not hypothetical. On 2026-09-06 the stranded-documents ticket was
 * asked at 14:59 through the ticket channel, answered "Archive them" at
 * 15:14, asked again at 17:17 through the thread channel, and answered a
 * second time that evening with "didn't I already make this decision?".
 *
 * This module gathers both channels for one row and hands the judge the
 * result. It decides nothing: whether an item is a repeat is a judgement
 * about meaning, and the two headlines in that incident — "Eleven documents
 * from two boards you deleted have no address" and "11 documents lost their
 * board — archive or rehome?" — share three content words out of nine. A
 * lexical threshold high enough not to fire on unrelated items scores that
 * pair at 0.33 and misses it, which is why the comparison is the judge's and
 * this file only supplies the evidence.
 */
import type { Thread } from '@claude-workspaces/core';
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
 * How far back a settled question still counts as one the reader has
 * answered.
 *
 * Thirty days. The failure this exists for happened inside three hours, so
 * the window is not what makes it work; what the window does is stop a
 * question settled last quarter from holding a fair re-ask when the ground
 * has since moved. A row nobody has touched in a month asking the same thing
 * again is usually a new question wearing old words.
 */
export const PRIOR_ASK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The most prior asks handed to the judge, newest first.
 *
 * Eight. Every one costs prompt tokens on a call that sits inside a filing
 * route the agent is waiting on, and a row with more than eight settled
 * questions on it is one where the newest are the ones a repeat would be
 * repeating. Answered asks are kept ahead of open ones when the list has to
 * be cut, because an answered question is the one that makes an item a
 * repeat — an open one is at worst a duplicate of something still waiting.
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
  answered: boolean;
}

/** The ticket channel: items in `task.reviews`. */
function fromTask(task: Task, exceptItemId: string | undefined, now: number): Gathered[] {
  const out: Gathered[] = [];
  for (const item of task.reviews ?? []) {
    if (item.id === exceptItemId) continue;
    if (now - item.createdAt > PRIOR_ASK_WINDOW_MS) continue;
    const answer = item.answer?.text;
    out.push({
      at: item.createdAt,
      answered: answer !== undefined,
      ask: {
        headline: item.review.headline,
        askedAt: formatAskedAt(item.createdAt, now),
        ...(answer !== undefined ? { answer } : {}),
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
      const answer = review.answerText;
      out.push({
        at: comment.ts,
        answered: answer !== undefined,
        ask: {
          headline: review.headline,
          askedAt: formatAskedAt(comment.ts, now),
          ...(answer !== undefined ? { answer } : {}),
        },
      });
    }
  }
  return out;
}

/**
 * Every question already put to the reader on this row, newest first.
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
  // Answered first when the list has to be cut — see PRIOR_ASK_MAX. Within
  // each half the newest still leads, because `sort` here is stable.
  const answered = gathered.filter((g) => g.answered);
  const open = gathered.filter((g) => !g.answered);
  return [...answered, ...open].slice(0, PRIOR_ASK_MAX).map((g) => g.ask);
}

/** A row that has gone contributes nothing, without a null check at every
 *  use. `reviews` is the only field read off it. */
const emptyTask = { reviews: [] } as unknown as Task;
