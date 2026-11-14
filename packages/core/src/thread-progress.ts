/**
 * What an agent is doing with a comment: working on it, or done.
 *
 * The owner, on an agent's resolve leaving his open page at once: "It's a
 * little sudden, and then it feels like it's getting lost." So an agent marks
 * a thread `working` when it starts and `done` when the change is made, and
 * the thread stays open until a person resolves it. The mark lives on the
 * thread's Yjs map under `progress`, so every open page sees it as it syncs.
 *
 * Kept out of `readThread` for the reason `linked-item.ts` gives: `schema.ts`
 * ships in the widget's budgeted bundle, and this does not fit under its
 * ceiling. The server reads it in `listThreadsWithLinks`; the widget reads the
 * raw field in its own unbudgeted chunk.
 *
 * Any status change clears the mark (`setStatus` in `schema.ts`), and so does
 * a person's reply on a done thread (`doc-threads.ts`): that reply sends the
 * work back.
 */
import type * as Y from 'yjs';
import { getThreads } from './schema.ts';
import type { ThreadProgress, User } from './types.ts';

export type ProgressState = ThreadProgress['state'];

/** The key on the thread's map. */
export const PROGRESS_KEY = 'progress';

/** The stored mark, or undefined for a value any peer could have written
 *  wrong: like every field on a thread map, no peer's write is trusted. */
export function readThreadProgress(raw: unknown): ThreadProgress | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { state, by, at } = raw as Record<string, unknown>;
  if (state !== 'working' && state !== 'done') return undefined;
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  if (!by || typeof by !== 'object') return undefined;
  const { id, name } = by as Record<string, unknown>;
  if (typeof id !== 'string' || typeof name !== 'string') return undefined;
  return { state, by: by as User, at };
}

/** Set the mark, or clear it with `open`. False when there is no such thread. */
export function setThreadProgress(
  doc: Y.Doc,
  threadId: string,
  state: ProgressState | 'open',
  by: User,
  at: number = Date.now(),
): boolean {
  const map = getThreads(doc).get(threadId);
  if (!map) return false;
  doc.transact(() => {
    if (state === 'open') map.delete(PROGRESS_KEY);
    else map.set(PROGRESS_KEY, { state, by, at });
  });
  return true;
}
