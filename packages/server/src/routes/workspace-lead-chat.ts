/**
 * `GET` and `POST /workspaces/<id>/lead-chat` — the board's chat with its lead
 * (`lead-chat/lead-chat.ts`).
 *
 * The read is a member's: everything in a workspace is available to everyone
 * in it. The write is the owner's alone, as talking to an agent by name on
 * the converse socket is, because the lead acts on what it is told with the
 * owner's reach. Neither path is in the share member table
 * (`middleware/host-guard.ts`), and both refuse a visitor here besides.
 */
import { LEAD_CHAT_MAX_CHARS } from '@claude-workspaces/core/lead-chat';
import { parseVoiceContext } from '../voice.ts';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

export async function handleWorkspaceLeadChat(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const { req, pathname, scope, visitor, authorFor, requireOwner } = rq;
  if (!scope || !/^\/workspaces\/[^/]+\/lead-chat$/.test(pathname)) return undefined;
  if (req.method !== 'GET' && req.method !== 'POST') return undefined;
  if (visitor) return ctx.j(403, { error: 'not a member route' });
  const { workspaceId } = scope;
  const denied = requireOwner(workspaceId);
  // A member who may not write is still shown the chat, and told so, which
  // is what lets a page draw no composer rather than one that refuses.
  if (req.method === 'GET') {
    return ctx.j(200, { ...ctx.leadChat.snapshot(workspaceId), canTalk: !denied });
  }
  if (denied) return denied;
  const body = await ctx.safeJson(req);
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return ctx.j(400, { error: 'text required' });
  if (text.length > LEAD_CHAT_MAX_CHARS) {
    return ctx.j(400, { error: `text over ${LEAD_CHAT_MAX_CHARS} chars` });
  }
  const author = authorFor(body?.author);
  if (!author) return ctx.j(400, { error: 'author required' });
  const context = parseVoiceContext(body?.context);
  // Dictated on the page rather than typed; the lead reads it the same way.
  const via = body?.via === 'voice' ? 'voice' : 'chat';
  const res = ctx.leadChat.post(
    workspaceId,
    { id: author.id, name: author.name },
    text,
    context,
    via,
  );
  if (!res.ok) return ctx.j(500, { error: res.error });
  return ctx.j(201, { message: res.message });
}
