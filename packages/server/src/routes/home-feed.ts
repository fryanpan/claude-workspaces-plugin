/**
 * ── The home feed: one board's review items for Bryan's Home elsewhere ──
 *
 *   GET /workspaces/:ws/home-feed                one board's open items in
 *                                                the fixed schema (`home-feed.ts`)
 *   GET /workspaces/:ws/home-feed/events:stream  `landing.changed` frames, no
 *                                                content, when any item may
 *                                                have moved
 *   POST /workspaces/:ws/home-feed/escalation-ack  `{deadSince}`: Team Lead
 *                                                there holds this board's dead
 *                                                stretch, so its owner item
 *                                                is not filed (`stall-escalation.ts`)
 *
 * A project server answers these; the Mac's server is the only intended
 * caller, and it calls OUT (`home-remotes.ts`). Both paths sit under
 * `/workspaces/<board>/` so the board router Worker routes them to the server
 * that holds the board, at its project's own address, with no second table.
 *
 * Answered ABOVE request admission, with a gate of its own, because the
 * Mac's request carries no person. It arrives through Access with a service
 * token, and admission refuses a stamp that names nobody. So this route asks
 * for exactly one of two callers and nothing else:
 *
 *  - a process on this machine: a loopback peer with no `cf-ray`;
 *  - through the tunnel: a stamp signed for the Access application in front
 *    of the host it arrived on (that host's `CF_ACCESS_HOST_AUDS` entry, else
 *    `CF_ACCESS_AUD`, checked against Cloudflare's keys), so a stamp another
 *    project's application minted is refused, that names no email and whose `common_name` is the
 *    service token client id this server was configured with
 *    (`CW_HOME_FEED_CLIENT_ID`). A person's stamp, a share visitor's, or
 *    another service token's is refused.
 *
 *  - through the tunnel under `CW_SIGNIN=better-auth`, where no Access
 *    application is in front: a board agent token (`at2`,
 *    `auth/board-agent-token.ts`) minted for the board this path names, from
 *    no browser. This is how the Mac pulls once Access is gone
 *    (`home-remotes.ts` `boardTokens`). In `access` and `both` the service
 *    token above is still the only tunnel caller, with or without an `at2`.
 *
 * The external-access master switch covers every caller through the tunnel:
 * while it is off, a request carrying `cf-ray` is refused before any of the
 * checks above runs (`refuseWhileExternalAccessOff`), so a live service token
 * and no credential at all get the same answer. A process on this machine is
 * not external reach and is unaffected, as it is everywhere else.
 *
 * With no client id configured and no token presented, only the first caller
 * is admitted. The two
 * answers carry nothing a board member could not read on the board itself,
 * and the stream frames name no board and no content (`landing-changes.ts`).
 */
import { type BoardAgentClaims, boardAgentBearerOf } from '../auth/board-agent-token.ts';
import type { HomeFeedFollowers } from '../home-feed-followers.ts';
import type { HomeFeed } from '../home-feed.ts';
import { LANDING_CHANNEL } from '../landing-changes.ts';
import type { CfAccessVerifier } from '../middleware/cf-access.ts';
import { isLoopbackAddress } from '../middleware/host-guard.ts';
import { isBrowserRequest } from '../middleware/write-gate.ts';
import { type SseBus, openSseStream } from '../sse.ts';

const FEED_PATH =
  /^\/workspaces\/([A-Za-z0-9_-]{1,128})\/home-feed(\/events:stream|\/escalation-ack)?$/;

export interface HomeFeedRoutesContext {
  sse: SseBus;
  /** The board's name, or undefined when this server holds no such board. */
  boardName: (workspaceId: string) => string | undefined;
  /** The board's feed, read off the cross-board queue. */
  feed: (workspaceId: string) => Promise<HomeFeed>;
  /** The per-host Access verifier, or null when none is configured. */
  verifier: CfAccessVerifier | null;
  /** The Access service token client id the Mac pulls with, or undefined. */
  clientId: string | undefined;
  /** The connection's own peer address. */
  peerAddress: (req: Request) => string | undefined;
  /** The claims an `at2` still attests to, or null. Absent: no token admits. */
  boardGrantFor?: (bearer: string) => BoardAgentClaims | null;
  /** Whether an Access application fronts this server's hosts. */
  accessInFront?: () => boolean;
  /** The external-access master switch (`SharingGate.isEnabled`). */
  externalAccessOpen: () => boolean;
  /** Team Lead on the caller's machine holds the stretch that began at
   *  `deadSince`; true when that is the board's current one. Absent → 404. */
  ackEscalation?: (workspaceId: string, deadSince: number) => boolean;
  /** Team Lead's agent id on this server (`spawnerAgentId`): with no Access
   *  in front, the only agent whose `at2` may send the escalation ack. */
  teamLeadAgentId?: () => string | undefined;
  /** Who follows which board's feed (`home-feed-followers.ts`). */
  followers?: HomeFeedFollowers;
  j: (status: number, body: unknown) => Response;
}

/**
 * The external-access master switch, for a family answered above admission.
 *
 * Admission applies the switch to every external host kind, and these
 * families answer before admission runs, so each asks it here instead:
 * first, before its own caller check, so that while the switch is off a valid
 * credential and none at all are indistinguishable. "External" is "through
 * the tunnel" (`cf-ray`), the rule the frame hostname uses: a loopback or
 * tailnet caller is on this side of the outside door, which is how the owner
 * turns the switch back on.
 *
 * The refusal is admission's own (`403 sharing_disabled`), so a caller sees
 * one answer for "the outside door is shut" whichever door it knocked on.
 */
export function refuseWhileExternalAccessOff(
  ctx: Pick<HomeFeedRoutesContext, 'externalAccessOpen' | 'j'>,
  req: Request,
): Response | null {
  if (!req.headers.has('cf-ray') || ctx.externalAccessOpen()) return null;
  return ctx.j(403, { error: 'sharing_disabled' });
}

type CallerContext = Pick<
  HomeFeedRoutesContext,
  'verifier' | 'clientId' | 'peerAddress' | 'boardGrantFor' | 'accessInFront' | 'teamLeadAgentId'
>;

/** Whether this caller may read a home feed. Never says which check failed. */
export async function homeFeedCallerAllowed(
  ctx: CallerContext,
  req: Request,
  /** The board the path names; without one, no board token admits. */
  boardId?: string,
): Promise<boolean> {
  if (!req.headers.has('cf-ray')) return isLoopbackAddress(ctx.peerAddress(req));
  return macCallerAllowed(ctx, req, boardId);
}

/**
 * The Mac's own credential, through the tunnel. With no Access in front, the
 * board's `at2` is the proof, and `agentId`, when given, must be the agent it
 * was minted for. Where Access is in front, only the feed's service token
 * is, with or without one.
 */
async function macCallerAllowed(
  ctx: CallerContext,
  req: Request,
  boardId: string | undefined,
  agentId?: string,
): Promise<boolean> {
  if (ctx.accessInFront?.() === false) {
    const bearer = boardAgentBearerOf(req.headers);
    if (bearer === null || !boardId || !ctx.boardGrantFor) return false;
    if (isBrowserRequest(req.headers)) return false;
    const grant = ctx.boardGrantFor(bearer);
    if (grant?.boardId !== boardId) return false;
    return agentId === undefined || grant.agentId === agentId;
  }
  if (!ctx.verifier || !ctx.clientId) return false;
  const result = await ctx.verifier(req);
  return result.ok && result.email === undefined && result.commonName === ctx.clientId;
}

/**
 * Who may tell this board that Team Lead on the Mac holds it: the Mac and
 * nobody else. Unlike a feed read, a loopback caller is refused, since a
 * process on this machine (the dead board's own lead among them) must not
 * be able to keep the owner's item off; and with no Access in front the
 * `at2` must be one minted for Team Lead, not the board's lead's.
 */
export async function escalationAckCallerAllowed(
  ctx: CallerContext,
  req: Request,
  boardId: string,
): Promise<boolean> {
  if (!req.headers.has('cf-ray')) return false;
  if (ctx.accessInFront?.() === false) {
    const teamLead = ctx.teamLeadAgentId?.();
    if (!teamLead) return false;
    return macCallerAllowed(ctx, req, boardId, teamLead);
  }
  return macCallerAllowed(ctx, req, boardId);
}

export async function handleHomeFeedRoute(
  ctx: HomeFeedRoutesContext,
  req: Request,
  pathname: string,
): Promise<Response | null> {
  const m = FEED_PATH.exec(pathname);
  if (!m) return null;
  const boardId = m[1] as string;
  const shut = refuseWhileExternalAccessOff(ctx, req);
  if (shut) return shut;
  if (m[2] === '/escalation-ack') {
    if (!(await escalationAckCallerAllowed(ctx, req, boardId))) {
      return ctx.j(403, { error: 'forbidden' });
    }
    return ackRoute(ctx, req, boardId);
  }
  if (!(await homeFeedCallerAllowed(ctx, req, boardId))) {
    return ctx.j(403, { error: 'forbidden' });
  }
  if (req.method !== 'GET') return ctx.j(405, { error: 'method-not-allowed' });
  if (ctx.boardName(boardId) === undefined) return ctx.j(404, { error: 'not_found' });
  if (m[2]) {
    // Closed when the caller goes: a follower is one holding the stream.
    const close = ctx.followers?.opened(boardId);
    if (close) req.signal.addEventListener('abort', close, { once: true });
    // A tunnel caller's stream is marked so the master switch hangs it up
    // when external access goes off; the check above only stops new ones.
    const external = req.headers.has('cf-ray');
    return openSseStream(
      ctx.sse,
      LANDING_CHANNEL,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      external,
    );
  }
  ctx.followers?.read(boardId);
  return ctx.j(200, await ctx.feed(boardId));
}

/** The most bytes an acknowledgement body may be. */
const MAX_ACK_BYTES = 256;

/** The body as text, or null once it passes `max` bytes; never reads more
 *  than one chunk past the cap. */
async function readBounded(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function ackRoute(ctx: HomeFeedRoutesContext, req: Request, boardId: string) {
  if (req.method !== 'POST') return ctx.j(405, { error: 'method-not-allowed' });
  if (!ctx.ackEscalation || ctx.boardName(boardId) === undefined) {
    return ctx.j(404, { error: 'not_found' });
  }
  const raw = await readBounded(req, MAX_ACK_BYTES);
  if (raw === null) return ctx.j(413, { error: 'too_large' });
  let deadSince: unknown;
  try {
    deadSince = (JSON.parse(raw) as { deadSince?: unknown })?.deadSince;
  } catch {
    return ctx.j(400, { error: 'bad_json' });
  }
  if (typeof deadSince !== 'number' || !Number.isSafeInteger(deadSince) || deadSince <= 0) {
    return ctx.j(400, { error: 'bad_dead_since' });
  }
  return ctx.j(200, { held: ctx.ackEscalation(boardId, deadSince) });
}
