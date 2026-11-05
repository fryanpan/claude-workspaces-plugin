/**
 * ── Keeper requests on Bryan's Home, as a registered feature ──
 *
 * Claims `/api/keeper/holds` alone (`keeper-holds.ts`). The cards and their
 * poll tokens live in `<dataDir>/keeper-cards.json`. A server with no keeper
 * (`opts.keeperHolds` unset) still claims the path and answers 501.
 */
import type { FeatureModule } from '../feature-module.ts';
import { KeeperHomeCards } from '../keeper/keeper-home-card.ts';
import type { FeatureDeps } from './feature-routes-context.ts';
import { handleKeeperHoldsRoutes } from './keeper-holds.ts';

export const keeperHoldsFeature: FeatureModule<FeatureDeps> = {
  name: 'keeper-holds',
  start: (deps) => {
    const { dataDir, opts, taskStore, requestAddress, boardOfSocket, j, safeJson } = deps;
    const keeper = opts.keeperHolds;
    const cards = keeper
      ? new KeeperHomeCards({
          dataDir,
          keeper,
          boards: deps.ownerNoticeBoards,
          isBoardLive: deps.isBoardLive,
          getTask: (taskId) => taskStore.getTask(taskId),
          createTask: (workspaceId, o) => taskStore.createTask(workspaceId, o),
          addReviewItem: (taskId, review, o) => taskStore.addReviewItem(taskId, review, o),
          withdrawReviewItem: (taskId, itemId, o) =>
            taskStore.withdrawReviewItem(taskId, itemId, o),
        })
      : null;
    return {
      routes: (rq) =>
        handleKeeperHoldsRoutes({ cards, requestAddress, boardOfSocket, j, safeJson }, rq),
      stop: () => cards?.stop(),
    };
  },
};
