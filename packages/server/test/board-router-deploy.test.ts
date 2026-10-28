/**
 * The router deploy's decisions (infra/board-router-worker/deploy-plan.ts):
 * which config it accepts, when it creates a project's record, when it
 * refuses to deploy, and the wrangler config it renders. Nothing here reaches
 * Cloudflare; the runner (deploy.ts) only feeds these functions what the API
 * answered.
 */
import { describe, expect, it } from 'bun:test';
import {
  type Observed,
  parseRouterConfig,
  plan,
  projectHostsOf,
  projectRecord,
  renderWranglerToml,
  versionIdOf,
} from '../../../infra/board-router-worker/deploy-plan.ts';

const ZONE = 'harborlight.test';
const ONE = `workspaces.${ZONE}`;
const RIVERBEND = `riverbend-origin.${ZONE}`;
const MAC = `mac-origin.${ZONE}`;
/** Riverbend's own hostname: one level under the zone, beside the one address. */
const RIVERBEND_HOST = `riverbend-workspaces.${ZONE}`;
const BASE = { zone: ZONE, oneAddress: ONE, projects: { riverbend: RIVERBEND } };
const cfg = (over: Record<string, unknown> = {}) =>
  parseRouterConfig(JSON.stringify({ ...BASE, ...over }));

const proxied = (name: string) => ({ type: 'CNAME', name, content: 't.test', proxied: true });
/** What a zone on Universal SSL alone answers: the apex and one level under it. */
const healthy = (): Observed => ({
  hosts: {},
  origins: { [RIVERBEND]: [proxied(RIVERBEND)] },
  certificateHosts: [ZONE, `*.${ZONE}`],
});

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

describe('plan', () => {
  it("creates a project's record when there is none, on Universal SSL alone", () => {
    expect(plan(cfg(), healthy())).toEqual({ ok: true, create: [RIVERBEND_HOST] });
  });

  it('leaves a proxied project record alone, so a second run changes nothing', () => {
    const obs = { ...healthy(), hosts: { [RIVERBEND_HOST]: [projectRecord(RIVERBEND_HOST)] } };
    expect(plan(cfg(), obs)).toEqual({ ok: true, create: [] });
  });

  it('refuses a project record Cloudflare does not proxy', () => {
    const obs = {
      ...healthy(),
      hosts: { [RIVERBEND_HOST]: [{ ...projectRecord(RIVERBEND_HOST), proxied: false }] },
    };
    expect(plan(cfg(), obs).ok).toBe(false);
  });

  it('refuses a config with nothing to bind', () => {
    const verdict = plan(cfg({ projects: {} }), healthy());
    expect(verdict.ok ? [] : verdict.problems).toEqual([
      expect.stringContaining('nothing to bind'),
    ]);
  });

  it('refuses an origin with no proxied record', () => {
    const missing = { ...healthy(), origins: {} };
    const unproxied = {
      ...healthy(),
      origins: { [RIVERBEND]: [{ ...proxied(RIVERBEND), proxied: false }] },
    };
    expect(plan(cfg(), missing).ok).toBe(false);
    expect(plan(cfg(), unproxied).ok).toBe(false);
  });

  it('refuses when no certificate covers the project hostname', () => {
    // A certificate for the one address alone, or for names two levels down,
    // does not cover a name beside the one address.
    const obs = { ...healthy(), certificateHosts: [ZONE, ONE, `*.${ONE}`] };
    const verdict = plan(cfg(), obs);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? [] : verdict.problems.join(' ')).toContain(RIVERBEND_HOST);
  });

  it('CONTROL: the exact hostname on a certificate lets the same config deploy', () => {
    const obs = { ...healthy(), certificateHosts: [ZONE, ONE, `*.${ONE}`, RIVERBEND_HOST] };
    expect(plan(cfg(), obs)).toEqual({ ok: true, create: [RIVERBEND_HOST] });
  });
});

describe("a project's record", () => {
  it('is a proxied placeholder only the Worker answers', () => {
    expect(projectRecord(RIVERBEND_HOST)).toEqual({
      type: 'AAAA',
      name: RIVERBEND_HOST,
      content: '100::',
      proxied: true,
    });
  });
});

describe('renderWranglerToml', () => {
  const routesOf = (toml: string) => [...toml.matchAll(/pattern = "([^"]+)"/g)].map((m) => m[1]);

  it('binds one route per project hostname, and nothing else, until board paths are bound', () => {
    expect(routesOf(renderWranglerToml(cfg(), '/w/worker.js'))).toEqual([`${RIVERBEND_HOST}/*`]);
  });

  it('binds the board paths too once asked, so the one address is never bound by accident', () => {
    const bound = cfg({ boards: { [MAC]: ['w-mac1'] }, bindBoardPaths: true });
    expect(routesOf(renderWranglerToml(bound, '/w/worker.js'))).toEqual([
      `${RIVERBEND_HOST}/*`,
      `${ONE}/workspaces/*`,
    ]);
  });

  it('turns off the workers.dev address and carries the tables the Worker parses', () => {
    const toml = renderWranglerToml(cfg(), '/w/worker.js');
    expect(toml).toContain('workers_dev = false');
    expect(toml).toContain(`ONE_ADDRESS = "${ONE}"`);
    const vars = Object.fromEntries(
      [...toml.matchAll(/^([A-Z_]+) = (".*")$/gm)].map((m) => [m[1], JSON.parse(m[2] ?? '""')]),
    );
    expect(JSON.parse(vars.PROJECT_ORIGINS)).toEqual({ riverbend: RIVERBEND });
    expect(JSON.parse(vars.BOARD_ORIGINS)).toEqual({});
  });
});

describe('oneAddressOrigin', () => {
  const varsOf = (toml: string) =>
    Object.fromEntries(
      [...toml.matchAll(/^([A-Z_]+) = (".*")$/gm)].map((m) => [m[1], JSON.parse(m[2] ?? '""')]),
    );

  it('is carried to the Worker as ONE_ADDRESS_ORIGIN when it names an origin in the tables', () => {
    const c = cfg({ boards: { [MAC]: ['w-mac1'] }, oneAddressOrigin: MAC });
    expect(c.oneAddressOrigin).toBe(MAC);
    expect(varsOf(renderWranglerToml(c, '/w/worker.js')).ONE_ADDRESS_ORIGIN).toBe(MAC);
  });

  it('is absent from the Worker when unset', () => {
    expect(varsOf(renderWranglerToml(cfg(), '/w/worker.js')).ONE_ADDRESS_ORIGIN).toBeUndefined();
  });

  it('refuses an origin the tables do not name', () => {
    expect(() => cfg({ oneAddressOrigin: MAC })).toThrow(/not an origin in the tables/);
  });
});

describe('versionIdOf', () => {
  it('reads the version wrangler printed, and nothing from output without one', () => {
    const id = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
    expect(versionIdOf(`Uploaded board-router\nCurrent Version ID: ${id}\n`)).toBe(id);
    expect(versionIdOf('Uploaded board-router\n')).toBeNull();
  });
});
