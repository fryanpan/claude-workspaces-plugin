import { type DocMoveDeps, type DocMoveError, moveDocToProject } from '../doc-move.ts';
import type { ShareTarget } from '../middleware/host-guard.ts';
import { type WorkspaceScope, matchRest } from '../middleware/workspace-scope.ts';
import { browserCannotBindBody, isBrowserRequest } from '../middleware/write-gate.ts';
import type { BoardWorkspace } from '../tasks.ts';

/**
 * The migration verb over HTTP:
 *
 *   POST /workspaces/<id>/docs/<docId>/move — `{ relPath }` → the moved doc
 *
 * Trusted-local, and not on `shareScopeAllows`: it writes a file into a repo
 * on this machine. It refuses a share visitor and a browser itself as well,
 * the way every binding route does — a page may not decide where a file goes
 * on the host (`browserCannotBindBody`). Everything else it refuses is decided
 * in `doc-move.ts`, which this file only maps onto status codes.
 */

export interface DocMoveRoutesContext extends DocMoveDeps {
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  isValidDocId: (s: string) => boolean;
}

export interface DocMoveRouteRequest {
  scope?: WorkspaceScope<BoardWorkspace>;
  req: Request;
  visitor: ShareTarget | null;
}

const STATUS: Record<DocMoveError, number> = {
  'bad-path': 400,
  'not-found': 404,
  'not-on-board': 404,
  'not-markdown': 400,
  'home-pinned': 409,
  recording: 409,
  'no-project': 409,
  'outside-project-folders': 400,
  'target-exists': 409,
  'address-held': 409,
  'write-failed': 500,
};

/** Answers the move, or `undefined` when the path is not `docs/<id>/move`. */
export async function handleDocMoveRoute(
  ctx: DocMoveRoutesContext,
  rq: DocMoveRouteRequest,
): Promise<Response | undefined> {
  const { scope, req, visitor } = rq;
  const { j } = ctx;
  const match = matchRest(scope, /^docs\/([^/]+)\/move$/);
  if (!scope || !match) return undefined;
  if (visitor) return j(403, { error: 'moving a doc is not available to share visitors' });
  if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
  if (isBrowserRequest(req.headers)) return j(403, browserCannotBindBody());
  const docId = decodeURIComponent(match[1] ?? '');
  if (!ctx.isValidDocId(docId)) return j(400, { error: 'bad docId' });
  const body = await ctx.safeJson(req);
  const res = moveDocToProject(ctx, {
    workspaceId: scope.workspaceId,
    board: scope.board,
    docId,
    relPath: body?.relPath,
  });
  return res.ok ? j(200, res) : j(STATUS[res.error], res);
}
