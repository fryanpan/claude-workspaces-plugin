/**
 * The Cloudflare half of `machine:deploy --tunnel named`, which reads and
 * writes nothing in Cloudflare's configuration: the tunnel and its origin
 * record are made by `bun run cf:apply` (`infra/cloudflare/tunnels.tf`). This
 * reads the tunnel's id from that OpenTofu state, and its token from
 * Cloudflare when the machine's secret is set.
 *
 * The zone and the one address come from the board router's
 * `router.local.json` (gitignored), so the real hostnames stay out of the
 * repo. The token is held in memory only and never printed.
 */
import { readFileSync } from 'node:fs';
import { parseRouterConfig } from '../board-router-worker/router-config.ts';
import { spawnTofu } from '../cloudflare/tofu.ts';
import type { ProjectConfig } from './deploy-plan.ts';
import { cloudflareClient } from './mac-ops.ts';
import { type TunnelNames, appliedTunnel, parseTunnelToken, tunnelNames } from './tunnel-plan.ts';

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
  id: string;
  /** The tunnel's token, read from Cloudflare into memory only. */
  token(): Promise<string>;
}

/** `tofu output -json tunnels`, from the local state. Needs no token. */
function tunnelsOutput(): unknown {
  const r = spawnTofu(['output', '-json', 'tunnels'], {}, true);
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/** The project's tunnel as `cf:apply` made it. Throws, saying what to run, when it has not. */
export function namedTunnel(
  cfg: ProjectConfig,
  routerConfigPath: string,
  readOutput: () => unknown = tunnelsOutput,
): NamedTunnel {
  const names = routerNames(cfg, routerConfigPath);
  const { id, accountId } = appliedTunnel(readOutput(), cfg.project, names);
  return {
    names,
    id,
    async token() {
      // The keeper refuses this read: its answer is a credential.
      if (process.env.CW_KEEPER_URL?.trim()) {
        throw new Error(
          "the keeper does not hand out a tunnel's token, so a named tunnel's token cannot be set through it yet (docs/process/keeper.md)",
        );
      }
      const api = cloudflareClient('machine:deploy (named tunnel)');
      return parseTunnelToken(await api('GET', `/accounts/${accountId}/cfd_tunnel/${id}/token`));
    },
  };
}
