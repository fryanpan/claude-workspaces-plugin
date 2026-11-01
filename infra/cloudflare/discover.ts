/**
 * The variables only the account knows, read before every plan: the zone and
 * account ids, each service token's id, and the id of every live resource the
 * config names, so Terraform adopts it (`deploys/prod/imports.tf`) instead of
 * making a second one. Reads only; it sends no write. Names come from the
 * deployment's `terraform.tfvars`, so staging looks for its own.
 *
 * It also refuses, before terraform runs, the cases the old deploy scripts
 * refused, because a plan would otherwise repoint or shadow something this
 * config did not make:
 *
 * - a project host covered by an Access application the config does not own
 *   (prod's sign-in application is never shadowed), or any Access
 *   application over a tunnel's origin;
 * - two applications, policies, tunnels or records where the config names
 *   one, an application named `board <project>` that is not `self_hosted`,
 *   or a tunnel configured from a file on the machine;
 * - a tunnel origin's record that is not a proxied CNAME to that tunnel;
 * - a route the config names that another Worker holds;
 * - a service token name that matches no token;
 * - an origin of the Mac's with no proxied record, or a project hostname no
 *   certificate covers (Universal SSL switched off).
 *
 * Tested against a fake account by
 * `packages/server/test/cloudflare-tf-discover.test.ts`.
 */
import type { CloudflareApi } from '../project-machine/cloudflare.ts';
import type { EnvNames, StaticVars } from './vars.ts';

export interface Imports {
  access_apps: Record<string, string>;
  access_people_policies: Record<string, string>;
  access_token_policies: Record<string, string>;
  scripts: Record<string, string>;
  /** Board router routes, keyed as `modules/router-worker` keys them. */
  routes: Record<string, string>;
  /** Share-link routes, keyed as `modules/stack` keys them. */
  share_routes: Record<string, string>;
  dns_records: Record<string, string>;
  tunnels: Record<string, string>;
}

export interface RuntimeVars {
  account_id: string;
  zone_id: string;
  service_token_ids: Record<string, string>;
  imports: Imports;
}

export type Discovery = { ok: true; vars: RuntimeVars } | { ok: false; refusals: string[] };

interface AccessApp {
  id: string;
  name: string;
  type?: string;
  domain?: string;
  self_hosted_domains?: string[];
  destinations?: Array<{ uri?: string }>;
}

interface Named {
  id: string;
  name: string;
}

interface Tunnel extends Named {
  deleted_at?: string | null;
  remote_config?: boolean;
  config_src?: string;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

/** The board router's routes, keyed as `modules/router-worker/main.tf` keys them. */
export function routerRoutes(v: StaticVars): Record<string, string> {
  const routes: Record<string, string> = {};
  for (const [label, host] of Object.entries(v.project_hosts)) routes[label] = `${host}/*`;
  if (v.bind_board_paths) routes['one-address/workspaces'] = `${v.one_address}/workspaces/*`;
  return routes;
}

/** The share-link routes, keyed by host without the zone, as `modules/stack/main.tf` does. */
export function shareRoutes(v: StaticVars): Record<string, string> {
  const routes: Record<string, string> = {};
  for (const p of v.share_link_routes) {
    const host = p.slice(0, -'/share/*'.length);
    routes[host.endsWith(`.${v.zone}`) ? host.slice(0, -(v.zone.length + 1)) : host] = p;
  }
  return routes;
}

/** The hostnames an Access application covers, scheme, path and wildcard stripped. */
function coveredHosts(app: AccessApp): string[] {
  const raw = [
    app.domain,
    ...(app.self_hosted_domains ?? []),
    ...(app.destinations ?? []).map((d) => d.uri),
  ];
  return raw
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
    .map((d) => (d.replace(/^https?:\/\//, '').split('/')[0] ?? '').toLowerCase());
}

/** Whether an Access or certificate pattern (`a.b`, `*.b`) is `host` or above it. */
function covers(pattern: string, host: string): boolean {
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
  return pattern === host;
}

/** Whether a certificate host covers `host`: a wildcard reaches one level only. */
function certCovers(pattern: string, host: string): boolean {
  if (!pattern.startsWith('*.')) return pattern === host;
  return host.includes('.') && host.slice(host.indexOf('.') + 1) === pattern.slice(2);
}

/** The one entry named `name`, or a refusal when there are several. */
function one<T extends { id: string }>(all: T[], what: string, refusals: string[]): T | undefined {
  if (all.length > 1) refusals.push(`there are ${all.length} ${what}; resolve that by hand`);
  return all.length === 1 ? all[0] : undefined;
}

export async function discover(
  api: CloudflareApi,
  v: StaticVars,
  names: EnvNames,
): Promise<Discovery> {
  const refusals: string[] = [];
  const zones = await api<Array<{ id: string; account: { id: string } }>>(
    'GET',
    `/zones?name=${encodeURIComponent(v.zone)}`,
  );
  const zone = zones[0];
  if (!zone) return { ok: false, refusals: [`the token sees no zone named ${v.zone}`] };
  const A = `/accounts/${zone.account.id}`;
  const Z = `/zones/${zone.id}`;
  const imports: Imports = {
    access_apps: {},
    access_people_policies: {},
    access_token_policies: {},
    scripts: {},
    routes: {},
    share_routes: {},
    dns_records: {},
    tunnels: {},
  };
  const records = async (name: string) =>
    (await api<DnsRecord[]>('GET', `${Z}/dns_records?name=${encodeURIComponent(name)}`)).filter(
      (r) => r.name === name,
    );

  // Certificates and the Mac's origins: what the router needs and does not make.
  const packs = await api<Array<{ hosts?: string[] }>>(
    'GET',
    `${Z}/ssl/certificate_packs?status=all`,
  );
  const certHosts = packs.flatMap((p) => p.hosts ?? []);
  for (const host of Object.values(v.project_hosts)) {
    if (!certHosts.some((p) => certCovers(p, host))) {
      refusals.push(
        `no certificate covers ${host}; Universal SSL on the zone covers one level under it`,
      );
    }
  }
  const tunnelOrigins = new Set(Object.values(v.tunnels).map((t) => t.origin));
  const foreignOrigins = [
    ...new Set([...Object.values(v.project_origins), ...Object.keys(v.board_origins)]),
  ]
    .filter((o) => !tunnelOrigins.has(o))
    .sort();
  for (const origin of foreignOrigins) {
    if (!(await records(origin)).some((r) => r.proxied)) {
      refusals.push(`origin ${origin} has no proxied DNS record`);
    }
  }

  // Access applications and policies.
  const apps = await api.all<AccessApp>(`${A}/access/apps`);
  const appName = (label: string) => `${names.name_prefix}board ${label}`;
  const owned = new Map(Object.keys(v.access_projects).map((l) => [appName(l), l]));
  for (const [label, p] of Object.entries(v.access_projects)) {
    const app = one(
      apps.filter((a) => a.name === appName(label)),
      `applications named "${appName(label)}"`,
      refusals,
    );
    if (app && app.type !== 'self_hosted') {
      refusals.push(
        `the application "${appName(label)}" is ${app.type ?? 'of no type'}, not self_hosted`,
      );
    } else if (app) imports.access_apps[label] = app.id;
    for (const host of p.hosts) {
      for (const a of apps.filter((x) => !owned.has(x.name))) {
        if (coveredHosts(a).some((c) => covers(c, host) || host.endsWith(`.${c}`))) {
          refusals.push(
            `${label}: ${host} is covered by the application "${a.name}", which the config does not own`,
          );
        }
      }
    }
  }
  for (const origin of tunnelOrigins) {
    for (const a of apps.filter((x) => coveredHosts(x).some((c) => covers(c, origin)))) {
      refusals.push(
        `the Access application "${a.name}" covers ${origin}; a tunnel's origin must have none`,
      );
    }
  }
  const projects = Object.entries(v.access_projects);
  const peopleLabels = projects
    .filter(([, p]) => p.emails.length + p.email_domains.length > 0)
    .map(([l]) => l);
  const tokenLabels = projects.filter(([, p]) => p.service_tokens.length > 0).map(([l]) => l);
  const service_token_ids: Record<string, string> = {};
  if (peopleLabels.length + tokenLabels.length > 0) {
    const policies = await api.all<Named>(`${A}/access/policies`);
    const adopt = (labels: string[], suffix: string, into: Record<string, string>) => {
      for (const label of labels) {
        const name = `${names.name_prefix}${label} ${suffix}`;
        const found = one(
          policies.filter((p) => p.name === name),
          `policies named "${name}"`,
          refusals,
        );
        if (found) into[label] = found.id;
      }
    };
    adopt(peopleLabels, 'people', imports.access_people_policies);
    adopt(tokenLabels, 'service tokens', imports.access_token_policies);
  }
  const tokenNames = [...new Set(projects.flatMap(([, p]) => p.service_tokens))];
  if (tokenNames.length > 0) {
    const tokens = await api.all<Named>(`${A}/access/service_tokens`);
    for (const name of tokenNames) {
      const found = tokens.filter((t) => t.name === name);
      if (found.length === 0) refusals.push(`no service token is named "${name}"`);
      const t = one(found, `service tokens named "${name}"`, refusals);
      if (t) service_token_ids[name] = t.id;
    }
  }

  // Workers and their routes.
  const router = names.router_script_name;
  const share = names.share_link_script_name;
  const scriptNames = [router, ...(v.share_link_routes.length > 0 ? [share] : [])];
  const scripts = await api<Array<{ id: string }>>('GET', `${A}/workers/scripts`);
  for (const name of scriptNames)
    if (scripts.some((s) => s.id === name)) imports.scripts[name] = name;
  const routes = await api<Array<{ id: string; pattern: string; script?: string }>>(
    'GET',
    `${Z}/workers/routes`,
  );
  const want: Array<[Record<string, string>, string, Record<string, string>]> = [
    [routerRoutes(v), router, imports.routes],
    [shareRoutes(v), share, imports.share_routes],
  ];
  for (const [keyed, script, into] of want) {
    for (const [key, pattern] of Object.entries(keyed)) {
      const found = one(
        routes.filter((r) => r.pattern === pattern),
        `routes for ${pattern}`,
        refusals,
      );
      if (!found) continue;
      if (found.script && found.script !== script) {
        refusals.push(`the route ${pattern} is bound to the Worker ${found.script}, not ${script}`);
      } else into[key] = found.id;
    }
  }

  // Project hostnames, then each machine's tunnel and its origin record.
  for (const host of Object.values(v.project_hosts)) {
    const r = one(await records(host), `records named ${host}`, refusals);
    if (r) imports.dns_records[host] = r.id;
  }
  for (const [label, t] of Object.entries(v.tunnels)) {
    const listed = await api<Tunnel[]>(
      'GET',
      `${A}/cfd_tunnel?name=${encodeURIComponent(t.name)}&is_deleted=false`,
    );
    const tunnel = one(
      listed.filter((x) => x.name === t.name && !x.deleted_at),
      `live tunnels named ${t.name}`,
      refusals,
    );
    if (tunnel && !(tunnel.remote_config === true || tunnel.config_src === 'cloudflare')) {
      refusals.push(`tunnel ${t.name} reads its ingress from a file, not from Cloudflare`);
    } else if (tunnel) imports.tunnels[label] = tunnel.id;
    const r = one(await records(t.origin), `records named ${t.origin}`, refusals);
    if (!r) continue;
    const target = tunnel ? `${tunnel.id}.cfargotunnel.com` : undefined;
    if (r.type !== 'CNAME' || !r.proxied || r.content !== target) {
      refusals.push(
        `${t.origin} already has a ${r.proxied ? 'proxied' : 'DNS-only'} ${r.type} record to ${r.content}; it must be a proxied CNAME to ${target ?? `the tunnel ${t.name}`}. Remove or fix it in the dashboard`,
      );
    } else imports.dns_records[t.origin] = r.id;
  }

  if (refusals.length > 0) return { ok: false, refusals };
  return {
    ok: true,
    vars: { account_id: zone.account.id, zone_id: zone.id, service_token_ids, imports },
  };
}
