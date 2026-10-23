/**
 * The frame ticket: proof that this server served a board's host page to its
 * operator, carried by the frame on the frame hostname (`frame-host.ts`).
 *
 * ── Why the frame needs one ──
 *
 * The frame hostname is on a separate domain from the board, so in the
 * board's page it is a third-party frame. Safari sends no first-party cookie
 * to a third-party frame: measured in WebKit on 23 October 2026, a cookie the
 * frame's host set on a visit of its own (as Cloudflare Access sets its sign-in
 * cookie) reached neither the frame document nor its scripts, while the same
 * cookie on a subdomain of the board's domain reached both. Behind Access the
 * frame would get the sign-in page instead of the attachment. A PARTITIONED
 * cookie the frame's own response sets is kept for that board's page and sent
 * on the frame's later requests, in WebKit and Chromium alike.
 *
 * So the host page, served to the operator on the board, writes a ticket into
 * the frame's address. The frame hostname trades it for a partitioned cookie
 * and redirects to the address without it, and every request the frame makes
 * after that carries the cookie. The frame hostname needs no Access cookie,
 * so its Access application, where there is one, must let requests through to
 * this check (`docs/architecture/security.md`).
 *
 * ── What one grants ──
 *
 * `ft1.<frame host>.<board>.<exp>`, each field base64url, signed through
 * `auth/signed-token.ts` under its own key domain. It opens the reads the
 * frame gate allows for ONE board, on ONE frame hostname, until it expires:
 * a ticket minted for another project's frame hostname, or for another board,
 * opens nothing here. The ticket in the address lives two minutes; the cookie
 * twelve hours, scoped by its path to the board's own paths.
 *
 * None of the existing schemes fits. The session and share cookies are the
 * board's, and must never be sent to a page an attachment's script runs in.
 * The widget token names a person for a widget origin and no frame host. The
 * app voice token names one doc and is read by the frame's script; this one
 * names a frame hostname and is held where no script can read it (HttpOnly).
 */
import { type TokenFormat, mintToken, tokenKey, verifyToken } from './auth/signed-token.ts';

const VERSION = 'ft1';

/** The query parameter the host page writes the ticket into. */
export const FRAME_TICKET_PARAM = 'cw-ft';
/** The cookie the frame hostname sets in exchange for a ticket. */
export const FRAME_COOKIE = 'cw_frame';
/** How long a ticket in a frame's address may be traded for the cookie. */
export const FRAME_TICKET_TTL_MS = 2 * 60_000;
/** How long the cookie opens the board's frames. */
export const FRAME_COOKIE_TTL_MS = 12 * 60 * 60_000;

export interface FrameTicketClaims {
  /** The frame hostname, lower-case, no port. */
  frameHost: string;
  workspaceId: string;
  /** ms epoch, whole seconds. */
  expiresAt: number;
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const B64 = /^[A-Za-z0-9_-]{1,512}$/;
const unb64 = (s: string): string | null =>
  B64.test(s) ? Buffer.from(s, 'base64url').toString('utf8') : null;

export const frameTicket: TokenFormat<FrameTicketClaims> = {
  keyDomain: 'cw-frame-ticket-v1',
  tags: [VERSION],
  encode: (c) =>
    `${VERSION}.${b64(c.frameHost)}.${b64(c.workspaceId)}.${Math.floor(c.expiresAt / 1000).toString(36)}`,
  decode(payload) {
    const [version, host, ws, exp, ...rest] = payload.split('.');
    if (version !== VERSION || rest.length > 0 || !host || !ws || !exp) return null;
    const frameHost = unb64(host);
    const workspaceId = unb64(ws);
    if (!/^[0-9a-z]{1,12}$/.test(exp) || frameHost === null || workspaceId === null) return null;
    return { frameHost, workspaceId, expiresAt: Number.parseInt(exp, 36) * 1000 };
  },
  expiresAt: (c) => c.expiresAt,
};

export function frameTicketKey(cookieKey: string): string {
  return tokenKey(cookieKey, frameTicket);
}

export function mintFrameTicket(
  key: string,
  frameHost: string,
  workspaceId: string,
  ttlMs: number,
  now: number = Date.now(),
): string {
  const expiresAt = Math.floor((now + ttlMs) / 1000) * 1000;
  return mintToken(frameTicket, { frameHost, workspaceId, expiresAt }, key);
}

/**
 * Whether `value` opens board `workspaceId`'s frames on `frameHost`. The
 * reason is for the tests; every failure is refused the same way.
 */
export function checkFrameTicket(
  key: string,
  value: string | null | undefined,
  frameHost: string,
  workspaceId: string,
  now: number = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  const v = verifyToken(frameTicket, value, key, now);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (v.claims.frameHost !== frameHost) return { ok: false, reason: 'other_frame_host' };
  if (v.claims.workspaceId !== workspaceId) return { ok: false, reason: 'other_board' };
  return { ok: true };
}

/** The path the cookie is scoped to: the board's own paths, and no other's. */
export function frameCookiePath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/`;
}

/**
 * The cookie, partitioned so that a browser keeps it in a third-party frame,
 * HttpOnly so the attachment's script cannot read it, and with no Domain so
 * it is this frame hostname's alone.
 */
export function frameCookieHeader(value: string, workspaceId: string): string {
  return (
    `${FRAME_COOKIE}=${value}; Path=${frameCookiePath(workspaceId)}; ` +
    `Max-Age=${Math.floor(FRAME_COOKIE_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=None; Partitioned`
  );
}

/** Every `cw_frame` value a `Cookie` header carries. A page's script may have
 *  planted one beside the real one, so each is tried. */
export function frameCookiesOf(header: string | null): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === FRAME_COOKIE) out.push(part.slice(eq + 1).trim());
  }
  return out;
}
