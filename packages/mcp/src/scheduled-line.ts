/**
 * Render the two wake frames a scheduled run sends
 * (server: `task-scheduled-wake.ts`) — an owner's `task.scheduled_run` and a
 * spawner's `task.spawn_requested`. A module of its own for the same reason
 * `nudge-line.ts` and `voice-line.ts` are: the wording is a decision that
 * has to be assertable, and `channel-messages.ts` cannot be imported by a
 * test without starting an MCP server.
 */

export interface ScheduledRunPayload {
  workspaceId?: string;
  taskId?: string;
  title?: string;
  ruleId?: string;
  attempt?: number;
  attempts?: number;
  agentId?: string;
  agentName?: string;
}

const quoted = (title: string | undefined, id: string | undefined): string =>
  title ? `"${title}" (${id ?? '?'})` : (id ?? 'a scheduled run');

/** The owner's wake: the instance is filed and waiting on you. */
export function scheduledRunLine(p: ScheduledRunPayload): string {
  const nth =
    p.attempt !== undefined && p.attempt > 1
      ? ` This is wake ${p.attempt}${p.attempts !== undefined ? ` of ${p.attempts}` : ''}; the board files a review item on the row after the last.`
      : '';
  return `[task.scheduled_run] ${quoted(p.title, p.taskId)} is due — the board filed it from rule ${
    p.ruleId ?? '?'
  } and it is yours. Take it with task_transition(${p.taskId ?? '<taskId>'}, "in-progress"), do the work, and close it done.${nth}`;
}

/** The spawner's ask: the owner holds no session, start one for this run. */
export function spawnRequestedLine(p: ScheduledRunPayload): string {
  const who = p.agentName ?? p.agentId ?? 'its owner';
  return `[task.spawn_requested] ${who} is not attached to board ${
    p.workspaceId ?? '?'
  }, and its scheduled run ${quoted(p.title, p.taskId)} is waiting. Spawn a session for ${who} to run that one row, and spin it down when the row closes. The board asks once per run; if nobody answers it files a review item on the row instead.`;
}
