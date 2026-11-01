/**
 * `router.local.json`, read and checked: the zone, the one address and the
 * routing tables the board router Worker carries. `infra/cloudflare/vars.ts`
 * turns it into the OpenTofu config's variables, and `machine:deploy` reads
 * the zone and one address from it. Nothing here talks to Cloudflare.
 * Tested by `packages/server/test/board-router-config.test.ts`.
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
