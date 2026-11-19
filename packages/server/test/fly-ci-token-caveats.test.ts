/**
 * What a token `fly:ci-tokens` cuts lets its holder do, judged by a model of
 * Fly's own rules (`fly-macaroon.ts`, after superfly/macaroon). The bare
 * `Apps` + `FeatureSet` pair these replaced refused every access ("Not
 * authorized to access this firecrackerapp"); the first case reproduces that
 * so the model is shown to tell the two apart.
 */
import { describe, expect, it } from 'bun:test';
import {
  MAC_VALID_DAYS,
  NEVER_FEATURES,
  VALID_DAYS,
  caveats,
  macCaveats,
} from '../../../infra/project-machine/ci-tokens.ts';
import { allows } from './fly-macaroon.ts';

const NOW_MS = Date.UTC(2026, 10, 18);
const NOW = Math.floor(NOW_MS / 1000);
const APP = '101';
const OTHER_APP = '202';
const at = (now: number) => ({ now });

describe('the caveats a cut token carries', () => {
  it('the old bare Apps beside a bare FeatureSet refused an app access and a builder access alike', () => {
    const bare = [
      { type: 'Apps', body: { apps: { [APP]: 'rwcdC' } } },
      { type: 'FeatureSet', body: { features: { builder: 'rwcdC' } } },
    ];
    expect(allows(bare, { appId: APP, action: 'r', ...at(NOW) })).toBe(false);
    expect(allows(bare, { feature: 'builder', action: 'rwcdC', ...at(NOW) })).toBe(false);
  });

  it("CI's token: its app with every deploy action, and the builder", () => {
    const set = caveats(APP, NOW_MS);
    for (const action of ['r', 'w', 'c', 'd', 'C', 'rwcdC'])
      expect(allows(set, { appId: APP, action, ...at(NOW) })).toBe(true);
    expect(allows(set, { feature: 'builder', action: 'rwcdC', ...at(NOW) })).toBe(true);
  });

  it("CI's token: no other app, no wg or other never-feature, read only on the org itself", () => {
    const set = caveats(APP, NOW_MS);
    expect(allows(set, { appId: OTHER_APP, action: 'r', ...at(NOW) })).toBe(false);
    for (const feature of NEVER_FEATURES)
      expect(allows(set, { feature, action: 'r', ...at(NOW) })).toBe(false);
    expect(allows(set, { action: 'r', ...at(NOW) })).toBe(true);
    for (const action of ['w', 'c', 'd', 'C'])
      expect(allows(set, { action, ...at(NOW) })).toBe(false);
  });

  it("CI's token lapses after VALID_DAYS and the Mac's after MAC_VALID_DAYS", () => {
    const access = { appId: APP, action: 'r' };
    const ci = caveats(APP, NOW_MS);
    expect(allows(ci, { ...access, now: NOW + VALID_DAYS * 86_400 })).toBe(true);
    expect(allows(ci, { ...access, now: NOW + VALID_DAYS * 86_400 + 1 })).toBe(false);
    // A clock a little behind Fly's still sees the token as live.
    expect(allows(ci, { ...access, now: NOW - 30 })).toBe(true);
    const mac = macCaveats(APP, NOW_MS);
    expect(allows(mac, { ...access, now: NOW + MAC_VALID_DAYS * 86_400 })).toBe(true);
    expect(allows(mac, { ...access, now: NOW + MAC_VALID_DAYS * 86_400 + 1 })).toBe(false);
  });

  it("the Mac's token: its app, the builder and wg; no other app or feature", () => {
    const set = macCaveats(APP, NOW_MS);
    expect(allows(set, { appId: APP, action: 'rwcdC', ...at(NOW) })).toBe(true);
    for (const feature of ['builder', 'wg'])
      expect(allows(set, { feature, action: 'rwcdC', ...at(NOW) })).toBe(true);
    expect(allows(set, { appId: OTHER_APP, action: 'r', ...at(NOW) })).toBe(false);
    for (const feature of ['deletion', 'membership', 'billing'])
      expect(allows(set, { feature, action: 'r', ...at(NOW) })).toBe(false);
  });

  it('refuses an app id that is not a number, for the Mac as for CI', () => {
    expect(() => macCaveats('101; rm', NOW_MS)).toThrow('a number');
  });
});
