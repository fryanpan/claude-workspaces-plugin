/**
 * The contract for the two status-note routes the MCP's `post_status` calls
 * (`route-contract.ts` says what a contract is): a note on a named task, or
 * on the agent's own row on a board. `dispatch-and-notes.ts` serves both,
 * and `parseAgentNote` (`agent-notes.ts`) reads the body, which is why the
 * body is that parser's input type rather than a second spelling of it.
 */
import { Hono } from 'hono';
import type { AgentNoteInput } from '../agent-notes.ts';
import { answers, json } from './route-contract.ts';

/** `at` is the poster's clock and optional; the server's is used otherwise. */
export type AgentNoteBody = Omit<AgentNoteInput, 'at'> & { at?: number };

/** Both routes answer 202 with this. `post_status` reads `taskId` and `workspaceId`. */
export interface AgentNoteAnswer {
  ok: true;
  workspaceId: string;
  /** The row the note landed on; absent when no row took it. */
  taskId?: string;
  needsFiling?: true;
  logged?: boolean;
  unfiledAsk?: unknown;
}

export const agentNotesContract = new Hono()
  .post('/workspaces/:ws/tasks/:taskId/notes', json<AgentNoteBody>(), answers<AgentNoteAnswer>())
  .post('/workspaces/:ws/agents/:agent/notes', json<AgentNoteBody>(), answers<AgentNoteAnswer>());

export type AgentNotesContract = typeof agentNotesContract;
