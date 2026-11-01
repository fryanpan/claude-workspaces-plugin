/**
 * The OpenTofu variables that come from files on this Mac: the gitignored
 * `router.local.json`, `access.local.json` and the share-link Worker's
 * `wrangler.local.toml`. Pure apart from the reader it is handed, so a test
 * gives it fake files. The ids only the account knows are `discover.ts`'s.
 *
 * Every real hostname and address stays in those local files and in the
 * gitignored tfvars the wrapper writes; none is committed.
 */
import { join } from 'node:path';
import { parseAccessConfig } from '../access-apps/access-plan.ts';
import { parseRouterConfig } from '../board-router-worker/router-config.ts';
import { projectHost } from '../board-router-worker/worker.js';

/** Where the wrapper reads each config, relative to the repo root. */
export const CONFIG_PATHS = {
  router: join('infra', 'board-router-worker', 'router.local.json'),
  access: join('infra', 'access-apps', 'access.local.json'),
  shareLink: join('infra', 'share-link-worker', 'wrangler.local.toml'),
} as const;

/** Reads one file; null when it does not exist. */
export type ReadConfig = (relPath: string) => string | null;

export interface TunnelVar {
  name: string;
  origin: string;
  public_host: string;
}

export interface AccessProjectVar {
  hosts: string[];
  emails: string[];
  email_domains: string[];
  service_tokens: string[];
}

/** The variables of `variables.tf` that local files decide. */
export interface StaticVars {
  zone: string;
  one_address: string;
  project_origins: Record<string, string>;
  project_hosts: Record<string, string>;
  board_origins: Record<string, string[]>;
  bind_board_paths: boolean;
  one_address_origin: string;
  tunnels: Record<string, TunnelVar>;
  access_session_duration: string;
  access_projects: Record<string, AccessProjectVar>;
  share_link_routes: string[];
}

/** The origin hostname `machine:deploy` gives a project's Fly machine. */
export const machineOrigin = (label: string, zone: string): string => `${label}-origin.${zone}`;

/** The tunnel name `machine:deploy` gives a project (`projectConfig`'s `app`). */
export const machineTunnel = (label: string): string => `cw-${label}`;

const inZone = (host: string, zone: string) => host === zone || host.endsWith(`.${zone}`);

/**
 * The share-link Worker's routes from `wrangler.local.toml`. Each must be a
 * `<host>/share/*` pattern in the router's zone: the config manages one zone.
 */
export function shareLinkRoutes(raw: string, zone: string): string[] {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(raw);
  } catch {
    throw new Error('wrangler.local.toml is not TOML');
  }
  const routes = (parsed as { routes?: unknown }).routes;
  if (!Array.isArray(routes)) throw new Error('wrangler.local.toml lists no routes');
  return routes.map((r: { pattern?: unknown; zone_name?: unknown }) => {
    const pattern = typeof r?.pattern === 'string' ? r.pattern : '';
    const host = pattern.endsWith('/share/*') ? pattern.slice(0, -'/share/*'.length) : '';
    if (!host || host.includes('<') || !/^[a-z0-9.-]+$/.test(host)) {
      throw new Error('a share-link route is not a <host>/share/* pattern');
    }
    if (r.zone_name !== zone || !inZone(host, zone)) {
      throw new Error("a share-link route is outside router.local.json's zone");
    }
    return pattern;
  });
}

/**
 * Every variable a local file decides. Refuses, naming why, a missing
 * `router.local.json` (it names the zone), and an Access host that is a
 * tunnel's origin: the router's requests to that origin would then carry the
 * wrong stamp.
 */
export function staticVars(read: ReadConfig): StaticVars {
  const routerRaw = read(CONFIG_PATHS.router);
  if (routerRaw === null) {
    throw new Error(`${CONFIG_PATHS.router} is missing; it names the zone everything lives in`);
  }
  const router = parseRouterConfig(routerRaw);
  const project_hosts: Record<string, string> = {};
  const tunnels: Record<string, TunnelVar> = {};
  for (const [label, origin] of Object.entries(router.projects)) {
    const public_host = projectHost(label, router.oneAddress);
    project_hosts[label] = public_host;
    // A project whose origin has the machine's name runs on a Fly machine
    // with a named tunnel; any other origin (the Mac's) is not ours to make.
    if (origin === machineOrigin(label, router.zone)) {
      tunnels[label] = { name: machineTunnel(label), origin, public_host };
    }
  }

  const accessRaw = read(CONFIG_PATHS.access);
  const access = accessRaw === null ? null : parseAccessConfig(accessRaw);
  const access_projects: Record<string, AccessProjectVar> = {};
  const origins = new Set(Object.values(tunnels).map((t) => t.origin));
  for (const [label, p] of Object.entries(access?.projects ?? {})) {
    for (const h of p.hosts) {
      if (origins.has(h)) {
        throw new Error(
          `${label}: ${h} is a tunnel's origin; an origin must have no Access application`,
        );
      }
    }
    access_projects[label] = {
      hosts: p.hosts,
      emails: p.emails,
      email_domains: p.emailDomains,
      service_tokens: p.serviceTokens,
    };
  }

  const shareRaw = read(CONFIG_PATHS.shareLink);
  return {
    zone: router.zone,
    one_address: router.oneAddress,
    project_origins: router.projects,
    project_hosts,
    board_origins: router.boards,
    bind_board_paths: router.bindBoardPaths,
    one_address_origin: router.oneAddressOrigin ?? '',
    tunnels,
    access_session_duration: access?.sessionDuration ?? '24h',
    access_projects,
    share_link_routes: shareRaw === null ? [] : shareLinkRoutes(shareRaw, router.zone),
  };
}
