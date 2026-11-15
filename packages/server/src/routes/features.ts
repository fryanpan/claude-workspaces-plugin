/**
 * ── The registered features, in the order the chain tries them ──
 *
 * Every family here claims a prefix no other route in the chain answers, and
 * the server stops them all at one position in its shutdown. A new family of
 * that kind is a module beside this file, started and listed in
 * `startServerFeatures` below; `server.ts` does not change.
 *
 * Two of the three answer through Hono (`hono-families.ts`): Incoming
 * Messages (`/inbox/`) and the keeper holds (`/api/keeper/holds`). Git push
 * claims `/workspaces/<board>/git/`, below the workspace scope resolver, so
 * it stays on the chain at the features' old position in
 * `request-chain-tail.ts`, below the workspaces list's stream and above the
 * private messages.
 *
 * List order is stop order. A family that must answer before some other
 * route, or be built before something else reads it, does not belong here:
 * start it from `createServer` where its block would sit (see the
 * "Positional" note in `feature-module.ts`).
 */
import { type FeatureRoutes, chainFeatureRoutes, stopFeatures } from '../feature-module.ts';
import type { FeatureDeps } from './feature-routes-context.ts';
import { gitPushFeature } from './git-push-feature.ts';
import { type InboxFeatureApi, inboxFeature } from './inbox-feature.ts';
import { keeperHoldsFeature } from './keeper-holds-feature.ts';

export type { FeatureDeps };

export interface ServerFeatures {
  /** The routes still on the chain: git push. */
  routes: ReturnType<typeof chainFeatureRoutes>;
  /** Incoming Messages' routes, answered through Hono. */
  inboxRoutes: FeatureRoutes;
  /** The keeper holds' routes, answered through Hono. */
  keeperHoldsRoutes: FeatureRoutes;
  /** Every registered family's stop, in list order. */
  stop: () => void;
  /** Read by the front page's Incoming Messages section. */
  inbox: InboxFeatureApi;
}

export function startServerFeatures(deps: FeatureDeps): ServerFeatures {
  const inbox = inboxFeature.start(deps);
  const gitPush = gitPushFeature.start(deps);
  const keeperHolds = keeperHoldsFeature.start(deps);
  const started = [inbox, gitPush, keeperHolds];
  return {
    routes: chainFeatureRoutes([gitPush]),
    inboxRoutes: chainFeatureRoutes([inbox]),
    keeperHoldsRoutes: chainFeatureRoutes([keeperHolds]),
    stop: () => stopFeatures(started),
    inbox,
  };
}
