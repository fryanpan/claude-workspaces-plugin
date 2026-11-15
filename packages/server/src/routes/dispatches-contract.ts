/**
 * The contract for the lead's board operations the MCP calls
 * (`route-contract.ts` says what a contract is): registering, closing and
 * reporting a builder dispatch (`dispatch-and-notes.ts`), and the chat audit
 * (`chat-audit-routes.ts`). No tool reads a field of these answers, so none
 * is declared.
 *
 * `author` is resolved by `authorFor`, so it is `unknown` here.
 */
import { Hono } from 'hono';
import { contractOnly, json } from './route-contract.ts';

export interface RegisterDispatchBody {
  taskId: string;
  worktreePath: string;
  agentName?: string;
  reason?: string;
  author?: unknown;
}
/** Every field is checked by `dispatch-reports.ts`, the one definition of a usable report. */
export interface DispatchReportBody {
  prNumber: unknown;
  headCommit: unknown;
  checks: unknown;
  doneWhen: unknown;
  agentName?: string;
  author?: unknown;
}
export interface ChatAuditBody {
  day?: string;
  auditor?: string;
  /** Re-validated whole by the chat audit store. */
  entries: unknown[];
}

const BOARD = '/workspaces/:ws';

export const dispatchesContract = new Hono()
  .post(`${BOARD}/dispatches`, json<RegisterDispatchBody>(), contractOnly)
  .delete(`${BOARD}/dispatches/:taskId`, contractOnly)
  .post(`${BOARD}/dispatches/:taskId/report`, json<DispatchReportBody>(), contractOnly)
  .get(`${BOARD}/chat-audit/:agent`, contractOnly)
  .post(`${BOARD}/chat-audit`, json<ChatAuditBody>(), contractOnly);

export type DispatchesContract = typeof dispatchesContract;
