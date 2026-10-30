/**
 * The folders a board's walled lead can write, its projects
 * (`board-socket-roots.ts`):
 *
 *   GET /api/board-sockets/<board>/roots   the list
 *   PUT /api/board-sockets/<board>/roots   replace it: `{ roots: string[] }`
 *
 * Loopback only, like the board token routes beside it: refused through the
 * edge (`cf-ray`), from a peer that is not loopback, from a browser and from
 * every visitor. A request on a board's own socket is a visitor, so a walled
 * lead can never widen its own list; `scripts/lead-sandbox.ts` writes it,
 * from outside the wall, as it launches the lead.
 */
import { refuseNonLocalAgentCaller } from '../auth/agent-token.ts';
import { isValidBoardId } from '../auth/board-agent-token.ts';
import type { BoardSocketRoots } from '../board-socket-roots.ts';
import type { ShareTarget } from '../middleware/host-guard.ts';

export interface BoardSocketRootsRoutesContext {
  roots: BoardSocketRoots;
  boardExists: (boardId: string) => boolean;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  requestAddress: (req: Request) => string | undefined;
}

export interface BoardSocketRootsRouteRequest {
  req: Request;
  pathname: string;
  visitor: ShareTarget | null;
}

const ROOTS_PATH = /^\/api\/board-sockets\/([^/]+)\/roots$/;

export async function handleBoardSocketRootsRoutes(
  ctx: BoardSocketRootsRoutesContext,
  rq: BoardSocketRootsRouteRequest,
): Promise<Response | null> {
  const match = rq.pathname.match(ROOTS_PATH);
  if (!match) return null;
  const { req } = rq;
  const { j } = ctx;
  if (rq.visitor) return j(403, { error: 'not available to share visitors' });
  const notLocal = refuseNonLocalAgentCaller(req, ctx.requestAddress(req));
  if (notLocal) {
    return j(notLocal.status, {
      error: notLocal.body.error.replace('agent-stream-', 'board-socket-roots-'),
      message: 'A walled lead’s project folders are set from this machine only (loopback).',
    });
  }
  let boardId: string;
  try {
    boardId = decodeURIComponent(match[1] ?? '');
  } catch {
    return j(400, { error: 'bad boardId' });
  }
  if (!isValidBoardId(boardId)) return j(400, { error: 'bad boardId' });
  if (!ctx.boardExists(boardId)) return j(404, { error: 'unknown_workspace', boardId });
  if (req.method === 'GET') return j(200, { boardId, roots: ctx.roots.rootsOf(boardId) });
  if (req.method !== 'PUT') return j(405, { error: 'method not allowed' });
  const body = await ctx.safeJson(req);
  const res = ctx.roots.set(boardId, body?.roots);
  if (!res.ok) return j(400, { error: 'bad_roots', message: res.error });
  return j(200, { ok: true, boardId, roots: res.roots });
}
