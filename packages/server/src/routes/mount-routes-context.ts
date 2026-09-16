import { type ShareTarget, isLoopbackAddress } from '../middleware/host-guard.ts';
import type { MountStore } from '../mount-store.ts';

/**
 * The vocabulary the mount family shares: what a handler is given, what one
 * request looks like, and the single question both of its halves ask about
 * where a request came from.
 *
 * It lives here rather than in `mounts.ts` because `mount-file.ts` needs all
 * three and a route may not import the entry point that calls it.
 */

export interface MountRoutesContext {
  mounts: MountStore;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  /** The request's SOCKET address, never a header. */
  requestAddress: (req: Request) => string | undefined;
}

export interface MountRouteRequest {
  req: Request;
  pathname: string;
  url: URL;
  /** The share target this request resolved to, or null for a member. */
  visitor: ShareTarget | null;
}

/**
 * Did this request come from this machine, unproxied?
 *
 * Both conditions, because either alone can be faked: the tunnel connects
 * from this machine too, so a loopback socket carrying Cloudflare's marker is
 * a request that reached here through the edge.
 */
export function isOnBox(ctx: MountRoutesContext, req: Request): boolean {
  if (req.headers.has('cf-ray')) return false;
  return isLoopbackAddress(ctx.requestAddress(req));
}
