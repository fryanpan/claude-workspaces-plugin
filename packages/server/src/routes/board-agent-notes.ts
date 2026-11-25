/**
 * `GET /workspaces/:ws/agent-notes` — every agent's end-of-turn notes that no
 * task took on this board, grouped per agent and named by state
 * (`agent-note-placement.ts`). It is the source of Home's "Not on a task"
 * list under Recent activity.
 *
 * A note lands on a task only when its agent holds exactly one in-progress
 * task there. The rest are written to the board's unplaced-note log
 * (`agent-note-log.ts`) by `dispatch-and-notes.ts`, and before this route
 * nothing showed them to a person. Per agent rather than per task, because
 * those notes have no task to hang on.
 *
 * Refused to share visitors, as the per-agent notes read is: these are a
 * session's own words, not the board's rows. The front door already holds
 * this row to trusted-local; the refusal here is the fence behind it.
 *
 * Dependencies arrive in an explicit context, following
 * `chat-audit-routes.ts`.
 */
import type { AgentNoteLog } from '../agent-note-log.ts';
import {
  AGENT_NOTES_PER_AGENT,
  AGENT_NOTES_WINDOW_MS,
  agentNotesByAgent,
} from '../agent-note-placement.ts';
import type { AgentNoteRing } from '../agent-notes.ts';
import type { ShareTarget } from '../middleware/host-guard.ts';
import type { WorkspaceScope } from '../middleware/workspace-scope.ts';
import type { BoardWorkspace } from '../tasks.ts';
import { type RouteRow, rowHandlers } from './row-dispatch.ts';

/** The long-lived collaborators this route reads, built once per server. */
export interface BoardAgentNotesRoutesContext {
  /** The board's durable record of notes no task took. */
  agentNoteLog: AgentNoteLog;
  /** The in-process ring, read only to learn whether an agent's newest note
   *  landed on a task after its last unplaced one. */
  agentNotes: Pick<AgentNoteRing, 'list'>;
  /** JSON response helper — status plus body, no CORS. */
  j: (status: number, body: unknown) => Response;
}

/** What only this request knows. */
export interface BoardAgentNotesRouteRequest {
  /** The board this path named, resolved by `middleware/workspace-scope.ts`. */
  scope?: WorkspaceScope<BoardWorkspace>;
  req: Request;
  /** The route-table row the router matched. */
  row: RouteRow;
  /** The share target this request resolved to, or null for a member. */
  visitor: ShareTarget | null;
}

/** The one route. `undefined` means the request reached no board. */
export async function handleBoardAgentNotesRoutes(
  ctx: BoardAgentNotesRoutesContext,
  rq: BoardAgentNotesRouteRequest,
): Promise<Response | undefined> {
  if (!rq.scope) return undefined;
  return (await ROWS(ctx, rq)) ?? undefined;
}

const ROWS = rowHandlers<
  BoardAgentNotesRoutesContext,
  BoardAgentNotesRouteRequest,
  Promise<Response>
>('board-agent-notes.ts', { '/workspaces/:ws/agent-notes': boardNotes });

async function boardNotes(
  ctx: BoardAgentNotesRoutesContext,
  rq: BoardAgentNotesRouteRequest,
): Promise<Response> {
  const { agentNoteLog, agentNotes, j } = ctx;
  const { req, visitor, scope } = rq;
  if (visitor) return j(403, { error: 'not available to share visitors' });
  if (req.method !== 'GET') return j(405, { error: 'method not allowed' });
  if (!scope) return j(404, { error: 'not found' });
  const board = scope.workspaceId;
  const since = Date.now() - AGENT_NOTES_WINDOW_MS;
  const read = agentNoteLog.readBoard(board, since, AGENT_NOTES_PER_AGENT);
  const agents = agentNotesByAgent(
    read.lines,
    (agent) => {
      // The ring is newest first: the first placed note on this board is the
      // agent's latest one that a task took.
      const placed = agentNotes
        .list(agent)
        .find((n) => n.workspaceId === board && n.taskId !== undefined);
      return placed?.taskId !== undefined ? { at: placed.at, taskId: placed.taskId } : undefined;
    },
    AGENT_NOTES_PER_AGENT,
    read.skipped,
  );
  return j(200, { workspaceId: board, since, agents });
}
