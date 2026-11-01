/**
 * The Terraform variables that come from an environment's configs: the
 * board router's `router.local.json`, `access.local.json` and the share-link
 * Worker's `wrangler.local.toml`. On the Mac they are gitignored files; in CI
 * the workflow hands their contents in as CF_ROUTER_CONFIG, CF_ACCESS_CONFIG
 * and CF_SHARE_LINK_CONFIG (`run.ts`). Pure apart from the reader it is
 * handed, so a test gives it fake files. The ids only the account knows are
 * `discover.ts`'s.
 *
 * Every real hostname and address stays in those configs and in the
 * gitignored tfvars the wrapper writes; none is committed.
 */
import { join } from 'node:path';
import { parseAccessConfig } from '../access-apps/access-plan.ts';
import { parseRouterConfig } from '../board-router-worker/router-config.ts';
import { projectHost } from '../board-router-worker/worker.js';

export interface ConfigPaths {
  router: string;
  access: string;
  shareLink: string;
}

/**
 * Where the wrapper reads each environment's configs, relative to the repo
 * root. Prod's are the files the Workers' own READMEs describe; staging's sit
 * beside its root, gitignored like them.
 */
export const CONFIG_PATHS: Record<'prod' | 'staging', ConfigPaths> = {
  prod: {
    router: join('infra', 'board-router-worker', 'router.local.json'),
    access: join('infra', 'access-apps', 'access.local.json'),
    shareLink: join('infra', 'share-link-worker', 'wrangler.local.toml'),
  },
  staging: {
    router: join('infra', 'cloudflare', 'deploys', 'staging', 'router.local.json'),
    access: join('infra', 'cloudflare', 'deploys', 'staging', 'access.local.json'),
    shareLink: join('infra', 'cloudflare', 'deploys', 'staging', 'wrangler.local.toml'),
  },
};

/** The environment variable that stands in for each config in CI. */
export const CONFIG_ENV: Record<keyof ConfigPaths, string> = {
  router: 'CF_ROUTER_CONFIG',
  access: 'CF_ACCESS_CONFIG',
  shareLink: 'CF_SHARE_LINK_CONFIG',
};

/** The names a deployment gives its resources: its committed `terraform.tfvars`. */
export interface EnvNames {
  name_prefix: string;
  router_script_name: string;
  share_link_script_name: string;
}

/**
 * Reads the `key = "value"` lines of a `terraform.tfvars`. Only plain string
 * assignments are understood; a comment or a blank line is skipped, and any
 * other line is refused rather than guessed at.
 */
export function parseEnvNames(raw: string): EnvNames {
  const j: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const m = /^([a-z_]+)\s*=\s*"([^"\\]*)"$/.exec(t);
    if (!m?.[1] || m[2] === undefined)
      throw new Error(`terraform.tfvars has a line that is not key = "value": ${t}`);
    j[m[1]] = m[2];
  }
  const str = (v: unknown, what: string) => {
    if (typeof v !== 'string') throw new Error(`terraform.tfvars has no ${what}`);
    return v;
  };
  return {
    name_prefix: str(j.name_prefix, 'name_prefix'),
    router_script_name: str(j.router_script_name, 'router_script_name'),
    share_link_script_name: str(j.share_link_script_name, 'share_link_script_name'),
  };
}

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
export function staticVars(read: ReadConfig, paths: ConfigPaths = CONFIG_PATHS.prod): StaticVars {
  const routerRaw = read(paths.router);
  if (routerRaw === null) {
    throw new Error(`${paths.router} is missing; it names the zone everything lives in`);
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

  const accessRaw = read(paths.access);
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

  const shareRaw = read(paths.shareLink);
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
