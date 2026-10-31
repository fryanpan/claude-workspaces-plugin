/**
 * `POST /workspaces/{id}/agents/{name}/mirror` — the plugin's MessageDisplay
 * and PostToolBatch hooks hand the board's lead chat what the lead's session
 * shows in its terminal (`lead-chat/mirror.ts`). Two bodies:
 *
 * - `{ kind: 'text', messageId, index, final, text }`: a flush of a message
 *   the session is writing, carrying the whole message so far.
 * - `{ kind: 'tools', calls: [{ name, input, output?, failed? }] }`: the
 *   tool calls of one batch.
 *
 * The hook has already reduced every string the way it reduces a turn note
 * (`note-redact.ts`); this route bounds them. A session that is not the
 * board's lead is answered without `mirrored`, which tells its hook to stop
 * posting. Same posture as the prompts route beside it: under a board scope,
 * refused to share visitors other than the board's own lead, and a shared
 * agent name is refused.
 */
import {
  LEAD_CHAT_MAX_CHARS,
  LEAD_CHAT_TOOL_INPUT_MAX,
  LEAD_CHAT_TOOL_OUTPUT_MAX,
  type LeadChatToolCall,
} from '@claude-workspaces/core/lead-chat';
import { SHARED_IDENTITY_ERROR, SHARED_IDENTITY_MESSAGE } from '../agent-watches.ts';
import { isSharedAgentName } from '../chat-audit.ts';
import type { MirroredText } from '../lead-chat/mirror.ts';
import { matchRest } from '../middleware/workspace-scope.ts';
import type { TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';

/** Claude Code's message ids are UUIDs. */
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const INDEX_MAX = 1_000_000;
const TEXT_MAX = LEAD_CHAT_MAX_CHARS * 2;
const CALLS_MAX = 50;

/** A text flush, or null when malformed. */
export function parseMirroredText(raw: Record<string, unknown>): MirroredText | null {
  const { messageId, index, final, text } = raw;
  if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) return null;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > INDEX_MAX) {
    return null;
  }
  if (typeof final !== 'boolean') return null;
  if (typeof text !== 'string' || text.trim() === '' || text.length > TEXT_MAX) return null;
  return { messageId, index, final, text };
}

/** A batch of tool calls, or null when malformed. */
export function parseToolCalls(v: unknown): LeadChatToolCall[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > CALLS_MAX) return null;
  const out: LeadChatToolCall[] = [];
  for (const c of v) {
    if (typeof c !== 'object' || c === null) return null;
    const { name, input, output, failed } = c as Record<string, unknown>;
    if (typeof name !== 'string' || name === '' || name.length > 200) return null;
    if (typeof input !== 'string' || input.length > LEAD_CHAT_TOOL_INPUT_MAX) return null;
    if (
      output !== undefined &&
      (typeof output !== 'string' || output.length > LEAD_CHAT_TOOL_OUTPUT_MAX)
    ) {
      return null;
    }
    if (failed !== undefined && typeof failed !== 'boolean') return null;
    out.push({
      name,
      input,
      ...(typeof output === 'string' && output !== '' ? { output } : {}),
      ...(failed === true ? { failed: true as const } : {}),
    });
  }
  return out;
}

export async function handleLeadMirrorRoute(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const { j, safeJson } = ctx;
  const match = matchRest(rq.scope, /^agents\/([^/]+)\/mirror$/);
  const boardId = rq.scope?.workspaceId;
  if (!match || boardId === undefined) return undefined;
  if (rq.visitor && rq.leadBoard !== boardId)
    return j(403, { error: 'not available to share visitors' });
  if (rq.req.method !== 'POST') return j(405, { error: 'method not allowed' });
  const agent = decodeURIComponent(match[1] ?? '').trim();
  if (agent.length === 0 || agent.length > 200) return j(400, { error: 'bad agent' });
  if (isSharedAgentName(agent)) {
    return j(400, { error: SHARED_IDENTITY_ERROR, message: SHARED_IDENTITY_MESSAGE });
  }
  const raw = await safeJson(rq.req);
  if (raw === null) return j(400, { error: 'bad-body' });
  let mirrored: boolean;
  if (raw.kind === 'text') {
    const flush = parseMirroredText(raw);
    if (!flush) return j(400, { error: 'bad-text' });
    mirrored = ctx.leadSessionMirror.text(boardId, agent, flush);
  } else if (raw.kind === 'tools') {
    const calls = parseToolCalls(raw.calls);
    if (!calls) return j(400, { error: 'bad-calls' });
    mirrored = ctx.leadSessionMirror.tools(boardId, agent, calls);
  } else {
    return j(400, { error: 'bad-kind' });
  }
  return j(202, { ok: true, ...(mirrored ? { mirrored: true } : {}) });
}
