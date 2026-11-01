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
 * All three are the Terraform config's (`infra/cloudflare/modules/tunnel`),
 * made by `bun run cf:apply` (or CI on main) for every project in
 * `router.local.json` whose origin is `<project>-origin.<zone>`.
 * `machine:deploy` reads them from `terraform output` and asks Cloudflare
 * nothing.
 */
import type { TfOutputs } from '../cloudflare/outputs.ts';
import type { ProjectConfig } from './deploy-plan.ts';

export const TUNNEL_TOKEN_SECRET = 'CLOUDFLARE_TUNNEL_TOKEN';

export interface AppliedTunnel {
  id: string;
  name: string;
  origin: string;
  publicHost: string;
  /** The tunnel's token: held in memory, never printed. */
  token: () => string;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The project's tunnel from the Terraform outputs, checked against the name
 * and origin this deploy expects. Throws, saying what to run, when the state
 * has none, a different one, or no token for it.
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
  return {
    id: t.id,
    name: t.name,
    origin: t.origin,
    publicHost: t.public_host,
    token: () => parseTunnelToken(outputs.tunnelTokens[cfg.project]),
  };
}

/** A tunnel token is one long word; the error never quotes what it got. */
export function parseTunnelToken(value: unknown): string {
  if (typeof value !== 'string' || value.length < 20 || /\s/.test(value)) {
    throw new Error('the Terraform output has no token for the tunnel; run bun run cf:apply');
  }
  return value;
}
