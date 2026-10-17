/**
 * ── Incoming Messages, as a registered feature ──
 *
 * The owner's rows, their bodies in a file of their own, and the config
 * naming the reader, re-read when its file changes (inbox/config.ts). Bryan's
 * Send goes through `replies` alone.
 *
 * The first family moved behind `feature-module.ts`. Everything it builds was
 * built inline in `createServer` and read by three things only: the route
 * context below, the front page's inbox section, and the shutdown line that
 * stopped the watcher. So the stores, the routes and the stop live here, and
 * the front page reads `landingSection` off the started instance.
 *
 * The reader is held to its token always, whatever `requireAgentToken` says:
 * the post is the only write path for text from outside the trust zone.
 */
import { authorizeAgentCaller, refuseNonLocalAgentCaller } from '../auth/agent-token.ts';
import type { FeatureModule } from '../feature-module.ts';
import { InboxBodies } from '../inbox/bodies.ts';
import { inboxConfigReader } from '../inbox/config.ts';
import { inboxSectionFor } from '../inbox/landing.ts';
import { watchInbox } from '../inbox/live.ts';
import { InboxReplies } from '../inbox/reply.ts';
import { systemTransport } from '../inbox/send-transport.ts';
import { InboxSends } from '../inbox/sends.ts';
import { InboxStore } from '../inbox/store.ts';
import type { FeatureDeps } from './feature-routes-context.ts';
import { type InboxRoutesContext, handleInboxRoutes } from './inbox.ts';

export interface InboxFeatureApi {
  /** The front page's Incoming Messages section, ranked against the page's
   *  own project order. '' when there is no inbox. */
  landingSection: (rankOf: ReadonlyMap<string, number>) => string;
}

export const inboxFeature: FeatureModule<FeatureDeps, InboxFeatureApi> = {
  name: 'inbox',
  start: (deps) => {
    const { dataDir, opts, taskStore, identities, requestAddress, agentTokenKey, j, safeJson } =
      deps;
    const inboxConfig = inboxConfigReader(dataDir);
    const inboxStore = new InboxStore(dataDir);
    const unwatchInbox = watchInbox({
      store: inboxStore,
      notify: () => deps.notifyLanding('inbox'),
    });
    const inboxBodies = new InboxBodies(dataDir);
    const inboxReplies = new InboxReplies({
      store: inboxStore,
      sends: new InboxSends(dataDir),
      config: inboxConfig,
      transport: opts.inboxTransport ?? systemTransport(),
    });
    const inboxRoutesCtx: InboxRoutesContext = {
      store: inboxStore,
      bodies: inboxBodies,
      replies: inboxReplies,
      config: inboxConfig,
      goalIsLive: (ws, goal) =>
        taskStore.getWorkspace(ws)?.goals.some((g) => g.id === goal) ?? false,
      runs: taskStore,
      agentName: (agentId) => identities.displayNameFor(agentId) ?? agentId,
      refuseNonLocal: (req) => refuseNonLocalAgentCaller(req, requestAddress(req)),
      authorizeAgent: (req, agentId) =>
        authorizeAgentCaller({
          agentId,
          req,
          address: requestAddress(req),
          key: agentTokenKey(),
          requireToken: true,
        }),
      j,
      safeJson,
    };
    return {
      routes: (rq) => handleInboxRoutes(inboxRoutesCtx, rq),
      stop: unwatchInbox,
      landingSection: (rankOf) =>
        inboxSectionFor({ store: inboxStore, config: inboxConfig(), taskStore, rankOf }),
    };
  },
};
