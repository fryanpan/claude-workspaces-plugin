/**
 * `POST /workspaces/<id>/lead-chat/model` — `{model?, effort?}`: switch the
 * board's running lead (`lead-chat/lead-model.ts`).
 *
 * It types into a terminal, so `requireOwner` is not enough: that passes every
 * loopback caller, and every agent on this machine is one. The request must
 * prove the owner made it from the board's own page (`hasOwnerProof`), which
 * no agent can. Both values must be on core's allowlists; nothing else is
 * taken from the body. Not in the share member table, and a visitor is
 * refused here besides. The answer is the state a page shows.
 */
import { isLeadEffort, isLeadModelAlias } from '@claude-workspaces/core/lead-chat';
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
  const body = await ctx.safeJson(rq.req);
  const { model, effort } = (body ?? {}) as { model?: unknown; effort?: unknown };
  const badModel = model !== undefined && !isLeadModelAlias(model);
  const badEffort = effort !== undefined && !isLeadEffort(effort);
  if (badModel || badEffort || (model === undefined && effort === undefined)) {
    return ctx.j(400, { error: 'bad pick' });
  }
  if (!ctx.taskStore.getWorkspace(workspaceId)?.leadAgentId) {
    return ctx.j(409, { error: 'no-lead' });
  }
  const state = await ctx.leadModels.pick(workspaceId, {
    ...(isLeadModelAlias(model) ? { model } : {}),
    ...(isLeadEffort(effort) ? { effort } : {}),
  });
  return ctx.j(200, { state });
}
