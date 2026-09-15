/**
 * The widget's popup-handshake token — how a dev-server embed borrows the
 * identity a browser already proved to the workspace origin.
 *
 * The widget runs on another origin and can never carry `cw_session` (the
 * cookie is HttpOnly and SameSite=Lax, and CORS here never grants
 * credentials — see middleware/browser-origin.ts). Instead the widget opens a
 * popup ON the workspace origin, where the cookie flows; the popup exchanges
 * that session for one of these tokens and hands it back over postMessage.
 *
 * Deliberately NOT a copy of the cookie, and narrower than it in three ways:
 *
 * 1. **It names the session, it isn't one.** The token carries the session
 *    id and issue time of the cookie it was minted from, and every use is
 *    checked against the live session — the revocation denylist and the
 *    roster's `sessionsValidFrom` watermark — so logging out of the
 *    workspace kills every token that session ever minted, instantly.
 * 2. **It expires on its own** (`WIDGET_TOKEN_TTL_MS`), unlike the session.
 *    The liveness check above is the load-bearing revocation; the expiry
 *    bounds how long a leaked token is worth anything when nobody knows to
 *    revoke it. Re-minting is one tap (the popup completes silently while
 *    the workspace session lives).
 * 3. **It only attributes.** The request path feeds it to `authorFor` and
 *    the widget-session probe, nothing else: it never sets a cookie, never
 *    satisfies a share gate, and never makes `/api/auth/session` answer
 *    "signed in".
 * 4. **It is bound to one page origin.** The mint route validates the
 *    recipient origin and signs it into the token; the request gate then
 *    accepts the token only from a request whose `Origin` header names
 *    that origin. Every use the widget makes is a cross-origin fetch, so
 *    the browser stamps that header and nothing on the page can forge it —
 *    while a token lifted out of the dev server's localStorage is worth
 *    nothing from curl, from another origin, or from an opaque one.
 *
 * A second shape, `wt2`, is the same format under its own version tag: a
 * token for the TAILNET WIDGET DOOR (middleware/widget-door.ts). A page on the
 * tailnet hostname cannot carry any cookie to the public Access host, so no
 * session exists to borrow; the popup there proves the person through
 * Cloudflare Access instead. With no session to die with, the `wt2` token is
 * narrower in the other direction: ONE board, ONE page origin, a day's life,
 * and dead the moment the identity's `sessionsValidFrom` watermark moves.
 *
 * Same construction as session.ts and the share cookie, which is now one
 * module (`signed-token.ts`): HMAC over a dotted payload, key derived from
 * the shared cookie key under its own domain string so no format can ever
 * verify as another.
 */
import type { SessionClaims } from './session.ts';
import { type TokenFormat, mintToken, tokenClaims, tokenKey } from './signed-token.ts';

/** Seven days. Short-lived relative to the session (which never expires) —
 *  the per-use liveness check is what actually ends a token early. */
export const WIDGET_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const VERSION = 'wt1';

export interface WidgetTokenClaims {
  identityId: string;
  /** The session this token borrows — revoking it (logout) kills the token. */
  sessionId: string;
  /** The session's own issue time, so the roster watermark applies. */
  sessionIssuedAt: number;
  /** ms epoch. Unlike the session, the token always expires. */
  expiresAt: number;
  /** The one page origin this token may be presented from. */
  origin: string;
}

/**
 * `wt1.<identityId>.<sessionId>.<sessionIssuedAt>.<expiresAt>.<origin>` —
 * the origin base64url-encoded because an origin is full of dots and the
 * payload is dot-split.
 *
 * Unlike the session cookie this always expires, so `expiresAt` always
 * answers a number and the shared verifier enforces the TTL.
 */
export const widgetToken: TokenFormat<WidgetTokenClaims> = {
  keyDomain: 'cw-widget-token-v1',
  tags: [VERSION],
  encode: (claims) =>
    [
      VERSION,
      claims.identityId,
      claims.sessionId,
      claims.sessionIssuedAt,
      claims.expiresAt,
      Buffer.from(claims.origin).toString('base64url'),
    ].join('.'),
  decode(payload) {
    const parts = payload.split('.');
    if (parts.length !== 6) return null;
    const [version, identityId, sessionId, issuedRaw, expiresRaw, originRaw] = parts;
    if (version !== VERSION || !identityId || !sessionId || !originRaw) return null;
    const sessionIssuedAt = Number(issuedRaw);
    const expiresAt = Number(expiresRaw);
    if (!Number.isSafeInteger(sessionIssuedAt) || !Number.isSafeInteger(expiresAt)) return null;
    const origin = Buffer.from(originRaw, 'base64url').toString();
    if (!origin) return null;
    return { identityId, sessionId, sessionIssuedAt, expiresAt, origin };
  },
  expiresAt: (claims) => claims.expiresAt,
};

/** One day. A `wt2` token has no session whose logout could end it, so its
 *  own expiry does more of the work than the `wt1` week does. */
export const BOARD_WIDGET_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const BOARD_VERSION = 'wt2';

export interface BoardWidgetTokenClaims {
  identityId: string;
  /** ms epoch the token was minted — what the roster watermark is held to. */
  issuedAt: number;
  /** ms epoch. */
  expiresAt: number;
  /** The one board whose widget docs this token may reach. */
  workspaceId: string;
  /** The one page origin this token may be presented from. */
  origin: string;
}

/**
 * `wt2.<identityId>.<issuedAt>.<expiresAt>.<workspaceId>.<origin>` — the
 * workspace id and the origin base64url-encoded, so no id shape can ever add
 * a dot to a dot-split payload.
 *
 * Its own `TokenFormat` rather than a union inside `widgetToken`, and under
 * the SAME key domain: one scheme, two version tags. The tag check in
 * `verifyToken` is what keeps them apart, so a `wt1` value can never verify
 * as a board token or the other way round.
 */
export const boardWidgetToken: TokenFormat<BoardWidgetTokenClaims> = {
  keyDomain: widgetToken.keyDomain,
  tags: [BOARD_VERSION],
  encode: (claims) =>
    [
      BOARD_VERSION,
      claims.identityId,
      claims.issuedAt,
      claims.expiresAt,
      Buffer.from(claims.workspaceId).toString('base64url'),
      Buffer.from(claims.origin).toString('base64url'),
    ].join('.'),
  decode(payload) {
    const parts = payload.split('.');
    if (parts.length !== 6) return null;
    const [version, identityId, issuedRaw, expiresRaw, workspaceRaw, originRaw] = parts;
    if (version !== BOARD_VERSION || !identityId || !workspaceRaw || !originRaw) return null;
    const issuedAt = Number(issuedRaw);
    const expiresAt = Number(expiresRaw);
    if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) return null;
    const workspaceId = Buffer.from(workspaceRaw, 'base64url').toString();
    const origin = Buffer.from(originRaw, 'base64url').toString();
    if (!workspaceId || !origin) return null;
    return { identityId, issuedAt, expiresAt, workspaceId, origin };
  },
  expiresAt: (claims) => claims.expiresAt,
};

/** A board token for one identity, one board and one page origin. */
export function mintBoardWidgetToken(
  grant: { identityId: string; workspaceId: string; origin: string },
  key: string,
  now: number = Date.now(),
): string {
  return mintToken(
    boardWidgetToken,
    { ...grant, issuedAt: now, expiresAt: now + BOARD_WIDGET_TOKEN_TTL_MS },
    key,
  );
}

/** The claims a board token attests to, or null. Pure crypto + expiry — the
 *  caller still owes the roster checks, as with `verifyWidgetToken`. */
export function verifyBoardWidgetToken(
  value: string | undefined | null,
  key: string,
  now: number = Date.now(),
): BoardWidgetTokenClaims | null {
  return tokenClaims(boardWidgetToken, value, key, now);
}

/** The widget-token key, derived from the shared cookie key. */
export function widgetTokenKey(cookieKey: string): string {
  return tokenKey(cookieKey, widgetToken);
}

/**
 * A token for the session a request proved, or null for a surviving
 * v1-format session — those carry no session id, so a token tied to one
 * could not die with a logout. (The daily sliding refresh upgrades them;
 * the popup answers "sign in again" until then.)
 */
export function mintWidgetToken(
  session: SessionClaims,
  origin: string,
  key: string,
  now: number = Date.now(),
): string | null {
  if (session.sessionId === null) return null;
  return mintToken(
    widgetToken,
    {
      identityId: session.identityId,
      sessionId: session.sessionId,
      sessionIssuedAt: session.issuedAt,
      expiresAt: now + WIDGET_TOKEN_TTL_MS,
      origin,
    },
    key,
  );
}

/**
 * The claims a token attests to, or null. Pure crypto + expiry — the caller
 * still owes the liveness checks (`SessionRevocations`, roster status, the
 * `sessionsValidFrom` watermark), exactly as with `verifySession`.
 */
export function verifyWidgetToken(
  value: string | undefined | null,
  key: string,
  now: number = Date.now(),
): WidgetTokenClaims | null {
  return tokenClaims(widgetToken, value, key, now);
}
