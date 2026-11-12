/**
 * Rotating one existing Access service token's secret, with the keeper's
 * Cloudflare token: `service-token-rotate`, always a passkey tap.
 *
 * For a token whose secret nobody holds any more. Rotating keeps the token's
 * id, so Terraform, which imported it by id, sees no change; deleting and
 * making it again would change the id, and the token carries
 * `prevent_destroy`. The old secret keeps working for 24 hours
 * (`previous_client_secret_expires_at`), so whatever still uses it has a day
 * to take the new one.
 *
 * The new secret goes back to the requester only, exactly as a new token's
 * does from `cf-sync` (`keeper-cf-sync.ts`): the requester puts it in Bryan's
 * Keychain under the token's services (`infra/cloudflare/rotate-token.ts`).
 * The approval page names the token and never shows a secret, and the
 * approval page's own answer does not carry the result
 * (`resultIsSecret` in `keeper-ci-calls.ts`).
 */
import type { Verdict } from './keeper-policy.ts';

export interface RotateCall {
  type: 'service-token-rotate';
  /** The token's name in Cloudflare. */
  name: string;
}

/** How long the old secret keeps working after a rotation. */
export const PREVIOUS_SECRET_MS = 24 * 60 * 60_000;
/** A service token's name as the access config writes it: words, dots, dashes. */
const TOKEN_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/;
const ID = /^[A-Za-z0-9-]{1,64}$/;

export function classifyRotate(name: unknown): Verdict {
  if (typeof name !== 'string' || !TOKEN_NAME.test(name)) {
    return { kind: 'refused', reason: 'name must be a service token name' };
  }
  return {
    kind: 'held',
    hold: 'service-token.rotate',
    app: null,
    summary: `rotate the secret of Access service token "${name}"`,
  };
}

type Cf = (
  method: string,
  path: string,
  body: string | undefined,
) => Promise<{ status: number; body: string }>;

function result<T>(r: { status: number; body: string }): T | null {
  try {
    const j = JSON.parse(r.body) as { success?: boolean; result?: T };
    return r.status >= 200 && r.status < 300 && j.success !== false ? (j.result ?? null) : null;
  } catch {
    return null;
  }
}

const fail = (status: number, error: string) => ({ status, body: JSON.stringify({ error }) });

/**
 * Find the one token named `name` in the one account, and rotate it. The
 * answer carries the new client secret, for the requester alone.
 */
export async function rotateServiceToken(
  cf: Cf,
  name: string,
  now: number = Date.now(),
): Promise<{ status: number; body: string }> {
  const accounts = result<{ id?: unknown }[]>(await cf('GET', '/accounts', undefined)) ?? [];
  const account = accounts.length === 1 ? accounts[0]?.id : undefined;
  if (typeof account !== 'string' || !ID.test(account)) {
    return fail(502, `the keeper's token sees ${accounts.length} accounts; it must see one`);
  }
  const list =
    result<{ id?: unknown; name?: unknown }[]>(
      await cf('GET', `/accounts/${account}/access/service_tokens?per_page=1000`, undefined),
    ) ?? [];
  const found = list.filter((t) => t.name === name);
  if (found.length !== 1) {
    return fail(
      404,
      `the account has ${found.length} service tokens named "${name}"; rotate needs exactly one`,
    );
  }
  const id = found[0]?.id;
  if (typeof id !== 'string' || !ID.test(id))
    return fail(502, 'Cloudflare gave no usable token id');
  const expires = new Date(now + PREVIOUS_SECRET_MS).toISOString();
  const rotated = result<{ client_id?: unknown; client_secret?: unknown }>(
    await cf(
      'POST',
      `/accounts/${account}/access/service_tokens/${id}/rotate`,
      JSON.stringify({ previous_client_secret_expires_at: expires }),
    ),
  );
  if (typeof rotated?.client_id !== 'string' || typeof rotated.client_secret !== 'string') {
    return fail(
      502,
      `Cloudflare's answer to rotating "${name}" held no new secret; the old one works until ${expires} if the rotation went through`,
    );
  }
  return {
    status: 200,
    body: JSON.stringify({
      name,
      id,
      clientId: rotated.client_id,
      secret: rotated.client_secret,
      previousSecretExpiresAt: expires,
    }),
  };
}
