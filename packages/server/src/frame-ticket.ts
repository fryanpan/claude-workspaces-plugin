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
 * opens nothing here. The ticket in the address lives two minutes.
 *
 * A fifth field, `v`, says the host page's reader may be handed an app voice
 * token (`app-voice/gate.ts`). The frame's own requests carry this cookie and
 * not the board's, so on a server where browsers sign in the frame proves
 * nobody; the host page's request did prove its reader, and this field is
 * how that verdict reaches the frame. Without it a ticket grants no voice,
 * and so does every ticket minted before the field existed.
 *
 * The cookie it is traded for is a second format, `fc1`, with the same
 * fields under a key domain of its own, scoped by its path to the board's own
 * paths. The two are not interchangeable: a cookie value sent as a ticket is
 * refused, and a ticket sent as a cookie is too. That is what bounds the
 * grant. Only a ticket can be redeemed, only the host page mints one, and the
 * cookie a redeem sets expires twelve hours after the ticket was minted, not
 * twelve hours after the redeem. So no chain of redeems keeps a frame open
 * past twelve hours from the host page's own serve. Before the split, one
 * `ft1` format served both, and a cookie value redeemed as a ticket for
 * another twelve hours, for as long as anybody kept redeeming it.
 *
 * None of the existing schemes fits. The session and share cookies are the
 * board's, and must never be sent to a page an attachment's script runs in.
 * The widget token names a person for a widget origin and no frame host. The
 * app voice token names one doc and is read by the frame's script; this one
 * names a frame hostname and is held where no script can read it (HttpOnly).
 */
import { type TokenFormat, mintToken, tokenKey, verifyToken } from './auth/signed-token.ts';

/** The tag of a ticket in a frame's address. */
const TICKET_TAG = 'ft1';
/** The tag of the cookie a ticket is traded for. */
const COOKIE_TAG = 'fc1';
/** The optional fifth field: the reader may be handed an app voice token. */
const VOICE_FIELD = 'v';

/** The query parameter the host page writes the ticket into. */
export const FRAME_TICKET_PARAM = 'cw-ft';
/** The cookie the frame hostname sets in exchange for a ticket. */
export const FRAME_COOKIE = 'cw_frame';
/** How long a ticket in a frame's address may be traded for the cookie. */
export const FRAME_TICKET_TTL_MS = 2 * 60_000;
/** How long the grant a ticket starts lasts, counted from the ticket's mint. */
export const FRAME_COOKIE_TTL_MS = 12 * 60 * 60_000;

export interface FrameTicketClaims {
  /** The frame hostname, lower-case, no port. */
  frameHost: string;
  workspaceId: string;
  /** ms epoch, whole seconds. */
  expiresAt: number;
  /** The host page's reader may be handed an app voice token. */
  appVoice: boolean;
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const B64 = /^[A-Za-z0-9_-]{1,512}$/;
const unb64 = (s: string): string | null =>
  B64.test(s) ? Buffer.from(s, 'base64url').toString('utf8') : null;

/** One format per use: the same fields, under its own tag and key domain. */
function frameFormat(tag: string, keyDomain: string): TokenFormat<FrameTicketClaims> {
  return {
    keyDomain,
    tags: [tag],
    encode: (c) =>
      `${tag}.${b64(c.frameHost)}.${b64(c.workspaceId)}.${Math.floor(c.expiresAt / 1000).toString(36)}${c.appVoice ? `.${VOICE_FIELD}` : ''}`,
    decode(payload) {
      const [version, host, ws, exp, voice, ...rest] = payload.split('.');
      if (version !== tag || rest.length > 0 || !host || !ws || !exp) return null;
      if (voice !== undefined && voice !== VOICE_FIELD) return null;
      const frameHost = unb64(host);
      const workspaceId = unb64(ws);
      if (!/^[0-9a-z]{1,12}$/.test(exp) || frameHost === null || workspaceId === null) return null;
      return {
        frameHost,
        workspaceId,
        expiresAt: Number.parseInt(exp, 36) * 1000,
        appVoice: voice === VOICE_FIELD,
      };
    },
    expiresAt: (c) => c.expiresAt,
  };
}

/** The ticket in a frame's address. */
export const frameTicket = frameFormat(TICKET_TAG, 'cw-frame-ticket-v1');
/** The cookie a ticket is traded for. */
export const frameCookie = frameFormat(COOKIE_TAG, 'cw-frame-cookie-v1');

/** The two signing keys, each derived from the server's cookie key. */
export interface FrameKeys {
  ticket: string;
  cookie: string;
}

export function frameKeys(cookieKey: string): FrameKeys {
  return { ticket: tokenKey(cookieKey, frameTicket), cookie: tokenKey(cookieKey, frameCookie) };
}

const whole = (ms: number): number => Math.floor(ms / 1000) * 1000;

/** A ticket for the host page to write into a frame's address. `appVoice`
 *  is the host page's own `mayMintAppVoice` verdict for its reader. */
export function mintFrameTicket(
  key: string,
  frameHost: string,
  workspaceId: string,
  now: number = Date.now(),
  appVoice = false,
): string {
  const expiresAt = whole(now + FRAME_TICKET_TTL_MS);
  return mintToken(frameTicket, { frameHost, workspaceId, expiresAt, appVoice }, key);
}

type FrameCheck =
  | { ok: true; expiresAt: number; appVoice: boolean }
  | { ok: false; reason: string };

function check(
  format: TokenFormat<FrameTicketClaims>,
  key: string,
  value: string | null | undefined,
  frameHost: string,
  workspaceId: string,
  now: number,
): FrameCheck {
  const v = verifyToken(format, value, key, now);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (v.claims.frameHost !== frameHost) return { ok: false, reason: 'other_frame_host' };
  if (v.claims.workspaceId !== workspaceId) return { ok: false, reason: 'other_board' };
  return { ok: true, expiresAt: v.claims.expiresAt, appVoice: v.claims.appVoice };
}

/**
 * Whether `value` is a ticket for board `workspaceId`'s frames on
 * `frameHost`. A cookie value is not one. The reason is for the tests; every
 * failure is refused the same way.
 */
export function checkFrameTicket(
  key: string,
  value: string | null | undefined,
  frameHost: string,
  workspaceId: string,
  now: number = Date.now(),
): FrameCheck {
  return check(frameTicket, key, value, frameHost, workspaceId, now);
}

/** Whether `value` is a cookie that opens board `workspaceId`'s frames on
 *  `frameHost`. A ticket is not one. */
export function checkFrameCookie(
  key: string,
  value: string | null | undefined,
  frameHost: string,
  workspaceId: string,
  now: number = Date.now(),
): FrameCheck {
  return check(frameCookie, key, value, frameHost, workspaceId, now);
}

/**
 * A ticket traded for the cookie: the cookie's value and how long it has
 * left. The cookie ends `FRAME_COOKIE_TTL_MS` after the ticket was minted,
 * whenever inside its two minutes the ticket is redeemed, and grants app
 * voice exactly when the ticket did.
 */
export function redeemFrameTicket(
  keys: FrameKeys,
  ticket: string | null | undefined,
  frameHost: string,
  workspaceId: string,
  now: number = Date.now(),
): { ok: true; cookie: string; maxAgeMs: number } | { ok: false; reason: string } {
  const t = checkFrameTicket(keys.ticket, ticket, frameHost, workspaceId, now);
  if (!t.ok) return t;
  const expiresAt = t.expiresAt - FRAME_TICKET_TTL_MS + FRAME_COOKIE_TTL_MS;
  return {
    ok: true,
    cookie: mintToken(
      frameCookie,
      { frameHost, workspaceId, expiresAt, appVoice: t.appVoice },
      keys.cookie,
    ),
    maxAgeMs: Math.max(0, expiresAt - now),
  };
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
export function frameCookieHeader(
  value: string,
  workspaceId: string,
  maxAgeMs: number = FRAME_COOKIE_TTL_MS,
): string {
  return (
    `${FRAME_COOKIE}=${value}; Path=${frameCookiePath(workspaceId)}; ` +
    `Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; Secure; SameSite=None; Partitioned`
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
