/**
 * The Cloudflare half of `machine:deploy --tunnel named`: read what the
 * project's tunnel, origin record and Access applications look like, and do
 * what `planTunnel` decided. Every decision is in `tunnel-plan.ts`.
 *
 * The zone and the one address come from the board router's
 * `router.local.json` (gitignored), so the real hostnames stay out of the
 * repo. Cloudflare's answers can hold the tunnel's secret, so no answer is
 * printed: only ids and names are.
 */
import { readFileSync } from 'node:fs';
import { parseRouterConfig } from '../board-router-worker/deploy-plan.ts';
import { type CloudflareApi, cloudflareApi } from './cloudflare.ts';
import type { ProjectConfig } from './deploy-plan.ts';
import { cloudflareApiToken } from './mac-ops.ts';
import {
  type DnsRecord,
  type TunnelAction,
  type TunnelNames,
  type TunnelObserved,
  originRecord,
  parseAccessApps,
  parseIngress,
  parseTunnelToken,
  parseTunnels,
  planTunnel,
  tunnelConfigBody,
  tunnelCreateBody,
  tunnelNames,
} from './tunnel-plan.ts';

export function routerNames(cfg: ProjectConfig, routerConfigPath: string): TunnelNames {
  let raw: string;
  try {
    raw = readFileSync(routerConfigPath, 'utf8');
  } catch {
    throw new Error(
      `a named tunnel reads the zone and one address from ${routerConfigPath} (board router README, "Deploying"); pass --router-config <path>`,
    );
  }
  return tunnelNames(cfg, parseRouterConfig(raw));
}

export interface NamedTunnel {
  names: TunnelNames;
  actions: TunnelAction[];
  /** Do the planned actions; answers the tunnel's id. */
  apply(): Promise<string>;
  /** The tunnel's token, read from Cloudflare into memory only. */
  token(tunnelId: string): Promise<string>;
}

async function observe(
  api: CloudflareApi,
  account: string,
  zone: string,
  names: TunnelNames,
): Promise<TunnelObserved> {
  const tunnels = parseTunnels(
    await api(
      'GET',
      `/accounts/${account}/cfd_tunnel?name=${encodeURIComponent(names.tunnel)}&is_deleted=false`,
    ),
  ).filter((t) => t.name === names.tunnel);
  const only = tunnels.length === 1 ? tunnels[0] : undefined;
  const ingress = only
    ? parseIngress(await api('GET', `/accounts/${account}/cfd_tunnel/${only.id}/configurations`))
    : null;
  const originRecords = (
    await api<DnsRecord[]>(
      'GET',
      `/zones/${zone}/dns_records?name=${encodeURIComponent(names.origin)}`,
    )
  ).filter((r) => r.name === names.origin);
  const accessApps = parseAccessApps(await api.all(`/accounts/${account}/access/apps`));
  return { tunnels, ingress, originRecords, accessApps };
}

/**
 * Read Cloudflare and plan. Throws, having changed nothing, when the plan
 * finds something in the way.
 */
export async function prepareTunnel(
  cfg: ProjectConfig,
  routerConfigPath: string,
): Promise<NamedTunnel> {
  const names = routerNames(cfg, routerConfigPath);
  const api = cloudflareApi(cloudflareApiToken());
  const zones = await api<Array<{ id: string; account: { id: string } }>>(
    'GET',
    `/zones?name=${encodeURIComponent(names.zone)}`,
  );
  const zone = zones[0];
  if (!zone) throw new Error(`the token sees no zone named ${names.zone}`);
  const account = zone.account.id;
  const decided = planTunnel(names, await observe(api, account, zone.id, names));
  if (!decided.ok) {
    for (const p of decided.problems) console.error(`  - ${p}`);
    throw new Error('the named tunnel is not set up; nothing was changed');
  }
  const tunnelPath = (id: string) => `/accounts/${account}/cfd_tunnel/${id}`;
  return {
    names,
    actions: decided.actions,
    async apply() {
      let id = decided.tunnelId;
      for (const a of decided.actions) {
        console.log(`[deploy] ${a.kind}`);
        if (a.kind === 'create-tunnel') {
          const made = await api<{ id: string }>(
            'POST',
            `/accounts/${account}/cfd_tunnel`,
            tunnelCreateBody(names),
          );
          id = made.id;
          console.log(`[deploy] tunnel ${names.tunnel} is ${id}`);
          continue;
        }
        if (!id) throw new Error('no tunnel id after create-tunnel');
        if (a.kind === 'set-tunnel-config') {
          await api('PUT', `${tunnelPath(id)}/configurations`, tunnelConfigBody(names));
        } else {
          await api('POST', `/zones/${zone.id}/dns_records`, originRecord(names, id));
        }
      }
      if (!id) throw new Error(`tunnel ${names.tunnel} has no id`);
      return id;
    },
    async token(tunnelId) {
      return parseTunnelToken(await api('GET', `${tunnelPath(tunnelId)}/token`));
    },
  };
}
