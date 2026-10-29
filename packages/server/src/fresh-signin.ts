/**
 * ── A fresh sign-in before a destructive action ──
 *
 * A person's destructive or access-widening request is refused unless that
 * person signed in within the last ten minutes, so a session token copied to
 * another machine cannot delete or reshare the owner's work. The refusal is
 * `403 {error: "confirm-required", window: 600}` and nothing changes; the
 * page holds the action, sends the person to sign in again, and offers it
 * once more when they come back (`workspaces-app/src/fresh-signin-client.ts`).
 *
 * WHO IS ASKED. Only a request carrying a PERSON PROOF: a Cloudflare Access
 * email, or the board's own session cookie. Agents reach these routes over
 * loopback with no person proof, or with a board agent token, and are never
 * asked — a browser check cannot contain them, and their archives are soft
 * and attributed (docs/architecture/security.md).
 *
 * WHAT "FRESH" IS MEASURED FROM. For Access, the verified token's `iat`
 * (`middleware/cf-access.ts`): a copied token keeps its old `iat` and cannot
 * be re-minted off the machine that holds the identity provider's session.
 * For the session cookie, its `signedInAt`, set at login and carried
 * unchanged by the daily refresh (`auth/session.ts`). A cookie minted before
 * that field existed has none and is never fresh, so it gets the same
 * "sign in again" flow.
 *
 * WHICH ACTIONS COUNT. `countedActionOf` is the whole list. Hard deletes
 * (doc, attachment set, workspace, any purge); archiving or retiring a
 * workspace, archiving a doc or an attachment set; and every widening of
 * access — a new share or share link, someone added to a board's audience, an
 * access card approved, sharing switched on, a role raised, a link
 * lengthened, a board unlocked. Task and goal archives, every unarchive,
 * and every narrowing of access stay instant. Where the body decides which
 * way a call goes, only the explicitly narrowing value is exempt, so a body
 * the handler would refuse anyway is counted rather than waved through.
 *
 * Stage 2 (a passkey check minting its own confirmation cookie) is not here.
 */
import { countedRouteOf, trimTrailingSlashes } from '@claude-workspaces/core/counted-routes';
import type { IdentityRecord } from './identities.ts';
import { normalizeBoardRole } from './share/board-role.ts';
import type { Shares } from './share/shares.ts';
import { resolveTtl } from './share/ttl.ts';

/** How long a sign-in stays fresh, in seconds. */
export const FRESH_SIGNIN_WINDOW_SECONDS = 600;

/** The refusal's `error`, which the page turns into "Confirm it's you". */
export const CONFIRM_REQUIRED = 'confirm-required';

/** Clock skew tolerated on a sign-in time that is ahead of ours. */
const FUTURE_SKEW_MS = 60_000;

/** What a person proof says about when its holder signed in. */
export interface PersonProof {
  /** ms epoch, or null when the proof carries no sign-in time. */
  signedInAtMs: number | null;
}

/** Whether a sign-in at `signedInAtMs` is inside the window at `now`. */
export function isFreshSignIn(signedInAtMs: number | null, now: number): boolean {
  if (signedInAtMs === null || !Number.isFinite(signedInAtMs)) return false;
  if (signedInAtMs > now + FUTURE_SKEW_MS) return false;
  return now - signedInAtMs <= FRESH_SIGNIN_WINDOW_SECONDS * 1000;
}

/**
 * The person proof on a request, or null when it carries none or is an
 * agent's. Ranked as `provenIdentityFor` ranks them: Access first.
 */
export function personProofOf(
  admitted: { accessEmail: string | null; accessIssuedAt: number | null; boardAgent: unknown },
  sessionIdentity: IdentityRecord | null,
  sessionSignedInAt: number | null,
  widgetIdentity: IdentityRecord | null = null,
): PersonProof | null {
  if (admitted.boardAgent) return null;
  if (admitted.accessEmail) {
    const iat = admitted.accessIssuedAt;
    return { signedInAtMs: iat === null ? null : iat * 1000 };
  }
  if (sessionIdentity) return { signedInAtMs: sessionSignedInAt };
  // A widget popup token names a person but carries no sign-in time, so it
  // is never fresh: a copied one cannot delete or widen anything.
  if (widgetIdentity) return { signedInAtMs: null };
  return null;
}

export interface CountedActionContext {
  /** The retired per-share registry, for whether a TTL change lengthens. */
  shares: Shares | null;
  now: number;
}

/** The body as JSON, read off a clone so the route still gets its own. */
async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await req.clone().json();
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The counted action this request is, or null for one that stays instant.
 * The method and path come off the shared list (`@claude-workspaces/core`'s
 * `counted-routes.ts`, which the page reads too); the body decides the rest.
 */
export async function countedActionOf(
  req: Request,
  pathname: string,
  ctx: CountedActionContext,
): Promise<string | null> {
  const route = countedRouteOf(req.method, pathname);
  switch (route) {
    case null:
      return null;
    case 'retire-workspace':
      return (await bodyOf(req))?.retired === false ? null : route;
    case 'raise-role':
      return normalizeBoardRole((await bodyOf(req))?.role) === 'member' ? null : route;
    case 'add-member': {
      const body = await bodyOf(req);
      const removeOnly = body !== null && (body.add === undefined || isEmptyArray(body.add));
      return removeOnly ? null : route;
    }
    case 'approve-access':
      return (await bodyOf(req))?.decision === 'reject' ? null : route;
    case 'sharing-on':
      return (await bodyOf(req))?.enabled === false ? null : route;
    case 'unlock-board':
      return (await bodyOf(req))?.locked === true ? null : route;
    case 'lengthen-share': {
      const shareId = trimTrailingSlashes(pathname).split('/')[3] ?? '';
      return (await lengthensShare(req, shareId, ctx)) ? route : null;
    }
    default:
      return route;
  }
}

const isEmptyArray = (v: unknown): boolean => Array.isArray(v) && v.length === 0;

/**
 * Whether a TTL change moves a live share's expiry later. Resolved with the
 * route's own resolver and ceiling, so the two cannot disagree about the
 * seconds; a request the route will refuse (no share, a bad TTL) changes
 * nothing and is not counted.
 */
async function lengthensShare(
  req: Request,
  rawShareId: string,
  { shares, now }: CountedActionContext,
): Promise<boolean> {
  if (!shares) return false;
  let shareId: string;
  try {
    shareId = decodeURIComponent(rawShareId);
  } catch {
    return false;
  }
  const live = shares.findLive(shareId, now);
  if (!live) return false;
  const body = await bodyOf(req);
  const resolved = resolveTtl({
    ttl: body?.ttl,
    ttlSeconds: body?.ttlSeconds,
    defaultSeconds: shares.defaultLinkTtlSeconds,
    maxSeconds: shares.maxTtlSeconds,
  });
  if (!resolved.ok) return false;
  return now + resolved.seconds * 1000 > live.expiresAt;
}

/**
 * The refusal for a counted action whose person proof is stale, or null.
 * Null for every request without a person proof, every action that stays
 * instant, and a sign-in inside the window.
 */
export async function refuseStaleSignIn(
  req: Request,
  pathname: string,
  proof: PersonProof | null,
  ctx: CountedActionContext,
): Promise<Response | null> {
  if (proof === null) return null;
  if (isFreshSignIn(proof.signedInAtMs, ctx.now)) return null;
  const action = await countedActionOf(req, pathname, ctx);
  if (action === null) return null;
  return new Response(
    JSON.stringify({ error: CONFIRM_REQUIRED, window: FRESH_SIGNIN_WINDOW_SECONDS, action }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  );
}
