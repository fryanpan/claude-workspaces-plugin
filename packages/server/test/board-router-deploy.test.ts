/**
 * The router deploy's decisions (infra/board-router-worker/deploy-plan.ts):
 * which config it accepts, when it creates the wildcard record, when it
 * refuses to deploy, and the wrangler config it renders. Nothing here reaches
 * Cloudflare; the runner (deploy.ts) only feeds these functions what the API
 * answered.
 */
import { describe, expect, it } from 'bun:test';
import {
  type Observed,
  parseRouterConfig,
  plan,
  renderWranglerToml,
  versionIdOf,
  wildcardRecord,
} from '../../../infra/board-router-worker/deploy-plan.ts';

const ZONE = 'harborlight.test';
const ONE = `workspaces.${ZONE}`;
const RIVERBEND = `riverbend-origin.${ZONE}`;
const MAC = `mac-origin.${ZONE}`;
const BASE = { zone: ZONE, oneAddress: ONE, projects: { riverbend: RIVERBEND } };
const cfg = (over: Record<string, unknown> = {}) =>
  parseRouterConfig(JSON.stringify({ ...BASE, ...over }));

const proxied = (name: string) => ({ type: 'CNAME', name, content: 't.test', proxied: true });
const healthy = (): Observed => ({
  wildcard: [],
  origins: { [RIVERBEND]: [proxied(RIVERBEND)] },
  certificateHosts: [ONE, `*.${ONE}`],
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
    ['an origin under the one address', JSON.stringify({ ...BASE, projects: { r: `r.${ONE}` } })],
    // At the apex every origin in the zone would itself be a project subdomain.
    ['a one address at the zone apex', JSON.stringify({ ...BASE, oneAddress: ZONE })],
    ['a bad board table', JSON.stringify({ ...BASE, boards: { [MAC]: ['w/x'] } })],
    ['board paths bound with no boards', JSON.stringify({ ...BASE, bindBoardPaths: true })],
  ])('refuses a config with %s', (_label, raw) => {
    expect(() => parseRouterConfig(raw)).toThrow();
  });
});

describe('plan', () => {
  it('creates the wildcard record when there is none', () => {
    expect(plan(cfg(), healthy())).toEqual({ ok: true, createWildcard: true });
  });

  it('leaves a proxied wildcard record alone, so a second run changes nothing', () => {
    const obs = { ...healthy(), wildcard: [wildcardRecord(ONE)] };
    expect(plan(cfg(), obs)).toEqual({ ok: true, createWildcard: false });
  });

  it('refuses a wildcard record Cloudflare does not proxy', () => {
    const obs = { ...healthy(), wildcard: [{ ...wildcardRecord(ONE), proxied: false }] };
    expect(plan(cfg(), obs).ok).toBe(false);
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

  it('refuses when no certificate covers the project subdomains', () => {
    // Universal SSL on the zone covers `*.harborlight.test`, one level only.
    const obs = { ...healthy(), certificateHosts: [ZONE, `*.${ZONE}`] };
    const verdict = plan(cfg(), obs);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? [] : verdict.problems.join(' ')).toContain(`*.${ONE}`);
  });

  it('CONTROL: a certificate for the project subdomains lets the same config deploy', () => {
    const obs = { ...healthy(), certificateHosts: [ZONE, `*.${ZONE}`, `*.${ONE}`] };
    expect(plan(cfg(), obs)).toEqual({ ok: true, createWildcard: true });
  });
});

describe('the wildcard record', () => {
  it('is a proxied placeholder only the Worker answers', () => {
    expect(wildcardRecord(ONE)).toEqual({
      type: 'AAAA',
      name: `*.${ONE}`,
      content: '100::',
      proxied: true,
    });
  });
});

describe('renderWranglerToml', () => {
  const routesOf = (toml: string) => [...toml.matchAll(/pattern = "([^"]+)"/g)].map((m) => m[1]);

  it('binds only the project subdomains until board paths are bound', () => {
    expect(routesOf(renderWranglerToml(cfg(), '/w/worker.js'))).toEqual([`*.${ONE}/*`]);
  });

  it('binds the board paths too once asked, so the one address is never bound by accident', () => {
    const bound = cfg({ boards: { [MAC]: ['w-mac1'] }, bindBoardPaths: true });
    expect(routesOf(renderWranglerToml(bound, '/w/worker.js'))).toEqual([
      `*.${ONE}/*`,
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

describe('versionIdOf', () => {
  it('reads the version wrangler printed, and nothing from output without one', () => {
    const id = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
    expect(versionIdOf(`Uploaded board-router\nCurrent Version ID: ${id}\n`)).toBe(id);
    expect(versionIdOf('Uploaded board-router\n')).toBeNull();
  });
});
