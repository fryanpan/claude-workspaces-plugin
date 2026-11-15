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

/*
 * The mark as drawn, on every surface that draws one: the widget's pin on an
 * app or mock (`comment-extras.ts` in the widget) and the thread card's glyph
 * on a doc and on the board (`thread-mark.ts` in workspaces-app). One copy of
 * the markup and of the clock that decides whether a check draws, so the two
 * cannot drift; each surface's stylesheet sizes it for its own place.
 *
 * Working: three dots that brighten and fade in turn ("Breathing", the
 * owner's pick on the comment-states mock). Done: a check that draws itself
 * once, on the change this page saw. Both hold still under reduced motion.
 */

/** The check's draw: a .12s wait, then .55s of stroke (`.cw-draw`). */
export const MARK_DRAW_WAIT_MS = 120;
export const MARK_DRAW_MS = 670;

const DOTS =
  '<span class="cw-pg"><i class="cw-breathe"></i><i class="cw-breathe"></i><i class="cw-breathe"></i></span>';

/**
 * The mark's markup, from constants only (safe as innerHTML).
 *
 * `sinceDone` is how long ago this page saw the thread turn done, from
 * `createProgressClock`; null when it never saw the change, which shows the
 * check already drawn. Inside the draw, a rebuild continues it with a
 * negative delay rather than restarting it.
 */
export function progressMarkHtml(state: ProgressState, sinceDone: number | null): string {
  if (state === 'working') return DOTS;
  const drawing = sinceDone !== null && sinceDone < MARK_DRAW_MS;
  const delay =
    drawing && sinceDone ? ` style="animation-delay:${MARK_DRAW_WAIT_MS - sinceDone}ms"` : '';
  return `<span class="cw-pg"><svg viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="cw-check${drawing ? ' cw-draw' : ''}" pathLength="1" d="M4.2 8.4l2.5 2.5L11.9 5.6"${delay}/></svg></span>`;
}

/**
 * Remembers each thread's mark as this page last saw it, so a check draws on
 * the transition and not on every rebuild. Call it for every thread a render
 * shows, marked or not: a thread first seen open and then done is a
 * transition; one first seen done is not.
 *
 * Returns how long ago the thread turned done, or null.
 */
export function createProgressClock(): (
  threadId: string,
  state: ProgressState | 'open',
  now?: number,
) => number | null {
  const marks = new Map<string, { state: string; at: number | null }>();
  return (threadId, state, now = Date.now()) => {
    const prev = marks.get(threadId);
    const at = state !== 'done' ? null : prev?.state === 'done' ? prev.at : prev ? now : null;
    marks.set(threadId, { state, at });
    return at === null ? null : now - at;
  };
}
