/**
 * ── The registered features, in the order the chain tries them ──
 *
 * Every family here claims a prefix no other route in the chain answers, so
 * the chain tries them all at one position — after the voice conversation
 * API, before the goal coach (`request-chain-tail.ts`) — and the server stops
 * them all at one position in its shutdown. A new family of that kind is a
 * module beside this file, started and listed in `startServerFeatures`
 * below; `server.ts` does not change.
 *
 * List order is route order and stop order. A family that must answer before
 * some other route, or be built before something else reads it, does not
 * belong here: start it from `createServer` where its block would sit (see
 * the "Positional" note in `feature-module.ts`).
 */
import { chainFeatureRoutes, stopFeatures } from '../feature-module.ts';
import type { FeatureDeps } from './feature-routes-context.ts';
import { gitPushFeature } from './git-push-feature.ts';
import { type InboxFeatureApi, inboxFeature } from './inbox-feature.ts';

export type { FeatureDeps };

export interface ServerFeatures {
  /** Every registered family's routes, tried in list order. */
  routes: ReturnType<typeof chainFeatureRoutes>;
  /** Every registered family's stop, in list order. */
  stop: () => void;
  /** Read by the front page's Incoming Messages section. */
  inbox: InboxFeatureApi;
}

export function startServerFeatures(deps: FeatureDeps): ServerFeatures {
  const inbox = inboxFeature.start(deps);
  const started = [inbox, gitPushFeature.start(deps)];
  return {
    routes: chainFeatureRoutes(started),
    stop: () => stopFeatures(started),
    inbox,
  };
}
