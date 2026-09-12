/**
 * When a board last MOVED — the one rule, in the one place both halves of the
 * ready-work clock read it from.
 *
 * The ready-work wake (`ready-nudge.ts`) fires only after a board has been
 * quiet for the idle window, and that quiet is measured by two clocks that
 * have to agree:
 *
 *  - the **in-process** one, fed by `noteActivity` from every store event
 *    this run has seen (`stall-wiring.ts`), which is exact but dies with the
 *    process;
 *  - the **durable** one, read back off the board record, which is what stops
 *    a restart from reporting every board as infinitely idle and firing one
 *    wake per board at every deploy.
 *
 * They used to disagree, and the disagreement silenced the feature. The
 * in-process half filtered events through `isBoardActivity` — which excludes
 * `task.noted`, deliberately, because that is one event per TURN from every
 * agent holding a row and counting it would suppress the wake for exactly as
 * long as a builder keeps talking without moving anything. The durable half
 * was `max(task.updatedAt)` across the board, and `appendNote` bumps
 * `updatedAt`. So the excluded event moved the clock anyway, through the other
 * half, and `lastActivity`'s `Math.max` let the contaminated reading win.
 *
 * The consequence was not a delayed wake, it was no wake at all: any board
 * with one working agent gets a turn-end note every few minutes, so the
 * fifteen-minute window never elapsed. Reproduced 2026-09-12 — a ready row,
 * agent-owned and unblocked, sat ready indefinitely while a note landing on an
 * unrelated row kept the board reading as busy.
 *
 * So the durable clock is now stamped from the SAME predicate, at the store's
 * emit choke point, and kept on the board record. One rule, two readers, and a
 * new event type cannot be counted by one half and ignored by the other.
 */
import type { BoardWorkspace, Task } from './tasks.ts';

/**
 * Whether a store event counts as THE BOARD MOVING.
 *
 * Liveness does not: `agent.*` (attached / detached / heartbeat) is the
 * session being there, and `task.noted` is the session ending a turn — one per
 * turn from any agent holding a row, so counting it would suppress the wake for
 * exactly as long as a builder keeps talking without moving anything, which is
 * the state the wake exists to catch.
 */
export function isBoardActivity(type: string): boolean {
  return !type.startsWith('agent.') && type !== 'task.noted';
}

/**
 * The durable reading: when this board last moved, as far as anything that
 * survives a restart can tell.
 *
 * `lastBoardActivityAt` is the stamped answer and is authoritative whenever it
 * is present. The reduce behind it is the floor for a board whose record
 * predates the field — the reading this function replaces, kept exactly as it
 * was so the first boot after the deploy is no LESS conservative than the last
 * boot before it. It is contaminated by turn-end notes, which is the whole
 * defect; it stops being consulted the moment the board emits anything.
 */
export function lastBoardActivityAt(workspace: BoardWorkspace, tasks: readonly Task[]): number {
  if (workspace.lastBoardActivityAt !== undefined) return workspace.lastBoardActivityAt;
  return tasks.reduce((max, t) => Math.max(max, t.updatedAt, t.createdAt), 0);
}
