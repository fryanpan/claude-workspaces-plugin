/**
 * The pure half of `bun run router:deploy`: read the local config, decide
 * what Cloudflare is missing, and render the Worker's wrangler config. Nothing
 * here talks to Cloudflare, so all of it is tested directly
 * (`packages/server/test/board-router-deploy.test.ts`).
 */
import { parseBoardOrigins, parseProjectOrigins } from './worker.js';

/** What `router.local.json` holds. The real hostnames never enter the repo. */
export interface RouterConfig {
  /** The Cloudflare zone everything lives in, e.g. `harborlight.test`. */
  zone: string;
  /** The one address: the zone itself or a name under it. */
  oneAddress: string;
  /** Project label -> origin hostname, the Worker's `PROJECT_ORIGINS`. */
  projects: Record<string, string>;
  /** Origin hostname -> board ids, the Worker's `BOARD_ORIGINS`. */
  boards: Record<string, string[]>;
  /**
   * Bind `<one address>/workspaces/*` to the Worker too. Off until every
   * board the one address serves is in `boards`: a board the table does not
   * list gets a 404 from the Worker, so binding the path early would take
   * today's boards offline.
   */
  bindBoardPaths: boolean;
}

/** The wildcard record every project subdomain resolves through. */
export interface DnsRecord {
  id?: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

/**
 * An AAAA record to `100::`, proxied: the documented placeholder for a name
 * only a Worker answers. No request goes to that address; the Worker sends
 * each one to an origin with `resolveOverride`.
 */
export function wildcardRecord(oneAddress: string): DnsRecord {
  return { type: 'AAAA', name: `*.${oneAddress}`, content: '100::', proxied: true };
}

const inZone = (name: string, zone: string) => name === zone || name.endsWith(`.${zone}`);

/** Parse and check `router.local.json`. Throws naming the first problem. */
export function parseRouterConfig(raw: string): RouterConfig {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error('router.local.json is not JSON');
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('router.local.json must be an object');
  }
  const o = v as Record<string, unknown>;
  const zone = typeof o.zone === 'string' ? o.zone : '';
  const oneAddress = typeof o.oneAddress === 'string' ? o.oneAddress : '';
  if (!zone) throw new Error('zone is missing');
  if (!oneAddress || !inZone(oneAddress, zone)) {
    throw new Error('oneAddress must be the zone or a name under it');
  }
  const projects = (o.projects ?? {}) as Record<string, string>;
  const boards = (o.boards ?? {}) as Record<string, string[]>;
  const projectTable = parseProjectOrigins(JSON.stringify(projects));
  if (!projectTable) throw new Error('projects is not a valid PROJECT_ORIGINS table');
  if (!parseBoardOrigins(JSON.stringify(boards))) {
    throw new Error('boards is not a valid BOARD_ORIGINS table');
  }
  const origins = [...projectTable.values(), ...Object.keys(boards)];
  for (const origin of origins) {
    // `resolveOverride` only reaches a name in the Worker's own zone, and an
    // origin under the one address would itself be a project subdomain.
    if (!inZone(origin, zone)) throw new Error(`origin ${origin} is not in zone ${zone}`);
    if (origin.endsWith(`.${oneAddress}`)) {
      throw new Error(`origin ${origin} is under the one address`);
    }
  }
  const bindBoardPaths = o.bindBoardPaths === true;
  if (bindBoardPaths && Object.keys(boards).length === 0) {
    throw new Error('bindBoardPaths needs a boards table');
  }
  return { zone, oneAddress, projects, boards, bindBoardPaths };
}

/** Every origin hostname the config sends requests to, once each. */
export function originsOf(cfg: RouterConfig): string[] {
  return [...new Set([...Object.values(cfg.projects), ...Object.keys(cfg.boards)])].sort();
}

/** What Cloudflare holds now, as the runner read it. */
export interface Observed {
  /** Records already named `*.<one address>`. */
  wildcard: DnsRecord[];
  /** Origin hostname -> the records under that name. */
  origins: Record<string, DnsRecord[]>;
  /** Every hostname some certificate pack on the zone covers. */
  certificateHosts: string[];
}

export type Plan = { ok: true; createWildcard: boolean } | { ok: false; problems: string[] };

/**
 * What the deploy must do, or why it must not run. It refuses rather than
 * deploying a Worker that could not serve: a wildcard record Cloudflare does
 * not proxy never reaches the Worker, an origin with no proxied record is a
 * `resolveOverride` to nowhere, and a subdomain no certificate covers fails
 * TLS before Access or the Worker sees it.
 */
export function plan(cfg: RouterConfig, obs: Observed): Plan {
  const problems: string[] = [];
  const want = wildcardRecord(cfg.oneAddress);
  if (obs.wildcard.some((r) => !r.proxied)) {
    problems.push(`${want.name} exists but is not proxied; fix it in the dashboard`);
  }
  for (const origin of originsOf(cfg)) {
    if (!(obs.origins[origin] ?? []).some((r) => r.proxied)) {
      problems.push(`origin ${origin} has no proxied DNS record (README "Deploying" step 1)`);
    }
  }
  if (!obs.certificateHosts.includes(want.name)) {
    problems.push(
      `no certificate covers ${want.name}: Universal SSL reaches one level under the zone, so this needs an advanced certificate (README "Certificate")`,
    );
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, createWildcard: obs.wildcard.length === 0 };
}

const toml = (s: string) => JSON.stringify(s);

/**
 * The wrangler config the deploy runs with. `workers_dev` and preview URLs are
 * off, so the Worker answers only on its routes, behind Access.
 */
export function renderWranglerToml(cfg: RouterConfig, workerPath: string): string {
  const routes = [`*.${cfg.oneAddress}/*`];
  if (cfg.bindBoardPaths) routes.push(`${cfg.oneAddress}/workspaces/*`);
  return [
    '# Generated by infra/board-router-worker/deploy.ts. Do not commit.',
    'name = "board-router"',
    `main = ${toml(workerPath)}`,
    'compatibility_date = "2026-08-01"',
    'workers_dev = false',
    'preview_urls = false',
    'routes = [',
    ...routes.map((p) => `  { pattern = ${toml(p)}, zone_name = ${toml(cfg.zone)} },`),
    ']',
    '',
    '[vars]',
    `ONE_ADDRESS = ${toml(cfg.oneAddress)}`,
    `PROJECT_ORIGINS = ${toml(JSON.stringify(cfg.projects))}`,
    `BOARD_ORIGINS = ${toml(JSON.stringify(cfg.boards))}`,
    '',
    '[observability]',
    'enabled = false',
    '',
  ].join('\n');
}

/** The version id `wrangler deploy` prints, or null when it printed none. */
export function versionIdOf(output: string): string | null {
  const m = /Current Version ID:\s*([0-9a-f-]{36})/i.exec(output);
  return m?.[1] ?? null;
}
