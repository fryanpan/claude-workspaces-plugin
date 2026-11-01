/**
 * The named tunnel's names and readers, with no I/O. Tested in
 * `packages/server/test/project-machine-tunnel.test.ts`.
 *
 * Three things in Cloudflare make a project's named tunnel (board router
 * README, "Each project's side"):
 *
 *   the tunnel `cw-<project>`, whose one ingress rule sends the project's own
 *     hostname `<project>-<first label of the one address>.<zone>` to the
 *     server on `http://localhost:8787`, and everything else to a 404
 *   the origin hostname `<project>-origin.<zone>`: a proxied CNAME to the
 *     tunnel, which the router Worker resolves the project's hostname to
 *   the tunnel's token, which the machine holds as CLOUDFLARE_TUNNEL_TOKEN
 *
 * The first two are the OpenTofu config's (`infra/cloudflare/tunnels.tf`),
 * made by `bun run cf:apply` for every project in `router.local.json` whose
 * origin is `<project>-origin.<zone>`. `machine:deploy` reads the tunnel's id
 * from that state and its token from Cloudflare.
 */
import { projectHost } from '../board-router-worker/worker.js';
import type { ProjectConfig } from './deploy-plan.ts';

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

/** What `cf:apply` recorded for one project's tunnel. */
export interface AppliedTunnel {
  id: string;
  accountId: string;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT = /^[0-9a-f]{32}$/;

/**
 * The project's tunnel from `tofu output -json tunnels`, checked against the
 * names this deploy expects. Throws, saying what to run, when the state has
 * none or a different one.
 */
export function appliedTunnel(output: unknown, project: string, names: TunnelNames): AppliedTunnel {
  const t = (output as Record<string, Record<string, unknown> | undefined> | null)?.[project];
  if (!t) {
    throw new Error(
      `the OpenTofu state has no tunnel for ${project}: add "${project}": "${names.origin}" to router.local.json's projects and run bun run cf:apply`,
    );
  }
  if (t.name !== names.tunnel || t.origin !== names.origin || t.public_host !== names.publicHost) {
    throw new Error(
      `the OpenTofu state's tunnel for ${project} is not ${names.tunnel} at ${names.origin}; run bun run cf:plan and read what differs`,
    );
  }
  const id = typeof t.id === 'string' ? t.id : '';
  const accountId = typeof t.account_id === 'string' ? t.account_id : '';
  if (!ID.test(id) || !ACCOUNT.test(accountId)) {
    throw new Error(
      `the OpenTofu state's tunnel for ${project} has no id yet; run bun run cf:apply`,
    );
  }
  return { id, accountId };
}

/** `GET cfd_tunnel/<id>/token` answers with the token as a bare string. */
export function parseTunnelToken(result: unknown): string {
  if (typeof result !== 'string' || result.length < 20 || /\s/.test(result)) {
    throw new Error('Cloudflare answered the tunnel token request without a token');
  }
  return result;
}
