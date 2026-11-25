/**
 * `POST /voice-agent/v1/chat/completions` — ElevenLabs' agent asking this
 * server what setup 4 should say (`spoken-reply/agent-llm.ts` has the wire).
 *
 * Reached from ElevenLabs' servers through the edge, on the vendor callback
 * hostname (`CW_RECALL_CALLBACK_HOST`), which has no Cloudflare Access in
 * front of it and admits this path only while setup 4 is configured
 * (`middleware/recall-callback-gate.ts`). On every other host it is behind
 * whatever that host demands, and a share or collaboration visitor's scope
 * allowlist does not list it.
 *
 * THE ORDER OF THE REFUSALS:
 *  1. Not configured — 404. With no secret there is no credential to check,
 *     so this is not a door that can be knocked on.
 *  2. A share visitor — 404, whatever it carries. Belt to the scope gate's
 *     braces: this route answers a vendor and the owner's own machine.
 *  3. The bearer secret, in constant time — 401, before the body is read.
 *  4. The body: size, JSON, shape — 413 / 400.
 *  5. The callback token — 404 when no open socket holds it.
 */
import {
  AGENT_LLM_MAX_BODY_BYTES,
  type AgentCallbacks,
  VOICE_AGENT_LLM_PATH,
  agentLlmResponse,
  bearerMatches,
  parseAgentLlmRequest,
} from '../spoken-reply/agent-llm.ts';
import { type RouteRow, rowHandlers } from './row-dispatch.ts';

export interface VoiceAgentLlmRoutesContext {
  callbacks: AgentCallbacks;
  /** The LLM secret, or null while setup 4 is not configured. */
  llmSecret: string | null;
  j: (status: number, body: unknown) => Response;
}

export interface VoiceAgentLlmRouteRequest {
  req: Request;
  /** The route-table row the router matched. */
  row: RouteRow;
  /** The request arrived as a share-link visitor (a share or collab scope). */
  shareVisitor: boolean;
}

export async function handleVoiceAgentLlmRoute(
  ctx: VoiceAgentLlmRoutesContext,
  rq: VoiceAgentLlmRouteRequest,
): Promise<Response | undefined> {
  return (await ROWS(ctx, rq)) ?? undefined;
}

const ROWS = rowHandlers('voice-agent-llm.ts', { [VOICE_AGENT_LLM_PATH]: answer });

async function answer(
  ctx: VoiceAgentLlmRoutesContext,
  rq: VoiceAgentLlmRouteRequest,
): Promise<Response | undefined> {
  const { req } = rq;
  if (req.method !== 'POST') return undefined;
  const { j } = ctx;
  const secret = ctx.llmSecret;
  if (!secret || rq.shareVisitor) return j(404, { error: 'not_found' });
  if (!bearerMatches(req.headers.get('authorization'), secret)) {
    return j(401, { error: 'unauthorized' });
  }
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > AGENT_LLM_MAX_BODY_BYTES) return j(413, { error: 'too_large' });
  const raw = await req.text();
  if (raw.length > AGENT_LLM_MAX_BODY_BYTES) return j(413, { error: 'too_large' });
  const parsed = parseAgentLlmRequest(raw);
  if (!parsed) return j(400, { error: 'bad_request' });
  const answering = ctx.callbacks.answer(parsed.token, parsed.question);
  if (!answering) return j(404, { error: 'unknown_session' });
  let spoken: string;
  try {
    spoken = await answering;
  } catch {
    return j(502, { error: 'answer_failed' });
  }
  return agentLlmResponse(spoken, parsed.stream);
}
