/**
 * PERSON PROOF that the board's owner made this request, from the board's own
 * page — the grant door's test, shared by every write only the owner may make
 * (Bryan, 29 Oct: only he changes who is in).
 *
 * `requireOwner` alone is not this: it passes every loopback caller, and every
 * agent and MCP child on this machine is one. Proof is the Cloudflare Access
 * email or the signed session cookie (`provenIdentityFor`) naming the owner,
 * plus `Sec-Fetch-Site: same-origin` and an `Origin` equal to this server's
 * own, because the cross-origin write gate admits a dev server on any local
 * port and a session cookie is same-site with it.
 *
 * `routes/task-grants.ts` keeps its own inline copy of the same six lines; its
 * refusal messages are asserted by tests that predate this module.
 */
import { isOwnerActor } from '../actor-identity.ts';
import type { IdentityRecord } from '../identities.ts';

export type OwnerProof =
  | { ok: true; proven: IdentityRecord }
  | { ok: false; status: 403; error: 'owner-proof-required' | 'same-origin-only' };

export function ownerProof(
  req: Request,
  provenIdentityFor: (() => IdentityRecord | null) | undefined,
  requestOriginFor: (() => string) | undefined,
): OwnerProof {
  const proven = provenIdentityFor?.() ?? null;
  if (!proven || !isOwnerActor({ id: proven.id })) {
    return { ok: false, status: 403, error: 'owner-proof-required' };
  }
  const origin = req.headers.get('origin');
  const own = requestOriginFor?.();
  if (
    req.headers.get('sec-fetch-site') !== 'same-origin' ||
    origin === null ||
    own === undefined ||
    origin !== own
  ) {
    return { ok: false, status: 403, error: 'same-origin-only' };
  }
  return { ok: true, proven };
}

/** Did the owner make this request from the board's own page? */
export function hasOwnerProof(
  req: Request,
  provenIdentityFor: (() => IdentityRecord | null) | undefined,
  requestOriginFor: (() => string) | undefined,
): boolean {
  return ownerProof(req, provenIdentityFor, requestOriginFor).ok;
}
