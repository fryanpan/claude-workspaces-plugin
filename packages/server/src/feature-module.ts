/**
 * ── Feature modules: how a family wires itself into the server ──
 *
 * A family — a store, the routes that serve it, and whatever it must stop on
 * shutdown — is one `FeatureModule`. Its `start` takes the long-lived values
 * it reads and hands back what the server needs from it: an optional route
 * handler, an optional `stop`, and any named values other families read
 * (the `Api`).
 *
 * Two ways a module is started, and the difference is ORDER:
 *
 * - **Registered.** A family whose routes claim a prefix nothing else in the
 *   chain answers, and whose construction nothing else reads early, goes in
 *   the list in `routes/features.ts`. The chain tries every registered
 *   family's routes at one fixed position, in list order, and the server
 *   stops them at one fixed position in its shutdown. Adding such a family
 *   is a new module plus one line in that list; `server.ts` does not change.
 * - **Positional.** A family whose construction other families read, or
 *   whose shutdown has to sit at a particular point (the meetings, which must
 *   flush into docs after the sockets close and before the doc store does),
 *   is started by `createServer` from the place its block used to sit, and
 *   stopped from the place its teardown used to sit. Same shape, called by
 *   hand; its async teardown is an `Api` member the caller awaits.
 *
 * Nothing here knows about any family; it is the shape and the two helpers
 * that run a list of them.
 */

/** What a family's routes see per request: the address, whether a share
 *  visitor sent it, and the two per-request reads the top-level families
 *  have always taken. */
export interface FeatureRequest {
  req: Request;
  pathname: string;
  /** Non-null for a share visitor. Typed loosely on purpose: a family that
   *  needs the share's shape asks the chain for it, not this boundary. */
  visitor: unknown;
  /** True when a person proof on this request resolves to the owner. */
  ownerProven: () => boolean;
  /** This server's own origin, as the request reached it. */
  requestOrigin: () => string | undefined;
}

/** A family's route handler. A falsy answer declines, so the chain goes on
 *  — the same `if (handled) return handled;` every call site in the chain
 *  spells. */
export type FeatureRoutes = (
  rq: FeatureRequest,
) => Promise<Response | null | undefined> | Response | null | undefined;

/** What a started family hands back. */
export interface FeatureInstance {
  routes?: FeatureRoutes;
  /**
   * Called once, on shutdown, and SYNCHRONOUSLY. The registered families stop
   * in the stretch of `stop()` that runs before `server.stop(true)`, and an
   * await there would push the socket drain and everything after it into a
   * later microtask. A family with async teardown is positional and exposes
   * its own `dispose` for the caller to await where it belongs.
   */
  stop?: () => void;
}

/**
 * One family. `Deps` is what it reads, `Api` the named values it hands to
 * the rest of the server beside its routes and stop.
 */
export interface FeatureModule<Deps, Api extends object = Record<never, never>> {
  /** For logs and tests; never matched on. */
  name: string;
  start: (deps: Deps) => FeatureInstance & Api;
}

/**
 * Every instance's routes, tried in list order; the first truthy answer
 * wins. A family with no routes is skipped.
 */
export function chainFeatureRoutes(instances: readonly FeatureInstance[]): FeatureRoutes {
  const handlers = instances.flatMap((f) => (f.routes ? [f.routes] : []));
  return async (rq) => {
    for (const handle of handlers) {
      const handled = await handle(rq);
      if (handled) return handled;
    }
    return null;
  };
}

/**
 * Every instance's stop, in list order. A throw propagates, exactly as an
 * inline teardown line would have.
 */
export function stopFeatures(instances: readonly FeatureInstance[]): void {
  for (const f of instances) f.stop?.();
}
