/**
 * ── A lead's push through its board server, as a registered feature ──
 *
 * Claims `/workspaces/<board>/git/` alone. The pusher's records and bundles
 * live under `<dataDir>/git-push/`; its credential is the one the boot read
 * (`server-deps.ts`, `git-push/credential.ts`), or none, which refuses every
 * push with 503.
 */
import type { FeatureModule } from '../feature-module.ts';
import { GitPusher } from '../git-push/pusher.ts';
import type { FeatureDeps } from './feature-routes-context.ts';
import { handleGitPushRoutes } from './git-push.ts';

export const gitPushFeature: FeatureModule<FeatureDeps> = {
  name: 'git-push',
  start: (deps) => {
    const { dataDir, opts, taskStore, requestAddress, boardOfSocket, j } = deps;
    const gp = opts.gitPush;
    const pusher = new GitPusher({
      dataDir,
      taskStore,
      credential: gp?.credential ?? (async () => null),
      ...(gp?.remoteUrlFor ? { remoteUrlFor: gp.remoteUrlFor } : {}),
      ...(gp?.runGit ? { runGit: gp.runGit } : {}),
    });
    return {
      routes: (rq) =>
        handleGitPushRoutes(
          {
            pusher,
            boardExists: (id) => taskStore.getWorkspace(id) !== undefined,
            boardOfSocket,
            requestAddress,
            j,
          },
          rq,
        ),
      stop: () => pusher.stop(),
    };
  },
};
