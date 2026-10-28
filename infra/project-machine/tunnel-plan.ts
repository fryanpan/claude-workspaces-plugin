/**
 * The named tunnel's decisions, with no I/O: what the tunnel and its
 * hostnames are called, what a run still has to do in Cloudflare, the request
 * bodies it sends and how it reads Cloudflare's answers. `deploy.ts` does the
 * calls. Tested in `packages/server/test/project-machine-tunnel.test.ts`.
 *
 * Three things in Cloudflare make a project's named tunnel (board router
 * README, "Each project's side"):
 *
 *   the tunnel `cw-<project>`, configured from Cloudflare (not from a file on
 *     the machine), whose one ingress rule sends the project's own hostname
 *     `<project>-<first label of the one address>.<zone>` to the server on
 *     `http://localhost:8787`, and everything else to a 404
 *   the origin hostname `<project>-origin.<zone>`: a proxied CNAME to the
 *     tunnel, with no Access application on it, which the router Worker
 *     resolves the project's hostname to
 *   the tunnel's token, which the machine holds as CLOUDFLARE_TUNNEL_TOKEN
 *
 * A run over a project whose tunnel is complete plans nothing. A run that
 * finds something it did not make in the way stops before changing anything.
 */
import { projectHost } from '../board-router-worker/worker.js';
import type { ProjectConfig } from './deploy-plan.ts';

/** Where the server listens on the machine (entrypoint.sh). */
export const TUNNEL_SERVICE = 'http://localhost:8787';
export const TUNNEL_TOKEN_SECRET = 'CLOUDFLARE_TUNNEL_TOKEN';

export interface TunnelNames {
  /** The Cloudflare zone, from the router's `router.local.json`. */
  zone: string;
  tunnel: string;
  /** The proxied CNAME to the tunnel; the router's `PROJECT_ORIGINS` value. */
  origin: string;
  /** `<project>-<first label>.<zone>`: the Host every routed request carries. */
  publicHost: string;
}

export function tunnelNames(
  cfg: ProjectConfig,
  router: { zone: string; oneAddress: string },
): TunnelNames {
  return {
    zone: router.zone,
    tunnel: cfg.app,
    origin: `${cfg.project}-origin.${router.zone}`,
    publicHost: projectHost(cfg.project, router.oneAddress),
  };
}

export interface IngressRule {
  hostname?: string;
  path?: string;
  service: string;
}

/** The tunnel's whole ingress: the project's hostname to the server, then a 404. */
export function desiredIngress(names: TunnelNames): IngressRule[] {
  return [{ hostname: names.publicHost, service: TUNNEL_SERVICE }, { service: 'http_status:404' }];
}

/** The body of `PUT cfd_tunnel/<id>/configurations`. */
export function tunnelConfigBody(names: TunnelNames): { config: { ingress: IngressRule[] } } {
  return { config: { ingress: desiredIngress(names) } };
}

/** The body of `POST cfd_tunnel`: a tunnel whose ingress Cloudflare holds. */
export function tunnelCreateBody(names: TunnelNames): { name: string; config_src: 'cloudflare' } {
  return { name: names.tunnel, config_src: 'cloudflare' };
}

export interface DnsRecord {
  id?: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

export const tunnelTarget = (tunnelId: string) => `${tunnelId}.cfargotunnel.com`;

/** The body of `POST zones/<id>/dns_records` for the origin hostname. */
export function originRecord(
  names: TunnelNames,
  tunnelId: string,
): DnsRecord & { comment: string } {
  return {
    type: 'CNAME',
    name: names.origin,
    content: tunnelTarget(tunnelId),
    proxied: true,
    comment: `${names.tunnel}: the origin the board router resolves ${names.publicHost} to`,
  };
}

export interface CfTunnel {
  id: string;
  name: string;
  /** False when cloudflared reads its ingress from a file on the machine. */
  remoteConfig: boolean;
}

/** One entry of `GET cfd_tunnel?name=…&is_deleted=false`. */
export function parseTunnels(result: unknown): CfTunnel[] {
  if (!Array.isArray(result)) throw new Error('cfd_tunnel list is not an array');
  return result
    .filter((t): t is Record<string, unknown> => t !== null && typeof t === 'object')
    .filter((t) => typeof t.id === 'string' && typeof t.name === 'string' && !t.deleted_at)
    .map((t) => ({
      id: t.id as string,
      name: t.name as string,
      remoteConfig: t.remote_config === true || t.config_src === 'cloudflare',
    }));
}

/** The tunnel's ingress from `GET cfd_tunnel/<id>/configurations`, or null when it has none. */
export function parseIngress(result: unknown): IngressRule[] | null {
  const config = (result as { config?: { ingress?: unknown } } | null)?.config;
  if (!Array.isArray(config?.ingress)) return null;
  return config.ingress.map((r: Record<string, unknown>) => ({
    ...(typeof r.hostname === 'string' && r.hostname ? { hostname: r.hostname } : {}),
    ...(typeof r.path === 'string' && r.path ? { path: r.path } : {}),
    service: typeof r.service === 'string' ? r.service : '',
  }));
}

/** `GET cfd_tunnel/<id>/token` answers with the token as a bare string. */
export function parseTunnelToken(result: unknown): string {
  if (typeof result !== 'string' || result.length < 20 || /\s/.test(result)) {
    throw new Error('Cloudflare answered the tunnel token request without a token');
  }
  return result;
}

export function sameIngress(a: readonly IngressRule[], b: readonly IngressRule[]): boolean {
  const key = (r: IngressRule) => `${r.hostname ?? ''}\t${r.path ?? ''}\t${r.service}`;
  return a.length === b.length && a.every((r, i) => key(r) === key(b[i] as IngressRule));
}

export interface AccessApp {
  name: string;
  /** Every hostname pattern the application covers, path removed. */
  hosts: string[];
}

/** `GET accounts/<id>/access/apps`, reduced to the hostnames each app covers. */
export function parseAccessApps(result: unknown): AccessApp[] {
  if (!Array.isArray(result)) throw new Error('access apps list is not an array');
  const host = (v: unknown) =>
    typeof v === 'string' && v ? (v.replace(/^https?:\/\//, '').split('/')[0] ?? '') : '';
  return result.map((a: Record<string, unknown>) => {
    const destinations = Array.isArray(a.destinations)
      ? (a.destinations as Array<Record<string, unknown>>).map((d) => d.uri)
      : [];
    const domains = Array.isArray(a.self_hosted_domains) ? a.self_hosted_domains : [];
    const hosts = [a.domain, ...domains, ...destinations].map(host).filter((h) => h.length > 0);
    return { name: typeof a.name === 'string' ? a.name : '(unnamed)', hosts: [...new Set(hosts)] };
  });
}

/** Whether an Access hostname pattern (`a.b`, `*.b`) covers `hostname`. */
export function coversHost(pattern: string, hostname: string): boolean {
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return hostname.endsWith(p.slice(1));
  return p === hostname;
}

export interface TunnelObserved {
  /** Live tunnels named `cw-<project>`. */
  tunnels: CfTunnel[];
  /** The found tunnel's ingress; null when there is no tunnel or no config. */
  ingress: IngressRule[] | null;
  /** Every record named the origin hostname. */
  originRecords: DnsRecord[];
  accessApps: AccessApp[];
}

export type TunnelAction =
  | { kind: 'create-tunnel' }
  | { kind: 'set-tunnel-config' }
  | { kind: 'create-origin-record' };

export type TunnelPlan =
  | {
      ok: true;
      actions: TunnelAction[];
      /** The existing tunnel's id; absent when this run creates it. */
      tunnelId?: string;
    }
  | { ok: false; problems: string[] };

/**
 * What the run must do in Cloudflare, or why it must not run. It never
 * repoints or deletes a record or tunnel it finds: a second tunnel of the
 * name, a record at the origin hostname that is not a proxied CNAME to this
 * tunnel, or an Access application over the origin hostname stops it.
 */
export function planTunnel(names: TunnelNames, obs: TunnelObserved): TunnelPlan {
  const problems: string[] = [];
  if (obs.tunnels.length > 1) {
    problems.push(
      `${obs.tunnels.length} live tunnels are named ${names.tunnel}; delete all but one`,
    );
  }
  const tunnel = obs.tunnels.length === 1 ? obs.tunnels[0] : undefined;
  if (tunnel && !tunnel.remoteConfig) {
    problems.push(
      `tunnel ${names.tunnel} reads its ingress from a file, not from Cloudflare; the deploy cannot set it`,
    );
  }
  const covering = obs.accessApps.filter((a) => a.hosts.some((h) => coversHost(h, names.origin)));
  for (const a of covering) {
    problems.push(
      `Access application "${a.name}" covers ${names.origin}; the origin must have none, or the router's requests carry the wrong stamp`,
    );
  }
  const target = tunnel ? tunnelTarget(tunnel.id) : undefined;
  const wanted = (r: DnsRecord) =>
    r.type === 'CNAME' && r.proxied && target !== undefined && r.content === target;
  for (const r of obs.originRecords.filter((r) => !wanted(r))) {
    problems.push(
      `${names.origin} already has a ${r.proxied ? 'proxied' : 'DNS-only'} ${r.type} record to ${r.content}; it must be a proxied CNAME to ${target ?? 'the new tunnel'}. Remove or fix it in the dashboard`,
    );
  }
  if (problems.length > 0) return { ok: false, problems };

  const actions: TunnelAction[] = [];
  if (!tunnel) actions.push({ kind: 'create-tunnel' });
  if (!tunnel || !obs.ingress || !sameIngress(obs.ingress, desiredIngress(names))) {
    actions.push({ kind: 'set-tunnel-config' });
  }
  if (obs.originRecords.length === 0) actions.push({ kind: 'create-origin-record' });
  return { ok: true, actions, ...(tunnel ? { tunnelId: tunnel.id } : {}) };
}
