/**
 * Whether a pasted link's target is waiting on a person: the fact behind the
 * needs-review mark a link wears beside its title (`POST
 * /workspaces/<ws>/links:titles`). Bryan reads a doc of task links as a
 * status page, and the mark is how he sees from that page what waits on him.
 *
 * No new notion of "open" is written here. A task asks its board's own count
 * (`reviewState(...).open`, the number the stall clock reads); a doc asks the
 * two sources its own dock shows — the declarations on its threads, by the
 * Home queue's rule, and the ticket items that link it (`linkedTaskItems`).
 *
 * Pure given its sources, so its test drives it with plain objects.
 */
import {
  type TaskReviewItem,
  type Thread,
  isReviewPayloadGated,
  pendingDeclaration,
} from '@claude-workspaces/core';
import { staleAsk } from '@claude-workspaces/core/review-stale';
import type { Task } from '@claude-workspaces/core/task-wire';
import { linkedTaskItems } from './mockup-linked-items.ts';

/**
 * Is this thread asking a person something right now? An open thread whose
 * newest declaration is unanswered, not held or still being judged, and not
 * stale — the three exclusions `reviewThreadItems` applies before it puts a
 * declared row on the Home queue.
 */
export function threadAsksPerson(thread: Thread): boolean {
  if (thread.status !== 'open') return false;
  const declaring = pendingDeclaration(thread);
  if (!declaring?.review || isReviewPayloadGated(declaring.review)) return false;
  return staleAsk(thread, declaring) === undefined;
}

/** A task's needs-review fact: its open count, unless the row is finished.
 *  The queue skips a done or archived ticket's questions — answering them
 *  changes nothing — so its link does not ask for them either. */
export function taskNeedsReview(
  row: { status: string; archivedAt?: number | undefined },
  open: number,
): boolean {
  if (row.status === 'done' || row.archivedAt !== undefined) return false;
  return open > 0;
}

/** What `docNeedsReview` reads of the server. */
export interface DocReviewSources {
  /** The doc's OPEN threads. */
  openThreads(docId: string): Thread[];
  /** The tasks on the board the link names, whose items may dock on the doc. */
  boardTasks(): Array<Pick<Task, 'id' | 'title' | 'status' | 'links'>>;
  reviewsOf(taskId: string): TaskReviewItem[];
  canonical(docId: string): string;
  /** The caller is the board's owner, so owner-only items count for them. */
  owner: boolean;
}

/** Does this doc (or mock) hold an item waiting on the reader? */
export function docNeedsReview(docId: string, s: DocReviewSources): boolean {
  if (s.openThreads(docId).some(threadAsksPerson)) return true;
  const canonical = s.canonical(docId);
  return (
    linkedTaskItems({
      docId: canonical,
      tasks: s.boardTasks(),
      reviewsOf: s.reviewsOf,
      canonical: s.canonical,
      owner: s.owner,
      // An owner-only item is answered on the board, and still waits on the
      // owner; the dock keeps it only when it has somewhere to send them.
      answerAt: (taskId) => taskId,
    }).length > 0
  );
}
