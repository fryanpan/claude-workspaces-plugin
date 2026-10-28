/**
 * The app voice socket's token: proof that the server served doc D on board
 * W to its owner a few minutes ago.
 *
 * The page asking for the socket is a mock or an app, which runs in a frame
 * with an opaque origin, so its `Origin` is `null` — the same `null` every
 * sandboxed page anywhere sends. Origin cannot say which page is asking. So
 * the server writes this token into the frame's own HTML when it serves the
 * frame to the owner (`seed.ts`), and the socket opens only with it.
 *
 * `av1.<ws>.<doc>.<exp>`, each id base64url so a dot in one cannot move a
 * field, signed through `auth/signed-token.ts` under its own key domain. A
 * token for another doc or board names that doc or board, and the socket
 * compares both with its own path. It expires ten minutes after it is made;
 * an open socket is sent a fresh one every four (`session.ts`), so a page
 * that reconnects after a drop still holds a live one.
 *
 * None of the three existing schemes fits. The share link-session cookie and
 * the auth session cookie are cookies: the frame's script must hold this
 * value, and must never hold those. The widget token names a person
 * for a widget origin and no doc, so a mock holding one could open another
 * doc's socket.
 */
import { type TokenFormat, mintToken, tokenKey, verifyToken } from '../auth/signed-token.ts';

const VERSION = 'av1';

/** How long a token opens the socket. */
export const APP_VOICE_TOKEN_TTL_MS = 10 * 60_000;
/** How often an open socket is sent a fresh token. */
export const APP_VOICE_TOKEN_REFRESH_MS = 4 * 60_000;

export interface AppVoiceClaims {
  workspaceId: string;
  docId: string;
  /** ms epoch, whole seconds. */
  expiresAt: number;
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const B64 = /^[A-Za-z0-9_-]{1,512}$/;
const unb64 = (s: string): string | null =>
  B64.test(s) ? Buffer.from(s, 'base64url').toString('utf8') : null;

export const appVoiceToken: TokenFormat<AppVoiceClaims> = {
  keyDomain: 'cw-app-voice-token-v1',
  tags: [VERSION],
  encode: (c) =>
    `${VERSION}.${b64(c.workspaceId)}.${b64(c.docId)}.${Math.floor(c.expiresAt / 1000).toString(36)}`,
  decode(payload) {
    const [version, ws, doc, exp, ...rest] = payload.split('.');
    if (version !== VERSION || rest.length > 0 || !ws || !doc || !exp) return null;
    const workspaceId = unb64(ws);
    const docId = unb64(doc);
    if (!/^[0-9a-z]{1,12}$/.test(exp) || workspaceId === null || docId === null) return null;
    return { workspaceId, docId, expiresAt: Number.parseInt(exp, 36) * 1000 };
  },
  expiresAt: (c) => c.expiresAt,
};

export function appVoiceTokenKey(cookieKey: string): string {
  return tokenKey(cookieKey, appVoiceToken);
}

export function mintAppVoiceToken(
  key: string,
  workspaceId: string,
  docId: string,
  now: number = Date.now(),
): { token: string; expiresAt: number } {
  const expiresAt = Math.floor((now + APP_VOICE_TOKEN_TTL_MS) / 1000) * 1000;
  return { token: mintToken(appVoiceToken, { workspaceId, docId, expiresAt }, key), expiresAt };
}

/**
 * Whether `value` opens the socket of doc `docId` on board `workspaceId`.
 * The reason is for the log and the tests; the socket refuses every failure
 * the same way.
 */
export function checkAppVoiceToken(
  key: string,
  value: string | null,
  workspaceId: string,
  docId: string,
  now: number = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  const v = verifyToken(appVoiceToken, value, key, now);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (v.claims.workspaceId !== workspaceId || v.claims.docId !== docId) {
    return { ok: false, reason: 'other_doc' };
  }
  return { ok: true };
}
