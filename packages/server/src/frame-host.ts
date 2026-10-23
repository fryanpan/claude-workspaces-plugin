/**
 * The frame-only hostname: where the operator's own mocks and app doors run,
 * one hostname over from the board, so their scripts get an origin of their
 * own instead of the board's.
 *
 * ── Why a second hostname ──
 *
 * A served mock or app door runs in a sandboxed frame (`mockup-frame.ts`).
 * Today that frame has an OPAQUE origin: it cannot read the board's cookies
 * or storage, which is the point, but it also has no storage of its own and
 * its own subresource requests carry no cookie, so behind Cloudflare Access
 * an app door's own scripts and stylesheets come back a sign-in redirect.
 * Served from a frame-only subdomain of the same site instead, the frame gets
 * a real origin (`allow-same-origin` on that hostname only): its storage is
 * its own, the Access cookie for that hostname rides on its subresources, and
 * the board's cookies and storage are still another origin's. Nobody types
 * the hostname; only the board's host page points a frame at it.
 *
 * ── What the hostname answers ──
 *
 * Reads of the two frame families and nothing else (`frameGate`): a mock's
 * frame (`/workspaces/<ws>/mockups/<id>?cw-frame=1`) and an app door's paths
 * (`/workspaces/<ws>/apps/<id>/…`). The paths are the board's own, so an app
 * built under its prefix loads its files unchanged. Fetch metadata narrows it
 * further, because every attachment shares this one origin and one
 * attachment's script must not read another's pages:
 *
 *   - a frame document only as a frame (`Sec-Fetch-Dest: iframe`), and the
 *     frame response's `frame-ancestors` names only the board, so a frame
 *     origin page cannot frame another attachment and read it;
 *   - an app's files only as subresources (script, style, image, font,
 *     media). A script's `fetch` or XHR (`empty`) is refused here: the
 *     bridge relays the widget's and the app's `fetch` through the host page,
 *     exactly as it does from an opaque frame;
 *   - the widget's own public scripts (`/widget/<name>.js`) as scripts, since
 *     an app door's widget loads its microphone and pencil by URL;
 *   - never a service worker, which would sit under every attachment on the
 *     origin; never a top-level visit; never a socket; never a write.
 *
 * An app's files are answered only to a page on this same frame hostname
 * (`Sec-Fetch-Site: same-origin`). Every project has a frame hostname of its
 * own under one frame domain, so another project's frame is the same SITE as
 * this one, and its page could otherwise load this project's scripts with
 * this project's cookie attached.
 *
 * ── A separate domain, one hostname per project ──
 *
 * Each project server names its own frame hostname, `<project>.<frame
 * domain>`, on a domain that is not the board's (decision 8 in the
 * per-project servers plan, on its default until the owner answers). Under
 * the board's own domain a mock's script could set a cookie with
 * `Domain=<board domain>` that every board would receive; on another domain
 * the browser refuses it. `sameSiteBoardHosts` names the board hostnames a
 * configured frame hostname still shares a domain with, so the boot log can
 * say so.
 *
 * Who may ask (`request-admission.ts`, kind `frame`): a browser holding this
 * board's frame ticket (`frame-ticket.ts`), which the board's host page hands
 * the frame because Safari sends no Access cookie to a frame on another
 * domain. Without one: through the tunnel, the operator's own Access token
 * and allowlisted email, with external access switched on; off the tunnel, a
 * caller on this machine that is not a browser. The widget's public scripts
 * need nothing. A share or collaboration visitor's host page never points
 * here and mints no ticket, and their token is refused if they try.
 *
 * Off unless configured (`CW_FRAME_ORIGIN`). Unset, every frame stays opaque
 * exactly as before.
 */
import { MOCK_FRAME_PARAM } from '@claude-workspaces/core/page-thread-link';
import {
  FRAME_COOKIE_TTL_MS,
  FRAME_TICKET_PARAM,
  FRAME_TICKET_TTL_MS,
  checkFrameTicket,
  frameCookieHeader,
  frameCookiesOf,
  mintFrameTicket,
} from './frame-ticket.ts';
import { normalizeHost } from './middleware/host-guard.ts';
import { FRAME_HOST_SANDBOX } from './mockup-frame.ts';

export interface FrameHostOptions {
  /** The frame hostname's origin, scheme included: `https://harborlight.frames.example`. */
  origin: string;
  /**
   * The board hostnames whose host pages point their frames here. A board
   * on any other hostname keeps the opaque frame. Defaults to the
   * operator's proxied hostnames.
   */
  boardHosts: readonly string[];
  /** The frame ticket's signing key (`frame-ticket.ts`), read per use. */
  ticketKey: () => string;
}

/** A frame the host page points at the frame hostname. */
export interface FrameTarget {
  origin: string;
  /** Written into the frame's address, traded there for the cookie. */
  ticket: string;
}

/** What a request on the frame hostname proves about who asked. */
export type FrameProof =
  /** A ticket in a frame's address, good: set the cookie and drop it from the address. */
  | { kind: 'redeem'; response: Response }
  /** A ticket in the address that opens nothing here. */
  | { kind: 'bad_ticket' }
  /** The widget's public scripts, which anyone may read. */
  | { kind: 'public' }
  /** A cookie that opens this board's frames on this hostname. */
  | { kind: 'held' }
  | { kind: 'none' };

export interface FrameHost {
  /** The frame hostname's origin, as configured. */
  readonly origin: string;
  /** Whether this request was addressed to the frame hostname. */
  isFrameHost(req: Request): boolean;
  /**
   * Where a host page should frame board `workspaceId`'s attachment, with a
   * fresh ticket, or null for the opaque same-host frame: a share visitor's
   * page, a page on a hostname that is not a board hostname, and the frame
   * hostname itself.
   */
  frameFor(req: Request, visitor: boolean, workspaceId: string): FrameTarget | null;
  /** What this frame hostname request proves (`FrameProof`). Run after `frameGate`. */
  prove(req: Request, pathname: string, search: URLSearchParams): FrameProof;
  /** The frame response's policy on the frame hostname. */
  readonly frameCsp: string;
  /** The board hostnames this frame hostname shares a domain with. */
  readonly sameSiteBoardHosts: readonly string[];
}

/** The frame hostname's origin, or null when the value is not one. */
export function parseFrameOrigin(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  // An origin, nothing else: a path or a query here is a typo, not a prefix.
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
  return u.origin;
}

/** Who may hold a frame from the frame hostname: the board hostnames, each
 *  over https, and over plain http on any port for a board on this machine. */
function frameAncestors(boardHosts: readonly string[]): string {
  const sources = boardHosts
    .map((h) => normalizeHost(h))
    .filter((h) => h !== '' && /^[a-z0-9.-]+$/.test(h))
    .flatMap((h) => [`https://${h}`, `http://${h}:*`]);
  return sources.length === 0 ? "'none'" : sources.join(' ');
}

/**
 * The board hostnames `frameHost` shares a parent domain of two labels or
 * more with, where a cookie one of them sets with a Domain reaches the
 * other. Without the public suffix list this over-reports a shared suffix
 * such as `co.uk`, which only costs a boot-log line.
 */
export function sameSiteHosts(frameHost: string, boardHosts: readonly string[]): string[] {
  const parents = (h: string): string[] => {
    const labels = h.split('.');
    const out: string[] = [];
    for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
    return out;
  };
  const mine = new Set(parents(normalizeHost(frameHost)));
  return boardHosts
    .map((h) => normalizeHost(h))
    .filter((h) => /[a-z]/.test(h) && parents(h).some((p) => mine.has(p)));
}

/** The board a frame path names, or null. */
function workspaceOfPath(pathname: string): string | null {
  const m = /^\/workspaces\/([^/]+)\//.exec(pathname);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** The address without the ticket, every other byte of the query as sent. */
function withoutTicket(pathname: string, search: string): string {
  const parts = search
    .replace(/^\?/, '')
    .split('&')
    .filter((part) => part !== '' && part.split('=')[0] !== FRAME_TICKET_PARAM);
  return parts.length === 0 ? pathname : `${pathname}?${parts.join('&')}`;
}

export function createFrameHost(opts: FrameHostOptions): FrameHost {
  const frameHost = normalizeHost(new URL(opts.origin).host);
  const boards = new Set(opts.boardHosts.map((h) => normalizeHost(h)).filter((h) => h !== ''));
  boards.delete(frameHost);
  const isFrameHost = (req: Request): boolean =>
    normalizeHost(req.headers.get('host')) === frameHost;
  return {
    origin: opts.origin,
    isFrameHost,
    frameFor: (req, visitor, workspaceId) => {
      if (visitor || isFrameHost(req)) return null;
      if (!boards.has(normalizeHost(req.headers.get('host')))) return null;
      return {
        origin: opts.origin,
        ticket: mintFrameTicket(opts.ticketKey(), frameHost, workspaceId, FRAME_TICKET_TTL_MS),
      };
    },
    prove: (req, pathname, search) => {
      if (WIDGET_SCRIPT.test(pathname)) return { kind: 'public' };
      const ws = workspaceOfPath(pathname);
      if (ws === null) return { kind: 'none' };
      const key = opts.ticketKey();
      const ticket = search.get(FRAME_TICKET_PARAM);
      if (ticket !== null && search.get(MOCK_FRAME_PARAM) === '1') {
        if (!checkFrameTicket(key, ticket, frameHost, ws).ok) return { kind: 'bad_ticket' };
        const cookie = mintFrameTicket(key, frameHost, ws, FRAME_COOKIE_TTL_MS);
        const raw = new URL(req.url).search;
        return {
          kind: 'redeem',
          response: new Response(null, {
            status: 303,
            headers: {
              location: withoutTicket(pathname, raw),
              'set-cookie': frameCookieHeader(cookie, ws),
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
            },
          }),
        };
      }
      const held = frameCookiesOf(req.headers.get('cookie')).some(
        (v) => checkFrameTicket(key, v, frameHost, ws).ok,
      );
      return held ? { kind: 'held' } : { kind: 'none' };
    },
    frameCsp: `sandbox ${FRAME_HOST_SANDBOX}; frame-ancestors ${frameAncestors([...boards])}`,
    sameSiteBoardHosts: sameSiteHosts(frameHost, [...boards]),
  };
}

/** The frame hostname's refusal: the same bytes whatever was asked. */
export type FrameGateVerdict = { ok: true } | { ok: false; status: 404 | 405 };

const MOCK_FRAME_PATH = /^\/workspaces\/[^/]+\/mockups\/[^/]+$/;
const APP_PATH = /^\/workspaces\/[^/]+\/apps\/[^/]+(?:\/.*)?$/;
/** The widget's own add-on bundles, which a frame's widget loads by URL. */
const WIDGET_SCRIPT = /^\/widget\/[\w.-]+\.js$/;

/** What an app's files may be loaded as. Not `empty` (a script's own fetch),
 *  `document`, `iframe` without the frame flag, or `serviceworker`. */
const SUBRESOURCE_DESTS = new Set([
  'script',
  'style',
  'image',
  'font',
  'audio',
  'video',
  'track',
  'manifest',
  'worker',
]);

/**
 * Whether the frame hostname answers this request at all — decided from the
 * method, the path and the browser's fetch metadata, before any route runs.
 *
 * A request with no `Sec-Fetch-Dest` is not a browser that sends it — curl,
 * or a browser too old to have it — and is judged by path alone. The page a
 * hostile attachment runs in always sends it, and cannot change it.
 */
export function frameGate(
  req: Request,
  pathname: string,
  search: URLSearchParams,
): FrameGateVerdict {
  if (req.method !== 'GET' && req.method !== 'HEAD') return { ok: false, status: 405 };
  if (req.headers.get('upgrade') !== null) return { ok: false, status: 404 };
  const dest = req.headers.get('sec-fetch-dest');
  const framed = search.get(MOCK_FRAME_PARAM) === '1';
  if (MOCK_FRAME_PATH.test(pathname)) {
    return framed && (dest === null || dest === 'iframe')
      ? { ok: true }
      : { ok: false, status: 404 };
  }
  // Public bundles, served to share visitors too: a script and nothing else.
  if (WIDGET_SCRIPT.test(pathname)) {
    return dest === null || dest === 'script' ? { ok: true } : { ok: false, status: 404 };
  }
  if (APP_PATH.test(pathname)) {
    if (dest === null) return { ok: true };
    if (framed) return dest === 'iframe' ? { ok: true } : { ok: false, status: 404 };
    // A file only to a page on this hostname: another project's frame is
    // the same site, and would otherwise get this project's cookie with it.
    const site = req.headers.get('sec-fetch-site');
    if (site !== null && site !== 'same-origin') return { ok: false, status: 404 };
    return SUBRESOURCE_DESTS.has(dest) ? { ok: true } : { ok: false, status: 404 };
  }
  return { ok: false, status: 404 };
}

/** The refusal's response. Plain, and the same for every reason. */
export function frameGateRefusal(status: 404 | 405): Response {
  return new Response(status === 405 ? 'Method not allowed\n' : 'Not found\n', {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
