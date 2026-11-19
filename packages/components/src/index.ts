/**
 * `@claude-workspaces/components`: components that run unchanged in a Claude
 * Workspaces doc and on any site. Today, the street map.
 *
 * `./map` is the component file itself (its default export is the mount a
 * doc tag calls); this entry names it `mountMap` beside the snapshot host and
 * the state hook's types, for a site that mounts it by hand.
 */
export {
  type SnapshotOptions,
  mountFromSnapshot,
  snapshotState,
} from '@claude-workspaces/core/component-snapshot';
export type {
  MountFn,
  StateHook,
  StatePath,
  StateWrite,
} from '@claude-workspaces/core/mdx-component-runtime';
export {
  type BasemapChoice,
  MAP_STATE_KEYS,
  type MapProps,
  type MapRingProp,
  type MapRow,
  chooseBasemap,
  default as mountMap,
  mountWithSnapshot,
} from './map.ts';
