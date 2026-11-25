/**
 * ── The voice conversation API: talk to an agent from any OpenAI client ──
 *
 *   GET  /v1/models                     the agents, one model each
 *   POST /v1/chat/completions           one turn; `model` is the agent
 *   GET  /api/voice/tokens              the owner's tokens, without values
 *   POST /api/voice/tokens              mint one: `{ label }`; the value once
 *   POST /api/voice/tokens/<id>/revoke  revoke one
 *
 * The two `/v1/` routes take ONLY a voice API bearer (`voice-api/tokens.ts`):
 * no cookie, no Access identity, no agent or widget token counts, so a page
 * on another site cannot ride the owner's sign-in into them. The token
 * routes are the owner's alone, gated as the voice page's list is
 * (`voice-page.ts`), and, through the tunnel, only for a proven owner; a
 * browser's POST must come from this server's own origin. A native sign-in would mint through the same `mint` call.
 *
 * The wire format is `voice-api/protocol.ts`; the contract is
 * `docs/architecture/voice-conversation-api.md`.
 */
import type { VoiceChat } from '../voice-api/chat.ts';
import { apiError, bearerOf, modelList, parseChatRequest } from '../voice-api/protocol.ts';
import type { VoiceApiTokens } from '../voice-api/tokens.ts';
import { rowHandlers } from './row-dispatch.ts';
import {
  type VoicePageRouteRequest,
  type VoicePageRoutesContext,
  refuseNonOwner,
} from './voice-page.ts';

export interface VoiceApiRoutesContext {
  chat: VoiceChat;
  tokens: VoiceApiTokens;
  /** The display name of the person a token speaks for. */
  speakerName: (subject: string) => string;
  /** Who a token minted by this request speaks for. */
  mintSubject: () => string;
  j: VoicePageRoutesContext['j'];
}

export type VoiceApiRouteRequest = VoicePageRouteRequest & {
  /** This server's own origin, or undefined when it cannot say. */
  requestOrigin: () => string | undefined;
  /** The request came through the Cloudflare tunnel. */
  viaTunnel: () => boolean;
};

const MAX_BODY = 512 * 1024;
/** A voice token's id: any other segment in its place is not a revoke. */
const TOKEN_ID = /^[A-Za-z0-9_-]{16,64}$/;

async function readJson(req: Request): Promise<unknown | 'too-large'> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > MAX_BODY) return 'too-large';
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_BODY) return 'too-large';
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return null;
  }
}

async function handleApi(
  ctx: VoiceApiRoutesContext,
  rq: VoiceApiRouteRequest,
  verb: 'models' | 'chat',
): Promise<Response> {
  const { j } = ctx;
  // A share or collab visitor holds no voice token, and is refused first
  // so nothing here reads its bearer.
  if (rq.visitor) return j(403, { error: 'not available to share visitors' });
  const fail = (e: { status: number; body: unknown }) => j(e.status, e.body);
  const token = ctx.tokens.verify(bearerOf(rq.req.headers));
  if (!token) {
    return fail(apiError(401, 'invalid_api_key', 'Send a voice API token as a Bearer.'));
  }
  if (verb === 'models') {
    if (rq.req.method !== 'GET') return fail(apiError(405, 'method_not_allowed', 'GET only.'));
    return j(200, modelList(ctx.chat.models()));
  }
  if (rq.req.method !== 'POST') return fail(apiError(405, 'method_not_allowed', 'POST only.'));
  const body = await readJson(rq.req);
  if (body === 'too-large') return fail(apiError(413, 'too_large', 'The body is too large.'));
  const turn = parseChatRequest(body, rq.req.headers.get('x-conversation-id'), token.id);
  if ('status' in turn) return fail(turn);
  const answered = await ctx.chat.turn(turn, {
    id: token.subject,
    name: ctx.speakerName(token.subject),
  });
  return answered instanceof Response ? answered : fail(answered);
}

/** The token list and mint, or (with `revokeId`) one token's revoke. */
async function handleTokens(
  ctx: VoiceApiRoutesContext,
  rq: VoiceApiRouteRequest,
  revokeId: string | null,
): Promise<Response> {
  const { j, tokens } = ctx;
  const denied = refuseNonOwner(ctx, rq);
  if (denied) return denied;
  // Through the tunnel, proving nobody is not enough to mint: an Access
  // service token names no person, and a phone holding one must not be able
  // to mint itself more voice tokens.
  if (rq.viaTunnel() && !rq.ownerProven()) {
    return j(403, { error: 'owner-only', message: 'Sign in as the owner to manage voice tokens.' });
  }
  if (rq.req.method !== 'GET') {
    // A browser's write comes from this server's own pages or not at all.
    const origin = rq.req.headers.get('origin');
    if (origin !== null && origin !== rq.requestOrigin()) {
      return j(403, { error: 'same-origin-only', message: 'Use this server’s own pages.' });
    }
  }
  if (revokeId !== null) {
    if (rq.req.method !== 'POST') return j(405, { error: 'method not allowed' });
    return tokens.revoke(revokeId) ? j(200, { ok: true }) : j(404, { error: 'not_found' });
  }
  if (rq.req.method === 'GET') return j(200, { tokens: tokens.list() });
  if (rq.req.method !== 'POST') return j(405, { error: 'method not allowed' });
  const body = await readJson(rq.req);
  if (body === 'too-large') return j(413, { error: 'too-large' });
  const label = (body as { label?: unknown } | null)?.label;
  const { record, token } = tokens.mint(typeof label === 'string' ? label : '', ctx.mintSubject());
  return j(201, { ...record, token });
}

export async function handleVoiceApiRoutes(
  ctx: VoiceApiRoutesContext,
  rq: VoiceApiRouteRequest,
): Promise<Response | null> {
  return ROWS(ctx, rq);
}

const ROWS = rowHandlers<VoiceApiRoutesContext, VoiceApiRouteRequest, Promise<Response | null>>(
  'voice-api.ts',
  {
    '/v1/models': (ctx, rq) => handleApi(ctx, rq, 'models'),
    '/v1/chat/completions': (ctx, rq) => handleApi(ctx, rq, 'chat'),
    '/api/voice/tokens': (ctx, rq) => handleTokens(ctx, rq, null),
    '/api/voice/tokens/:id/revoke': async (ctx, rq) => {
      const id = rq.row.params.id ?? '';
      return TOKEN_ID.test(id) ? handleTokens(ctx, rq, id) : null;
    },
  },
);
