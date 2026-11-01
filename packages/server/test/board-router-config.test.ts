/**
 * `router.local.json` (infra/board-router-worker/router-config.ts): which
 * config it accepts and the project hostnames it derives. What Cloudflare is
 * made from it is the OpenTofu config's (infra/cloudflare/tests).
 */
import { describe, expect, it } from 'bun:test';
import {
  parseRouterConfig,
  projectHostsOf,
} from '../../../infra/board-router-worker/router-config.ts';

const ZONE = 'harborlight.test';
const ONE = `workspaces.${ZONE}`;
const RIVERBEND = `riverbend-origin.${ZONE}`;
const MAC = `mac-origin.${ZONE}`;
/** Riverbend's own hostname: one level under the zone, beside the one address. */
const RIVERBEND_HOST = `riverbend-workspaces.${ZONE}`;
const BASE = { zone: ZONE, oneAddress: ONE, projects: { riverbend: RIVERBEND } };
const cfg = (over: Record<string, unknown> = {}) =>
  parseRouterConfig(JSON.stringify({ ...BASE, ...over }));

describe('parseRouterConfig', () => {
  it('accepts a project table under the zone, with board paths unbound by default', () => {
    const c = cfg();
    expect(c.projects).toEqual({ riverbend: RIVERBEND });
    expect(c.boards).toEqual({});
    expect(c.bindBoardPaths).toBe(false);
  });

  it.each([
    ['not JSON', '{'],
    ['missing its zone', JSON.stringify({ ...BASE, zone: undefined })],
    ['a one address outside the zone', JSON.stringify({ ...BASE, oneAddress: 'saltmarsh.test' })],
    ['a bad project label', JSON.stringify({ ...BASE, projects: { 'a.b': RIVERBEND } })],
    [
      'an origin outside the zone',
      JSON.stringify({ ...BASE, projects: { r: 'r.saltmarsh.test' } }),
    ],
    [
      'an origin with the shape of a project hostname',
      JSON.stringify({ ...BASE, projects: { r: `saltmarsh-workspaces.${ZONE}` } }),
    ],
    ['an origin that is the one address', JSON.stringify({ ...BASE, projects: { r: ONE } })],
    // `origin.<zone>` would make every `<project>-origin.<zone>` a project hostname.
    ['a one address named origin', JSON.stringify({ ...BASE, oneAddress: `origin.${ZONE}` })],
    [
      'a one address two levels down',
      JSON.stringify({ ...BASE, oneAddress: `workspaces.board.${ZONE}` }),
    ],
    [
      'a project hostname past the 63-character label limit',
      JSON.stringify({ ...BASE, projects: { ['r'.repeat(60)]: RIVERBEND } }),
    ],
    ['a one address at the zone apex', JSON.stringify({ ...BASE, oneAddress: ZONE })],
    ['the apex and no projects', JSON.stringify({ zone: ZONE, oneAddress: ZONE, projects: {} })],
    ['an upper-case one address', JSON.stringify({ ...BASE, oneAddress: `Workspaces.${ZONE}` })],
    ['a bad board table', JSON.stringify({ ...BASE, boards: { [MAC]: ['w/x'] } })],
    ['board paths bound with no boards', JSON.stringify({ ...BASE, bindBoardPaths: true })],
  ])('refuses a config with %s', (_label, raw) => {
    expect(() => parseRouterConfig(raw)).toThrow();
  });
});

describe('project hostnames', () => {
  it('are `<project>-<first label of the one address>.<zone>`, one level under the zone', () => {
    const c = cfg({ projects: { riverbend: RIVERBEND, saltmarsh: `saltmarsh-origin.${ZONE}` } });
    expect(projectHostsOf(c)).toEqual([RIVERBEND_HOST, `saltmarsh-workspaces.${ZONE}`]);
  });
});

describe('oneAddressOrigin', () => {
  it('is kept when it names an origin in the tables', () => {
    expect(cfg({ boards: { [MAC]: ['w-mac1'] }, oneAddressOrigin: MAC }).oneAddressOrigin).toBe(
      MAC,
    );
  });

  it('is absent when unset', () => {
    expect(cfg().oneAddressOrigin).toBeUndefined();
  });

  it('refuses an origin the tables do not name', () => {
    expect(() => cfg({ oneAddressOrigin: MAC })).toThrow(/not an origin in the tables/);
  });
});
