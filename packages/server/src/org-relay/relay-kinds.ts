/**
 * The four kinds of relay message, read off the line after `to:`.
 *
 *   to: <seat>                    a message: the rest is quoted text
 *   to: <seat>\ndispatch: t-…     a dispatch: one task id, then optional text
 *   to: <seat>\nwake              a wake: optional text saying why
 *   to: <seat>\nrestart-lead      a restart request: no text at all
 *
 * The kind and the task id go in the delivered header, OUTSIDE the quote, so
 * the recipient can rely on them as the relay's reading of the sender's
 * request. Everything else the sender wrote stays inside the quote.
 *
 * A restart request carries no text so that nothing a sender writes reaches
 * the recipient's machine as part of it: `lead-restart.ts` on a project
 * machine acts on the header line alone, and only when the relay's own board
 * token opened the thread.
 */
import type { RelaySeat } from './relay-config.ts';

export type RelayKind =
  | { kind: 'message' }
  | { kind: 'dispatch'; taskId: string }
  | { kind: 'wake' }
  | { kind: 'restart' };

/** A task id as the board writes them. */
const TASK_ID = /^t-[A-Za-z0-9_-]{1,64}$/;
const DISPATCH_LINE = /^\s*dispatch:\s*(\S+)\s*$/i;
const WAKE_LINE = /^\s*wake\s*$/i;
const RESTART_LINE = /^\s*restart-lead\s*$/i;

/** The kind, and the text left once its line is taken off. */
export function parseRelayKind(
  text: string,
): { kind: RelayKind; text: string } | { refuse: string } {
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  const rest = nl < 0 ? '' : text.slice(nl + 1).trim();
  if (RESTART_LINE.test(first)) {
    return rest === '' ? { kind: { kind: 'restart' }, text: '' } : { refuse: 'restart-with-text' };
  }
  if (WAKE_LINE.test(first)) return { kind: { kind: 'wake' }, text: rest };
  const dispatch = DISPATCH_LINE.exec(first);
  if (dispatch) {
    const taskId = dispatch[1] as string;
    if (!TASK_ID.test(taskId)) return { refuse: 'bad-task-id' };
    return { kind: { kind: 'dispatch', taskId }, text: rest };
  }
  return { kind: { kind: 'message' }, text };
}

/** Whether a message of this kind may carry no text. */
export function kindAllowsEmpty(kind: RelayKind): boolean {
  return kind.kind !== 'message';
}

/**
 * The one line a restart request is delivered as. `lead-restart.ts` matches
 * it exactly, so the two are written from this function and its pattern.
 */
export function restartHeader(from: RelaySeat, to: RelaySeat): string {
  return `Relay restart request from ${from.id} for ${to.agentId}.`;
}

/** The pattern `restartHeader` writes: the sender seat, then the agent id. */
export const RESTART_HEADER =
  /^Relay restart request from ([A-Za-z0-9_-]{1,128}) for (\S{1,200})\.$/;

/** The words naming the kind in a delivered header. */
export function kindWords(kind: RelayKind): string {
  switch (kind.kind) {
    case 'dispatch':
      return `Relay dispatch of task ${kind.taskId}`;
    case 'wake':
      return 'Relay wake';
    default:
      return 'Relay message';
  }
}
