/**
 * The pure half of `bun run router:deploy`: read the local config, decide
 * what Cloudflare is missing, and render the Worker's wrangler config. Nothing
 * here talks to Cloudflare, so all of it is tested directly
 * (`packages/server/test/board-router-deploy.test.ts`).
 */
import { parseBoardOrigins, parseProjectOrigins, projectHost, projectOfHost } from './worker.js';

/** What `router.local.json` holds. The real hostnames never enter the repo. */
export interface RouterConfig {
  /** The Cloudflare zone everything lives in, e.g. `harborlight.test`. */
  zone: string;
  /** The one address: a name one level under the zone, never the zone itself. */
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
  /**
   * The origin that owns the one address's Access application, the Worker's
   * `ONE_ADDRESS_ORIGIN`. Set, the one address forwards boards only there and
   * redirects every other board to its project's own hostname. Absent, every
   * board is forwarded, as before each project had an application.
   */
  oneAddressOrigin?: string;
}

/** The record a project's hostname resolves through. */
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
 * each one to an origin with `resolveOverride`. One per project: a DNS
 * wildcard covers whole labels only, and `*-workspaces.<zone>` is not one.
 */
export function projectRecord(host: string): DnsRecord {
  return { type: 'AAAA', name: host, content: '100::', proxied: true };
}

/** Every project's own hostname, `<label>-<first label>.<zone>`, sorted. */
export function projectHostsOf(cfg: RouterConfig): string[] {
  return Object.keys(cfg.projects)
    .map((label) => projectHost(label, cfg.oneAddress))
    .sort();
}

/** A lower-case hostname, no port: what `url.hostname` gives the Worker. */
const HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

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
  // One level under the zone and not the apex: a project's hostname is
  // `<label>-<first label>` beside it, so a deeper one address would put the
  // projects two levels down, past what Universal SSL covers.
  if (!HOSTNAME.test(oneAddress) || oneAddress.slice(oneAddress.indexOf('.') + 1) !== zone) {
    throw new Error('oneAddress must be a lower-case name one level under the zone');
  }
  const projects = (o.projects ?? {}) as Record<string, string>;
  const boards = (o.boards ?? {}) as Record<string, string[]>;
  const projectTable = parseProjectOrigins(JSON.stringify(projects));
  if (!projectTable) throw new Error('projects is not a valid PROJECT_ORIGINS table');
  if (!parseBoardOrigins(JSON.stringify(boards))) {
    throw new Error('boards is not a valid BOARD_ORIGINS table');
  }
  for (const label of projectTable.keys()) {
    const host = projectHost(label, oneAddress);
    if (!HOSTNAME.test(host)) throw new Error(`project ${label}: ${host} is not a valid hostname`);
  }
  const origins = [...projectTable.values(), ...Object.keys(boards)];
  for (const origin of origins) {
    // `resolveOverride` only reaches a name in the Worker's own zone, and an
    // origin with a project hostname's shape would be answered by the Worker
    // as a project, not reached as an origin. With the one address named
    // `origin.<zone>`, every `<project>-origin.<zone>` would be one.
    if (!inZone(origin, zone)) throw new Error(`origin ${origin} is not in zone ${zone}`);
    if (origin === oneAddress || projectOfHost(origin, oneAddress) !== null) {
      throw new Error(`origin ${origin} has the shape of a project hostname or the one address`);
    }
  }
  const bindBoardPaths = o.bindBoardPaths === true;
  if (bindBoardPaths && Object.keys(boards).length === 0) {
    throw new Error('bindBoardPaths needs a boards table');
  }
  const oneAddressOrigin = typeof o.oneAddressOrigin === 'string' ? o.oneAddressOrigin : '';
  if (oneAddressOrigin && !origins.includes(oneAddressOrigin)) {
    throw new Error(`oneAddressOrigin ${oneAddressOrigin} is not an origin in the tables`);
  }
  return {
    zone,
    oneAddress,
    projects,
    boards,
    bindBoardPaths,
    ...(oneAddressOrigin ? { oneAddressOrigin } : {}),
  };
}

/** Every origin hostname the config sends requests to, once each. */
export function originsOf(cfg: RouterConfig): string[] {
  return [...new Set([...Object.values(cfg.projects), ...Object.keys(cfg.boards)])].sort();
}

/** What Cloudflare holds now, as the runner read it. */
export interface Observed {
  /** Project hostname -> the records under that name. */
  hosts: Record<string, DnsRecord[]>;
  /** Origin hostname -> the records under that name. */
  origins: Record<string, DnsRecord[]>;
  /** Every hostname some certificate pack on the zone covers. */
  certificateHosts: string[];
}

/** `create` lists the project hostnames that have no record yet. */
export type Plan = { ok: true; create: string[] } | { ok: false; problems: string[] };

/** Whether a certificate host (`a.b`, `*.b`) covers `hostname`, one level for a wildcard. */
function certCovers(pattern: string, hostname: string): boolean {
  if (!pattern.startsWith('*.')) return pattern === hostname;
  const rest = hostname.slice(hostname.indexOf('.') + 1);
  return hostname.includes('.') && rest === pattern.slice(2);
}

/**
 * What the deploy must do, or why it must not run. It refuses rather than
 * deploying a Worker that could not serve: a project record Cloudflare does
 * not proxy never reaches the Worker, an origin with no proxied record is a
 * `resolveOverride` to nowhere, and a hostname no certificate covers fails
 * TLS before Access or the Worker sees it.
 */
export function plan(cfg: RouterConfig, obs: Observed): Plan {
  const problems: string[] = [];
  const create: string[] = [];
  for (const host of projectHostsOf(cfg)) {
    const records = obs.hosts[host] ?? [];
    if (records.length === 0) create.push(host);
    if (records.some((r) => !r.proxied)) {
      problems.push(`${host} exists but is not proxied; fix it in the dashboard`);
    }
    if (!obs.certificateHosts.some((p) => certCovers(p, host))) {
      problems.push(
        `no certificate covers ${host}; Universal SSL on ${cfg.zone} covers *.${cfg.zone} (README "Certificate")`,
      );
    }
  }
  for (const origin of originsOf(cfg)) {
    if (!(obs.origins[origin] ?? []).some((r) => r.proxied)) {
      problems.push(`origin ${origin} has no proxied DNS record (README "Deploying" step 1)`);
    }
  }
  if (Object.keys(cfg.projects).length === 0 && !cfg.bindBoardPaths) {
    problems.push('nothing to bind: projects is empty and bindBoardPaths is off');
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, create };
}

const toml = (s: string) => JSON.stringify(s);

/**
 * The wrangler config the deploy runs with: one route per project hostname,
 * so no name the table does not list reaches the Worker, and the one address
 * stays unbound. `workers_dev` and preview URLs are off, so the Worker
 * answers only on its routes, behind Access.
 */
export function renderWranglerToml(cfg: RouterConfig, workerPath: string): string {
  const routes = projectHostsOf(cfg).map((host) => `${host}/*`);
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
    ...(cfg.oneAddressOrigin ? [`ONE_ADDRESS_ORIGIN = ${toml(cfg.oneAddressOrigin)}`] : []),
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
