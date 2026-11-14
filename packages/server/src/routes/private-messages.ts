/**
 * A person's private conversation with their own lead agent.
 *
 * - `GET` / `POST /api/me/messages`: the person's side. Whose conversation is
 *   decided by the proof alone (an Access assertion or a session cookie, via
 *   `provenIdentityFor`), and the agent is always that person's linked lead
 *   agent (`person-agent-link.ts`), never a body or query field. A request
 *   carrying any `Authorization` header is refused, which covers the widget
 *   token and both agent tokens, and so is every share visitor.
 * - `POST /api/agents/<id>/messages/<personId>`: the agent's reply. Behind the
 *   agent's own `at1` (loopback, not a browser, no cf-ray) or an `at2` whose
 *   agent is `<id>`, and refused unless `<personId>` is the person linked to
 *   that agent.
 *
 * Delivery never touches a board channel's broadcast. Person to agent: one
 * comment-queue row for that agent alone, so a down stream costs latency and
 * not the message, then `sendToAgent` on its own stream. Agent to person, and
 * the person's own sends for their other tabs: the `person~<id>` channel,
 * which only that person's proof opens (`routes/upgrade-stream.ts`).
 */
import { isValidAgentId } from '../agent-watches.ts';
import { authorizeAgentCaller } from '../auth/agent-token.ts';
import type { BoardAgentClaims } from '../auth/board-agent-token.ts';
import type { Identities, IdentityRecord } from '../identities.ts';
import type { ShareTarget } from '../middleware/host-guard.ts';
import type { PersonAgentLinks } from '../person-agent-link.ts';
import type { PrivateMessage, PrivateMessageStore } from '../private-messages.ts';
import type { SseBus } from '../sse.ts';
import type { TaskStore } from '../tasks.ts';

/** The longest message accepted, in characters. */
export const MAX_PRIVATE_MESSAGE = 8000;

export interface PrivateMessageRoutesContext {
  store: PrivateMessageStore;
  personAgentLinks: Pick<PersonAgentLinks, 'leadAgentOf' | 'personOfAgent'>;
  identities: Pick<Identities, 'get'>;
  taskStore: Pick<TaskStore, 'queueComment' | 'markCommentEmitted'>;
  sse: Pick<SseBus, 'sendToAgent' | 'broadcast'>;
  /** The board whose stream an agent's private messages ride, or null when
   *  it is attached nowhere. */
  boardForAgent: (agentId: string) => string | null;
  requestAddress: (req: Request) => string | undefined;
  agentTokenKey: () => string;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
}

export interface PrivateMessageRouteRequest {
  req: Request;
  pathname: string;
  visitor: ShareTarget | null;
  boardAgent: BoardAgentClaims | null;
  provenIdentityFor: () => IdentityRecord | null;
}

const AGENT_REPLY = /^\/api\/agents\/([^/]+)\/messages\/([^/]+)$/;

export async function handlePrivateMessageRoutes(
  ctx: PrivateMessageRoutesContext,
  rq: PrivateMessageRouteRequest,
): Promise<Response | undefined> {
  const { req, pathname } = rq;
  if (pathname === '/api/me/messages') {
    if (req.method === 'GET') return personSide(ctx, rq, 'read');
    if (req.method === 'POST') return personSide(ctx, rq, 'send');
    return undefined;
  }
  const reply = pathname.match(AGENT_REPLY);
  if (reply && req.method === 'POST') {
    return agentReply(ctx, rq, decode(reply[1]), decode(reply[2]));
  }
  return undefined;
}

async function personSide(
  ctx: PrivateMessageRoutesContext,
  rq: PrivateMessageRouteRequest,
  verb: 'read' | 'send',
): Promise<Response> {
  const { j } = ctx;
  const { req } = rq;
  if (rq.visitor || rq.boardAgent) return j(403, { error: 'person_proof_required' });
  if (req.headers.has('authorization')) return j(403, { error: 'person_proof_required' });
  const person = rq.provenIdentityFor();
  if (!person || person.kind !== 'person') return j(401, { error: 'not_signed_in' });
  const agentId = ctx.personAgentLinks.leadAgentOf(person.id);
  if (agentId === null) {
    return j(409, {
      error: 'no_lead_agent',
      message: 'Name your lead agent in your profile, and have it confirm you, first.',
    });
  }
  if (verb === 'read') {
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get('limit') ?? '');
    const before = url.searchParams.get('before') ?? undefined;
    const page = ctx.store.page(person.id, agentId, {
      ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      ...(before ? { before } : {}),
    });
    return j(200, { agentId, ...page });
  }
  const text = await textOf(ctx, req);
  if (text === null) return j(400, { error: 'invalid_text' });
  const message = ctx.store.append({
    personId: person.id,
    agentId,
    from: 'person',
    author: { id: person.id, name: person.displayName },
    text,
  });
  const queued = deliverToAgent(ctx, message);
  tellPerson(ctx, message);
  return j(200, { ok: true, agentId, message, queued });
}

async function agentReply(
  ctx: PrivateMessageRoutesContext,
  rq: PrivateMessageRouteRequest,
  agentId: string,
  personId: string,
): Promise<Response> {
  const { j } = ctx;
  const { req, boardAgent } = rq;
  if (rq.visitor && !boardAgent) return j(403, { error: 'not available to share visitors' });
  if (!isValidAgentId(agentId) || !personId) return j(400, { error: 'bad_path' });
  if (boardAgent) {
    if (agentId !== boardAgent.agentId) return j(403, { error: 'out_of_board_token_scope' });
  } else {
    const allowed = authorizeAgentCaller({
      agentId,
      req,
      address: ctx.requestAddress(req),
      key: ctx.agentTokenKey(),
      requireToken: true,
    });
    if (!allowed.ok) return j(allowed.status, allowed.body);
  }
  if (ctx.personAgentLinks.personOfAgent(agentId) !== personId) {
    return j(403, { error: 'not_your_person' });
  }
  const text = await textOf(ctx, req);
  if (text === null) return j(400, { error: 'invalid_text' });
  const message = ctx.store.append({
    personId,
    agentId,
    from: 'agent',
    author: { id: agentId, name: ctx.identities.get(agentId)?.displayName ?? agentId },
    text,
  });
  tellPerson(ctx, message);
  return j(200, { ok: true, message });
}

/** The frame both sides read. */
function frameOf(message: PrivateMessage): Record<string, unknown> & { event: string } {
  return {
    event: 'private.message',
    messageId: message.id,
    personId: message.personId,
    agentId: message.agentId,
    from: message.from,
    author: message.author,
    text: message.text,
    ts: message.ts,
  };
}

/** Queue the message for the agent alone, then hand it to its own stream.
 *  False when the agent is attached to no board, so there is no stream or
 *  queue to put it on; the log still holds it. */
function deliverToAgent(ctx: PrivateMessageRoutesContext, message: PrivateMessage): boolean {
  const board = ctx.boardForAgent(message.agentId);
  if (board === null) return false;
  const frame = { ...frameOf(message), workspaceId: board };
  const rowId = ctx.taskStore.queueComment(board, {
    agentId: message.agentId,
    docId: `private:${message.personId}`,
    event: frame.event,
    author: message.author,
    text: message.text,
    payload: frame,
  });
  if (rowId === false) return false;
  const queuedFrame = { ...frame, commentQueueId: rowId };
  const sent = ctx.sse.sendToAgent(`ws~${board}`, message.agentId, queuedFrame);
  if (sent > 0) ctx.taskStore.markCommentEmitted(board, rowId);
  return true;
}

function tellPerson(ctx: PrivateMessageRoutesContext, message: PrivateMessage): void {
  ctx.sse.broadcast(`person~${message.personId}`, frameOf(message));
}

async function textOf(ctx: PrivateMessageRoutesContext, req: Request): Promise<string | null> {
  const body = await ctx.safeJson(req);
  const raw = body?.text;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return text && text.length <= MAX_PRIVATE_MESSAGE ? text : null;
}

function decode(raw: string | undefined): string {
  try {
    return decodeURIComponent(raw ?? '');
  } catch {
    return '';
  }
}
