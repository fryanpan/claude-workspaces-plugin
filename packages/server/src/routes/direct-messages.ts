/**
 * `GET` / `POST /workspaces/<id>/me/dm` — a person's one-to-one messages with
 * the other people on a board (M10's direct-message channels).
 *
 * - `GET` with no query: the channel list. Who the reader is, the board's
 *   other people, and the reader's own lead agent when they linked one (that
 *   conversation is `/api/me/messages`, `routes/private-messages.ts`).
 * - `GET ?with=<personId>`: the conversation with that person, a page back
 *   with `before=<messageId>`.
 * - `POST {to, text}`: write to that person.
 *
 * Whose messages these are is decided by the proof alone: a person's session
 * cookie or Access assertion (`provenIdentityFor`). A request carrying any
 * `Authorization` header is refused, which covers the widget token and both
 * agent tokens, and so is a board agent's socket proof. Both people must be
 * on THIS board — the owner, or a member through its audience — so the path's
 * board is what limits who can be named, and a member cannot reach someone
 * on another board through this one.
 *
 * Delivery is each person's own `person~<id>` stream and nothing else: a
 * direct message is never broadcast on a board channel, written to the lead
 * chat, or queued for an agent.
 */
import {
  DIRECT_MESSAGE_EVENT,
  type DirectChannels,
  type DirectMessage,
  type DirectPeer,
  MAX_DIRECT_MESSAGE,
} from '@claude-workspaces/core/direct-messages';
import type { DirectMessageStore } from '../direct-messages.ts';
import type { SseBus } from '../sse.ts';
import type { WorkspaceRouteRequest } from './workspace-routes-context.ts';

export interface DirectMessageRoutesContext {
  store: DirectMessageStore;
  /** Every active person on this board, the owner included, with the name
   *  the server holds for them. */
  peopleOn: (workspaceId: string) => DirectPeer[];
  /** The agent a person linked as their lead, or null. */
  leadAgentOf: (personId: string) => string | null;
  agentName: (agentId: string) => string;
  sse: Pick<SseBus, 'broadcast'>;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
}

const ID = /^[A-Za-z0-9_~.@+-]{1,200}$/;

export async function handleDirectMessageRoutes(
  ctx: DirectMessageRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const { req, scope } = rq;
  if (!scope || scope.rest !== 'me/dm') return undefined;
  if (req.method !== 'GET' && req.method !== 'POST') return undefined;
  const { j } = ctx;
  if (rq.boardAgent || req.headers.has('authorization')) {
    return j(403, { error: 'person_proof_required' });
  }
  const me = rq.provenIdentityFor?.() ?? null;
  if (!me || me.kind !== 'person') {
    // The list for nobody is no channels, so a page open without a sign-in
    // (the owner on loopback) logs no failed request. Reads and sends refuse.
    if (req.method === 'GET' && !rq.url.searchParams.has('with')) {
      const none: DirectChannels = { me: null, people: [], lead: null };
      return j(200, none);
    }
    return j(401, { error: 'not_signed_in' });
  }
  const people = ctx.peopleOn(scope.workspaceId);
  if (!people.some((p) => p.id === me.id)) return j(403, { error: 'not_on_this_board' });
  const others = people.filter((p) => p.id !== me.id);

  if (req.method === 'GET') {
    const withId = rq.url.searchParams.get('with');
    if (withId === null) {
      const agentId = ctx.leadAgentOf(me.id);
      const answer: DirectChannels = {
        me: { id: me.id, name: me.displayName },
        people: others,
        lead: agentId ? { agentId, name: ctx.agentName(agentId) } : null,
      };
      return j(200, answer);
    }
    if (!others.some((p) => p.id === withId)) return j(404, { error: 'not_on_this_board' });
    const before = rq.url.searchParams.get('before');
    if (before !== null && !ID.test(before)) return j(400, { error: 'bad_before' });
    return j(200, ctx.store.page(me.id, withId, before ? { before } : {}));
  }

  const body = await ctx.safeJson(req);
  const to = typeof body?.to === 'string' ? body.to : '';
  if (!others.some((p) => p.id === to)) return j(404, { error: 'not_on_this_board' });
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > MAX_DIRECT_MESSAGE) return j(400, { error: 'invalid_text' });
  const message = ctx.store.append({ id: me.id, name: me.displayName }, to, text);
  tell(ctx, scope.workspaceId, message);
  return j(200, { ok: true, message });
}

/** Both people's own streams: the other person's tabs, and the writer's
 *  other tabs. */
function tell(ctx: DirectMessageRoutesContext, workspaceId: string, message: DirectMessage): void {
  const frame = { event: DIRECT_MESSAGE_EVENT, workspaceId, message };
  ctx.sse.broadcast(`person~${message.to}`, frame);
  ctx.sse.broadcast(`person~${message.author.id}`, frame);
}
