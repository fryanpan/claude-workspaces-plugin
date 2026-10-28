/**
 * The widget's board token (`wt2`) — how a widget on an app page, on another
 * origin, borrows the identity a person proved to the workspace.
 *
 * The widget runs on another origin and can never carry `cw_session` (the
 * cookie is HttpOnly and SameSite=Lax, and CORS here never grants
 * credentials — see middleware/browser-origin.ts). Instead it opens a popup
 * ON the workspace origin, where the person is proven, and the popup hands a
 * token back over postMessage. A widget inside a served mock needs none: it
 * talks through the page holding its frame, on the reader's own session
 * (`widget/src/mock-bridge.ts`).
 *
 * The token is narrow in four ways:
 *
 * 1. **One board.** It names the board the widget is on. The widget door
 *    refuses every other board (middleware/widget-door.ts), and so does
 *    attribution on any other host (`request-attribution.ts`).
 * 2. **One page origin.** The mint validates the recipient origin and signs
 *    it in; a use is accepted only from a request whose `Origin` header names
 *    it. Every use the widget makes is a cross-origin fetch, so the browser
 *    stamps that header and nothing on the page can forge it.
 * 3. **One day** (`BOARD_WIDGET_TOKEN_TTL_MS`), and dead the moment the
 *    identity's `sessionsValidFrom` watermark moves or the identity stops
 *    being active.
 * 4. **It only attributes.** It never sets a cookie, never satisfies a share
 *    gate, and never makes `/api/auth/session` answer "signed in".
 *
 * Two proofs mint one. On the tailnet widget door the popup proves the person
 * through Cloudflare Access, and the holder must still be able to comment on
 * the board at every use. Everywhere else the popup exchanges the session
 * cookie, and the token carries that session's id, so logging out of the
 * workspace kills it at once.
 *
 * It replaced `wt1`, a seven-day token that named a session and no board
 * (finding A4, 22 Oct 2026). A `wt1` value still in a browser is refused, and
 * the widget offers sign-in again.
 */
import { type TokenFormat, mintToken, tokenClaims, tokenKey } from './signed-token.ts';

/** One day. A token Access minted has no session whose logout could end it,
 *  so its own expiry does most of the work. */
export const BOARD_WIDGET_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const BOARD_VERSION = 'wt2';
/** A session id as `mintSession` spells one. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

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
  /** The session the popup exchanged, whose logout ends this token, or null
   *  when Cloudflare Access proved the person instead. */
  sessionId: string | null;
}

/**
 * `wt2.<identityId>.<issuedAt>.<expiresAt>.<workspaceId>.<origin>[.<sessionId>]`
 * — the workspace id and the origin base64url-encoded, so no id shape can ever
 * add a dot to a dot-split payload. A session id is `[A-Za-z0-9_-]` and goes
 * in as it is.
 *
 * Its key domain is the one `wt1` used: the version tag is what keeps the two
 * apart, so no `wt1` value can verify as one of these.
 */
export const boardWidgetToken: TokenFormat<BoardWidgetTokenClaims> = {
  keyDomain: 'cw-widget-token-v1',
  tags: [BOARD_VERSION],
  encode: (claims) =>
    [
      BOARD_VERSION,
      claims.identityId,
      claims.issuedAt,
      claims.expiresAt,
      Buffer.from(claims.workspaceId).toString('base64url'),
      Buffer.from(claims.origin).toString('base64url'),
      ...(claims.sessionId === null ? [] : [claims.sessionId]),
    ].join('.'),
  decode(payload) {
    const parts = payload.split('.');
    if (parts.length !== 6 && parts.length !== 7) return null;
    const [version, identityId, issuedRaw, expiresRaw, workspaceRaw, originRaw, sessionRaw] = parts;
    if (version !== BOARD_VERSION || !identityId || !workspaceRaw || !originRaw) return null;
    if (sessionRaw !== undefined && !SESSION_ID.test(sessionRaw)) return null;
    const issuedAt = Number(issuedRaw);
    const expiresAt = Number(expiresRaw);
    if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) return null;
    const workspaceId = Buffer.from(workspaceRaw, 'base64url').toString();
    const origin = Buffer.from(originRaw, 'base64url').toString();
    if (!workspaceId || !origin) return null;
    return { identityId, issuedAt, expiresAt, workspaceId, origin, sessionId: sessionRaw ?? null };
  },
  expiresAt: (claims) => claims.expiresAt,
};

/** A board token for one identity, one board and one page origin, tied to
 *  the session that minted it when there is one. */
export function mintBoardWidgetToken(
  grant: { identityId: string; workspaceId: string; origin: string; sessionId?: string | null },
  key: string,
  now: number = Date.now(),
): string {
  return mintToken(
    boardWidgetToken,
    {
      identityId: grant.identityId,
      workspaceId: grant.workspaceId,
      origin: grant.origin,
      sessionId: grant.sessionId ?? null,
      issuedAt: now,
      expiresAt: now + BOARD_WIDGET_TOKEN_TTL_MS,
    },
    key,
  );
}

/** The claims a board token attests to, or null. Pure crypto + expiry — the
 *  caller still owes the roster checks (`boardWidgetGrantFor`). */
export function verifyBoardWidgetToken(
  value: string | undefined | null,
  key: string,
  now: number = Date.now(),
): BoardWidgetTokenClaims | null {
  return tokenClaims(boardWidgetToken, value, key, now);
}

/** The widget-token key, derived from the shared cookie key. */
export function widgetTokenKey(cookieKey: string): string {
  return tokenKey(cookieKey, boardWidgetToken);
}
