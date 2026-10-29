/**
 * The door a board-scoped agent token (`at2`, `auth/board-agent-token.ts`)
 * comes in through, and what it may reach once in.
 *
 * Run by `request-admission.ts` for any request carrying an `at2` bearer,
 * after the host is classified and the master switch has answered, and
 * instead of every other branch: a request that presents this token is
 * judged by it and nothing else, so it can never fall back onto the wider
 * grant its host would otherwise give.
 *
 * Two hosts honour it:
 *
 * - **The operator's proxied hostname** (`proxied-local`), through the
 *   tunnel. The Access application in front of it must have admitted the
 *   request — a service token, which names no email, is exactly what is
 *   expected — and then the token, not the email allowlist, says who.
 * - **A local hostname from a loopback peer**, off the tunnel. A caller on
 *   this machine could omit the token and be trusted-local; presenting one
 *   only narrows it, which is what a test or a co-located relay wants.
 *
 * Every other host refuses it, and so does a browser: the holder is a
 * process, and a page carrying one is a token lifted from somewhere.
 *
 * What it reaches is `collabScope` with its own board as the only board it
 * is a member of — the allowlist a board member is judged by, so the operator
 * verbs a member is refused (Mac paths, mounts, deploy, share administration,
 * the doc list, every other board) are refused here by the same lines, and a
 * route added to one is added to both — plus its own watch set, which the
 * route then filters to that board.
 */
import type { BoardAgentClaims } from '../auth/board-agent-token.ts';
import { boardAgentMemberKey } from '../auth/board-agent-token.ts';
import type { CfAccessResult } from './cf-access.ts';
import { type ShareTarget, collabScope, isLoopbackAddress } from './host-guard.ts';
import { isBrowserRequest } from './write-gate.ts';

export interface BoardAgentDoorInput {
  req: Request;
  pathname: string;
  /** What `classifyHost` decided for this request. */
  hostKind: string;
  /** The `at2` value presented. */
  bearer: string;
  /** The request's socket peer address. */
  address: string | undefined;
  /** The Access verifier for the operator's proxied hostname, or null. */
  proxiedVerifier: ((req: Request) => Promise<CfAccessResult>) | null;
  /** The claims a bearer still attests to (MAC, record, not revoked), or null. */
  grantFor: (bearer: string) => BoardAgentClaims | null;
  /** Every workspace an id belongs to, as `collabScope` asks it. */
  workspacesOf: (id: string) => string[];
  j: (status: number, body: unknown) => Response;
}

export type BoardAgentDoorVerdict =
  | { ok: false; response: Response }
  | { ok: true; grant: BoardAgentClaims; target: ShareTarget; memberKey: string };

const WATCHES_PATH = /^\/api\/agents\/([^/]+)\/watches$/;

/**
 * May this token reach this path? Its own watch set, its own renewal, or what
 * a member of its one board may reach on that board. A path naming no board — the app shell,
 * the session probe — is refused: a process has no page to render.
 */
export function boardAgentScopeAllows(
  pathname: string,
  method: string,
  grant: BoardAgentClaims,
  workspacesOf: (id: string) => string[],
): boolean {
  // Renewing itself: the route answers a fresh value for this token's own
  // record and nothing else (`routes/board-tokens.ts`).
  if (pathname === '/api/board-tokens/refresh') return method.toUpperCase() === 'POST';
  const watches = pathname.match(WATCHES_PATH);
  if (watches) {
    const m = method.toUpperCase();
    return decoded(watches[1] ?? '') === grant.agentId && (m === 'GET' || m === 'POST');
  }
  const scope = collabScope(pathname, method, {
    workspacesOf,
    isMember: (workspaceId) => workspaceId === grant.boardId,
  });
  return scope.allowed && scope.target.workspaceId === grant.boardId;
}

export async function admitBoardAgent(input: BoardAgentDoorInput): Promise<BoardAgentDoorVerdict> {
  const { req, pathname, hostKind, j } = input;
  const refuse = (status: number, error: string): BoardAgentDoorVerdict => ({
    ok: false,
    response: j(status, { error }),
  });
  if (hostKind === 'proxied-local') {
    if (!input.proxiedVerifier) return refuse(503, 'access_not_configured');
    const result = await input.proxiedVerifier(req);
    if (!result.ok) return { ok: false, response: j(result.status, { error: result.error }) };
  } else if (hostKind === 'local') {
    if (req.headers.has('cf-ray') || !isLoopbackAddress(input.address)) {
      return refuse(403, 'board_token_remote');
    }
  } else {
    return refuse(403, 'board_token_host');
  }
  if (isBrowserRequest(req.headers)) return refuse(403, 'board_token_browser');
  // Forged, tampered, never issued, revoked, or disagreeing with its record:
  // one answer, so a caller learns nothing about which check refused.
  const grant = input.grantFor(input.bearer);
  if (!grant) return refuse(401, 'board_token_invalid');
  if (!boardAgentScopeAllows(pathname, req.method, grant, input.workspacesOf)) {
    return refuse(403, 'out_of_board_token_scope');
  }
  return {
    ok: true,
    grant,
    target: { workspaceId: grant.boardId },
    memberKey: boardAgentMemberKey(grant.boardId, grant.tokenId),
  };
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
