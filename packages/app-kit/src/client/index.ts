/**
 * `@claude-workspaces/app-kit/client`: a page's half of the collab core.
 * `scripts/build-client.ts` bundles this file, with Yjs, into the prebuilt
 * `cw-collab.js` (a script tag's `window.cwCollab`) and `cw-collab.mjs`.
 */
import * as Y from 'yjs';

export { Y };
export {
  type DocClose,
  type DocSync,
  type DocSyncOptions,
  type DocUrl,
  type SyncStatus,
  TERMINAL_CLOSE_MAX,
  TERMINAL_CLOSE_MIN,
  connectDoc,
  isTerminalClose,
} from './sync.ts';
export { bindTextarea, shiftIndex, splice } from './text-binding.ts';
export { watchMap } from './watch-map.ts';
