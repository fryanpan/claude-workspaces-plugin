/**
 * The named tunnel as `machine:deploy` reads it, with no I/O. Tested in
 * `packages/server/test/project-machine-tunnel.test.ts`.
 *
 * Three things in Cloudflare make a project's named tunnel (board router
 * README, "Each project's side"):
 *
 *   the tunnel `cw-<project>`, whose one ingress rule sends the project's own
 *     hostname to the server on `http://localhost:8787`, and everything else
 *     to a 404
 *   the origin hostname `<project>-origin.<zone>`: a proxied CNAME to the
 *     tunnel, which the router Worker resolves the project's hostname to
 *   the tunnel's token, which the machine holds as CLOUDFLARE_TUNNEL_TOKEN
 *
 * The first two are the Terraform config's (`infra/cloudflare/modules/tunnel`),
 * made by `bun run cf:apply` (or CI on main) for every project in
 * `router.local.json` whose origin is `<project>-origin.<zone>`.
 * `machine:deploy` reads the tunnel from `terraform output`, then the token
 * from Cloudflare's API with that id (`readTunnelToken`). The token is kept
 * out of the state, so the read-only state key a pull request's plan holds
 * cannot unlock it.
 */
import type { TfOutputs } from '../cloudflare/outputs.ts';
import type { CloudflareApi } from './cloudflare.ts';
import type { ProjectConfig } from './deploy-plan.ts';

export const TUNNEL_TOKEN_SECRET = 'CLOUDFLARE_TUNNEL_TOKEN';

export interface AppliedTunnel {
  accountId: string;
  id: string;
  name: string;
  origin: string;
  publicHost: string;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The project's tunnel from the Terraform outputs, checked against the name
 * and origin this deploy expects. Throws, saying what to run, when the state
 * has none or a different one.
 */
export function appliedTunnel(outputs: TfOutputs, cfg: ProjectConfig): AppliedTunnel {
  const t = outputs.tunnels[cfg.project];
  const origin = `${cfg.project}-origin.`;
  if (!t) {
    throw new Error(
      `the Terraform state has no tunnel for ${cfg.project}: give it the origin ${origin}<zone> in router.local.json's projects and run bun run cf:apply`,
    );
  }
  if (t.name !== cfg.app || !t.origin.startsWith(origin)) {
    throw new Error(
      `the Terraform state's tunnel for ${cfg.project} is not ${cfg.app} at ${origin}<zone>; run bun run cf:plan and read what differs`,
    );
  }
  if (!ID.test(t.id)) {
    throw new Error(
      `the Terraform state's tunnel for ${cfg.project} has no id yet; run bun run cf:apply`,
    );
  }
  if (!/^[0-9a-f]{32}$/.test(t.account_id)) {
    throw new Error(`the Terraform state's tunnel for ${cfg.project} names no account`);
  }
  return {
    accountId: t.account_id,
    id: t.id,
    name: t.name,
    origin: t.origin,
    publicHost: t.public_host,
  };
}

/** The tunnel's token, from the API into memory. Never printed. */
export async function readTunnelToken(api: CloudflareApi, t: AppliedTunnel): Promise<string> {
  return parseTunnelToken(await api('GET', `/accounts/${t.accountId}/cfd_tunnel/${t.id}/token`));
}

/** A tunnel token is one long word; the error never quotes what it got. */
export function parseTunnelToken(value: unknown): string {
  if (typeof value !== 'string' || value.length < 20 || /\s/.test(value)) {
    throw new Error('Cloudflare answered the tunnel token request without a token');
  }
  return value;
}
