import { isLoopbackAddress } from '../middleware/host-guard.ts';
import { browserCannotOperateBody, isBrowserRequest } from '../middleware/write-gate.ts';
import { serveMountedFile } from './mount-file.ts';
import { type MountRouteRequest, type MountRoutesContext } from './mount-routes-context.ts';
import { type MountsApi, mountsApi } from './mounts-api.ts';

export type { MountRoutesContext, MountRouteRequest };

/**
 * Mounted project folders over HTTP: the lead's mount table, and the address
 * every file in it answers at.
 *
 * The table's routes are a typed Hono app in `mounts-api.ts`, which the MCP
 * child calls through Hono's client; this entry point runs the gate below
 * and hands the request to it.
 *
 * **Two families with two different gates**, and the split is the whole
 * security story of this feature.
 *
 * `/api/mounts…` is the lead's table. Every value it reads and writes is a
 * HOST PATH — a folder to mount, a repo's main directory, the relative path
 * of a conventions index — so it sits behind exactly the gate `/api/repos`
 * and `POST /api/deploy` use: no share or collab visitor, no `cf-ray`, a
 * loopback socket address, and no browser. Registering storage is an operator
 * action.
 *
 * `/mounts/<fileId>` is the ADDRESS, and it has to be readable by the people
 * a file was mounted for. It is not on `shareScopeAllows`, so a share or
 * collab visitor never reaches it — and it refuses one locally as well, so a
 * path added under an allowed prefix later cannot open it silently. What is
 * left is a board member, over the tunnel or the tailnet.
 *
 * **Privacy is what narrows that.** A project marked `local-only` serves its
 * files only to a loopback caller with no `cf-ray` — an agent or a browser on
 * the box itself. Its bytes do not leave the machine even for a signed-in
 * member on the owner's own tablet, because "must not leave the machine" is a
 * claim about the network and not about who is asking.
 *
 * One MOUNT can be marked instead, for the project that has one sensitive
 * folder and a dozen harmless ones. The answer a file is served against is
 * the narrower of its mount's setting and its project's
 * (`MountStore.mountPrivacyOf`), never the more specific one — so a project
 * shut with `local-only` stays shut whatever its mounts say, and a mount
 * nobody marked behaves exactly as it did before mounts had a setting.
 */

/** The refusal the whole `/api/mounts` family shares, or null to proceed. */
function offBox(ctx: MountRoutesContext, rq: MountRouteRequest): Response | null {
  const { j } = ctx;
  const { req, visitor } = rq;
  if (visitor) return j(403, { error: 'not available to share visitors' });
  if (req.headers.has('cf-ray')) {
    return j(403, {
      error: 'the mount table is not reachable through the edge — run this from the box',
    });
  }
  if (!isLoopbackAddress(ctx.requestAddress(req))) {
    return j(403, { error: 'the mount table is loopback-only — it names host filesystem paths' });
  }
  if (isBrowserRequest(req.headers)) return j(403, browserCannotOperateBody());
  return null;
}

/**
 * The mount routes. `undefined` means none matched and the chain continues.
 */
export async function handleMountRoutes(
  ctx: MountRoutesContext,
  rq: MountRouteRequest,
): Promise<Response | undefined> {
  const { pathname } = rq;
  if (pathname === '/mounts' || pathname.startsWith('/mounts/')) return serveMountedFile(ctx, rq);
  if (pathname !== '/api/mounts' && !pathname.startsWith('/api/mounts/')) return undefined;

  const { req } = rq;
  const refused = offBox(ctx, rq);
  if (refused) return refused;
  // Hono answers a HEAD by running the GET handler; this table has always
  // refused one, as it refuses every method it does not take.
  if (req.method === 'HEAD') return ctx.j(405, { error: 'method not allowed' });
  return apiFor(ctx).fetch(req);
}

/** The typed routes (`mounts-api.ts`), built once per server's context. */
const apis = new WeakMap<MountRoutesContext, MountsApi>();
function apiFor(ctx: MountRoutesContext): MountsApi {
  let api = apis.get(ctx);
  if (!api) {
    api = mountsApi(ctx);
    apis.set(ctx, api);
  }
  return api;
}
