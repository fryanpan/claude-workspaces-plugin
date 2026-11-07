/**
 * `POST /workspaces/<id>/lead-chat/model`: refused today with 409
 * `model-switch-off`, and nothing reaches a terminal. On Claude Code 2.1.319
 * `/model` and `/effort` also save the value as the default for every new
 * session, so a pick from the board changed the fleet's defaults
 * (`lead-chat/lead-model.ts`).
 *
 * The gates stay in front of the refusal, so a caller that could never switch
 * the lead keeps its 403: `requireOwner` passes every loopback caller, and
 * every agent on this machine is one, so the request must also prove the owner
 * made it from the board's own page (`hasOwnerProof`). Not in the share member
 * table, and a visitor is refused here besides. The body is not read.
 */
import { hasOwnerProof } from '../share/owner-proof.ts';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

export async function handleLeadChatModel(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
  workspaceId: string,
): Promise<Response | undefined> {
  if (rq.req.method !== 'POST') return ctx.j(405, { error: 'method not allowed' });
  if (rq.visitor) return ctx.j(403, { error: 'not a member route' });
  const denied = rq.requireOwner(workspaceId);
  if (denied) return denied;
  if (!hasOwnerProof(rq.req, rq.provenIdentityFor, rq.requestOriginFor)) {
    return ctx.j(403, {
      error: 'owner-proof-required',
      hint: 'Only the signed-in owner, on the board’s own page, can switch the lead.',
    });
  }
  return ctx.j(409, {
    error: 'model-switch-off',
    hint: 'Switching the lead from the board is off: it would change the default model for every new session.',
  });
}
