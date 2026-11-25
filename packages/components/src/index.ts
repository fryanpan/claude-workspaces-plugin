/**
 * `@claude-workspaces/components`: components that run unchanged in a Claude
 * Workspaces doc and on any site. Today, the street map and its GeoJSON
 * layers.
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
  FEATURE_CLICK,
  type FeatureClick,
  MAP_STATE_KEYS,
  type MapHandle,
  type MapLayerProp,
  type MapProps,
  type MapRingProp,
  type MapRow,
  chooseBasemap,
  default as mountMap,
  mountWithSnapshot,
} from './map.ts';
export { HEAT_COLORS, LAYER_LIMITS } from './layers.ts';
