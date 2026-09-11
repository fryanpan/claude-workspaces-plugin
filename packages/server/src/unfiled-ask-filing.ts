import { normalizeAgent } from './chat-audit.ts';
/**
 * Did this session put its ask where the owner reads it?
 *
 * `unfiled-ask.ts` judges the WORDS of a closing message; this reads the
 * board to answer the other half. Kept apart because the words half is a pure
 * function over a string — driven over a corpus, tuned against labels — and
 * this half is a scan of tasks that only the server can do.
 *
 * The scan is over the board's OPEN tasks, per turn note, which on a board of
 * ~100 tasks is a walk of a few hundred small arrays. It is deliberately
 * stateless: a per-agent "last filed at" cache would be one more thing to
 * invalidate, and would go wrong in exactly the case that matters — a session
 * that restarted.
 *
 * It also answers WHO THE PEOPLE ARE, from the same walk. "Waiting on
 * Harborlight's read" is the commonest spelling of a wait a lead writes, and
 * no second-person pronoun appears in it — so the words half needs the
 * owner's name. Deriving it from who has actually moved a task on this board,
 * rather than naming one in the source, is what keeps a public repo free of
 * one deployment's owner.
 */
import { isReviewItemOnQueue } from './review-items/queries.ts';
import type { TaskStatus, TaskStore } from './tasks.ts';
import type { FilingState } from './unfiled-ask.ts';

/** Tasks whose review items can still be waiting on somebody. A done task's
 *  item is not on anybody's queue, and archived tasks are off the board. */
const OPEN_STATUSES: ReadonlyArray<TaskStatus> = ['triage', 'todo', 'in-progress'];

/** How many people's names the third-person wait check knows. */
const OWNER_NAMES_CAP = 8;

/**
 * What `agent` has filed on this board: an item still open on the owner's
 * queue, and an item filed at or after `since`.
 *
 * Both are computed in one pass because they walk the same rows, and the
 * caller always wants both — asking for one at a time would double the scan
 * for no reader's benefit.
 */
export function filingStateFor(
  store: TaskStore,
  workspaceId: string,
  agent: string,
  since: number,
): FilingState & { owners: string[] } {
  const who = normalizeAgent(agent);
  const owners = new Map<string, string>();
  let openItem = false;
  let filedSince = false;
  for (const status of OPEN_STATUSES) {
    for (const task of store.listTasks(workspaceId, { status })) {
      for (const t of task.transitions) {
        if (t.by.kind === 'person' && t.by.name.trim() !== '') {
          owners.set(normalizeAgent(t.by.name), t.by.name.trim());
        }
      }
      for (const item of store.listReviewItems(task.id)) {
        if (normalizeAgent(item.createdBy) !== who) continue;
        if (item.createdAt >= since) filedSince = true;
        if (isReviewItemOnQueue(item)) openItem = true;
      }
    }
  }
  // The list is capped: it is spliced into a regex, and an unbounded one
  // would grow with every visitor who ever moved a task.
  return { openItem, filedSince, owners: [...owners.values()].slice(0, OWNER_NAMES_CAP) };
}
