/**
 * The contract for a board's agent roster as the MCP calls it
 * (`route-contract.ts` says what a contract is): attach, list, heartbeat,
 * leave, the receipt for a queued comment, and the answer to a queued voice
 * question. `workspace-attachments.ts` serves every one.
 *
 * Each answer declares only the fields a tool reads, so it is a floor on the
 * answer rather than its whole shape.
 */
import { Hono } from 'hono';
import { answers, contractOnly, json } from './route-contract.ts';

export interface AttachAgentBody {
  agentId: string;
  /** Sent only when a session attaches as itself. */
  agentName?: string;
  runtime: string;
  capabilities?: string[];
  endpoint?: string;
  pluginVersion?: string;
  processId?: string;
}
export interface HeartbeatBody {
  toolCallAt?: number;
}
export interface VoiceAnswerBody {
  agentId: string;
  text: string;
  written?: string;
  minute?: string;
}

/** A comment addressed to the agent that arrived while nobody was listening. */
export interface QueuedComment {
  id: string;
  docId: string;
  threadId?: string;
  event: string;
  author?: { id?: string; name?: string };
  text: string;
  ts: number;
}
export interface AttachAgentAnswer {
  attachment: { agentId: string };
  gating?: unknown;
  untriaged?: string[];
  queuedVoice?: Array<{ transcript: string; ts: number; applied?: string }>;
  queuedComments?: QueuedComment[];
  lead?: boolean;
  retired?: { since: number; reason?: string; notice: string };
  leadNameConflicts?: { boards: Array<{ workspaceId: string; name: string }>; notice: string };
  seat?: {
    leadAgentId?: string;
    live: boolean;
    stale: boolean;
    unattached?: boolean;
    notice?: string;
  };
  seatTakenFrom?: string;
  watching: number;
  notes: string[];
  sentry: { projects: Array<{ slug: string; raises: string }>; remedy: string };
  mounts: { project: string | null; count: number; folders?: string[]; note: string };
}
export interface VoiceAnswerAnswer {
  delivered: boolean;
}

const AGENTS = '/workspaces/:ws/agents';

export const workspaceAgentsContract = new Hono()
  .post(AGENTS, json<AttachAgentBody>(), answers<AttachAgentAnswer>())
  .get(AGENTS, contractOnly)
  .delete(`${AGENTS}/:agentId`, contractOnly)
  .post(`${AGENTS}/:agentId/heartbeat`, json<HeartbeatBody>(), contractOnly)
  .post('/workspaces/:ws/comment-queue/:id/ack', contractOnly)
  .post('/workspaces/:ws/voice-queue/:id/ack', contractOnly)
  .post(
    '/workspaces/:ws/voice-queue/:id/answer',
    json<VoiceAnswerBody>(),
    answers<VoiceAnswerAnswer>(),
  );

export type WorkspaceAgentsContract = typeof workspaceAgentsContract;
