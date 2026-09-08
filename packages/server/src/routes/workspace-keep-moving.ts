/**
 * `GET /workspaces/<id>/keep-moving` — the board's keep-moving verdicts.
 *
 * The one read of `keep-moving-verdict.ts`: the latest PASS/FAIL and the
 * week behind it. Owner-side only — the path is not in the share member
 * table (`middleware/host-guard.ts`), and the handler refuses a visitor on
 * its own besides, because the lines name row ids on the owner's board.
 */
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

export function handleWorkspaceKeepMoving(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Response | undefined {
  const { req, pathname, scope, visitor } = rq;
  if (!scope || req.method !== 'GET') return undefined;
  if (!/^\/workspaces\/[^/]+\/keep-moving$/.test(pathname)) return undefined;
  if (visitor) return ctx.j(403, { error: 'not a member route' });
  const { workspaceId } = scope;
  return ctx.j(200, {
    workspaceId,
    latest: ctx.keepMovingVerdicts.latest(workspaceId) ?? null,
    history: ctx.keepMovingVerdicts.history(workspaceId),
  });
}
