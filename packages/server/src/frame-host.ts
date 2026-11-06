/**
 * The frame-only hostname: where the operator's own mocks and app doors, and a
 * board member's app doors, run,
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
 * caller on this machine that is not a browser. Off the tunnel nothing is
 * answered to a peer that is not this machine, a ticket included. The
 * widget's public scripts need nothing.
 *
 * A board MEMBER who opens an app door on a board hostname gets a ticket
 * too, one that names their Access address. It is the one way a member's
 * browser loads an app's own scripts behind Access: an opaque frame's
 * subresources carry no cookie, so Access answers them with its sign-in
 * page. Their cookie opens only what the membership records still give that
 * address, judged on every request by the same lines as the member's own
 * requests on the board (`memberDoor`, `collabScope`), so removing them ends
 * it at once. It never grants app voice. A mock's host page still gives a
 * member the opaque frame; a member on the share or collaboration hostname
 * is on no board hostname and gets the opaque frame too. A member's Access
 * token with no ticket opens nothing here.
 *
 * ── A frame that left its door ──
 *
 * A router with no base path needs its own address to read `/insights`, so its
 * script takes the door's prefix off with `history.replaceState`. The frame's
 * address is then outside the door: its own `location.reload()`, or a faded pin
 * going to the address the widget stored, asks this server for `/insights`.
 * Nothing in that request names the door. The app may have dropped the query,
 * and the `Referer` is the frame's own stripped address, or nothing in an
 * opaque frame (measured in Chromium on both frames). Only the host page knows
 * which door it holds, so such a frame gets `frameLeftResponse`: fixed bytes,
 * no redirect, a script that tells the page holding it the address it asked
 * for. `mock-door.ts` in the widget puts that address back under the host
 * page's own door and points the frame there.
 *
 * Off unless configured (`CW_FRAME_ORIGIN`). Unset, every frame stays opaque
 * exactly as before.
 */
import { createHash } from 'node:crypto';
import { normalizeEmail } from '@claude-workspaces/core';
import { MOCK_FRAME_PARAM } from '@claude-workspaces/core/page-thread-link';
import {
  FRAME_TICKET_PARAM,
  type FrameKeys,
  checkFrameCookie,
  frameCookieHeader,
  frameCookiesOf,
  mintFrameTicket,
  redeemFrameTicket,
} from './frame-ticket.ts';
import { normalizeHost } from './middleware/host-guard.ts';
import { FRAME_HOST_SANDBOX, queryParamName } from './mockup-frame.ts';

export interface FrameHostOptions {
  /** The frame hostname's origin, scheme included: `https://harborlight.frames.example`. */
  origin: string;
  /**
   * The board hostnames whose host pages point their frames here. A board
   * on any other hostname keeps the opaque frame. Defaults to the
   * operator's proxied hostnames.
   */
  boardHosts: readonly string[];
  /** The ticket's and the cookie's signing keys (`frame-ticket.ts`), read per use. */
  keys: () => FrameKeys;
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
  /** A cookie that opens this board's frames on this hostname, and whether
   *  its host page's reader may be handed an app voice token. `members` is
   *  empty when a cookie the operator's host page started verified; otherwise
   *  it names the board members whose host pages started the cookies, each
   *  still to be checked against the membership records. */
  | { kind: 'held'; appVoice: boolean; members: string[] }
  | { kind: 'none' };

export interface FrameHost {
  /** The frame hostname's origin, as configured. */
  readonly origin: string;
  /** Whether this request was addressed to the frame hostname. */
  isFrameHost(req: Request): boolean;
  /**
   * Where a host page should frame board `workspaceId`'s attachment, with a
   * fresh ticket, or null for the opaque same-host frame: a visitor's page
   * that names no member, a page on a hostname that is not a board hostname,
   * and the frame hostname itself. `appVoice` is the host page's
   * `mayMintAppVoice` verdict for its reader, carried in the ticket to the
   * frame. `member` is the Access address of a visitor the board admitted as
   * a member; their ticket names them and never carries app voice.
   */
  frameFor(
    req: Request,
    visitor: boolean,
    workspaceId: string,
    appVoice?: boolean,
    member?: string,
  ): FrameTarget | null;
  /** What this frame hostname request proves (`FrameProof`). Run after `frameGate`. */
  prove(req: Request, pathname: string, search: URLSearchParams): FrameProof;
  /** The frame response's policy on the frame hostname. */
  readonly frameCsp: string;
  /** What a frame that left its door gets on this hostname. */
  frameLeft(): Response;
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

/** The address without the ticket, every other byte of the query as sent.
 *  Names are compared decoded, as `URLSearchParams` read the ticket, so
 *  `cw%2Dft` cannot keep a ticket in the redirect. */
function withoutTicket(pathname: string, search: string): string {
  const parts = search
    .replace(/^\?/, '')
    .split('&')
    .filter((part) => part !== '' && queryParamName(part) !== FRAME_TICKET_PARAM);
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
    frameFor: (req, visitor, workspaceId, appVoice, member) => {
      const named = member ? normalizeEmail(member) : '';
      if ((visitor && named === '') || isFrameHost(req)) return null;
      if (!boards.has(normalizeHost(req.headers.get('host')))) return null;
      const ticket = visitor
        ? mintFrameTicket(opts.keys().ticket, frameHost, workspaceId, Date.now(), false, named)
        : mintFrameTicket(
            opts.keys().ticket,
            frameHost,
            workspaceId,
            Date.now(),
            appVoice ?? false,
          );
      return { origin: opts.origin, ticket };
    },
    prove: (req, pathname, search) => {
      if (WIDGET_SCRIPT.test(pathname)) return { kind: 'public' };
      const ws = workspaceOfPath(pathname);
      if (ws === null) return { kind: 'none' };
      const keys = opts.keys();
      const ticket = search.get(FRAME_TICKET_PARAM);
      if (ticket !== null && search.get(MOCK_FRAME_PARAM) === '1') {
        // Only a ticket redeems: a cookie value here is refused, so a cookie
        // cannot buy itself another twelve hours.
        const redeemed = redeemFrameTicket(keys, ticket, frameHost, ws);
        if (!redeemed.ok) return { kind: 'bad_ticket' };
        const raw = new URL(req.url).search;
        return {
          kind: 'redeem',
          response: new Response(null, {
            status: 303,
            headers: {
              location: withoutTicket(pathname, raw),
              'set-cookie': frameCookieHeader(redeemed.cookie, ws, redeemed.maxAgeMs),
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
            },
          }),
        };
      }
      // A page's script may plant a cookie beside the real one, but cannot
      // sign one, so any cookie that verifies speaks for its host page.
      let operator = false;
      let appVoice = false;
      const members: string[] = [];
      for (const v of frameCookiesOf(req.headers.get('cookie'), ws)) {
        const c = checkFrameCookie(keys.cookie, v, frameHost, ws);
        if (!c.ok) continue;
        if (c.member === undefined) operator = true;
        else members.push(c.member);
        appVoice ||= c.appVoice;
      }
      if (operator) return { kind: 'held', appVoice, members: [] };
      return members.length > 0 ? { kind: 'held', appVoice: false, members } : { kind: 'none' };
    },
    frameCsp: `sandbox ${FRAME_HOST_SANDBOX}; frame-ancestors ${frameAncestors([...boards])}`,
    frameLeft: () => frameLeftResponse(frameAncestors([...boards])),
    sameSiteBoardHosts: sameSiteHosts(frameHost, [...boards]),
  };
}

/** The frame hostname's refusal: the same bytes whatever was asked. */
export type FrameGateVerdict = { ok: true } | { ok: false; status: 404 | 405; left?: boolean };

const MOCK_FRAME_PATH = /^\/workspaces\/[^/]+\/mockups\/[^/]+$/;
const APP_PATH = /^\/workspaces\/[^/]+\/apps\/[^/]+(?:\/.*)?$/;
/** The widget's own add-on bundles, which a frame's widget loads by URL. */
const WIDGET_SCRIPT = /^\/widget\/[\w.-]+\.js$/;

/** What an app's files may be loaded as. Not `empty` (a script's own fetch),
 *  `document`, `iframe` or `serviceworker`. */
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
    // A frame back at the door with no frame flag: an app's address lost it.
    if (dest === 'iframe') return { ok: false, status: 404, left: true };
    // A file only to a page on this hostname: another project's frame is
    // the same site, and would otherwise get this project's cookie with it.
    const site = req.headers.get('sec-fetch-site');
    if (site !== null && site !== 'same-origin') return { ok: false, status: 404 };
    return SUBRESOURCE_DESTS.has(dest) ? { ok: true } : { ok: false, status: 404 };
  }
  return dest === 'iframe' ? { ok: false, status: 404, left: true } : { ok: false, status: 404 };
}

/** The whole of the script `frameLeftResponse` runs. */
const FRAME_LEFT_SCRIPT =
  "parent.postMessage({cw:'frame-left',to:location.pathname+location.search+location.hash},'*')";
const FRAME_LEFT_HASH = createHash('sha256').update(FRAME_LEFT_SCRIPT).digest('base64');

/**
 * The page a frame gets when it asked for an address outside every door. The
 * bytes are the same whatever was asked and whoever asked, so it needs no
 * proof. It is a 404, with no storage and no reach beyond telling its parent
 * its own address, and only `ancestors` may hold it.
 */
export function frameLeftResponse(ancestors: string): Response {
  return new Response(`<!doctype html><title>Moving</title><script>${FRAME_LEFT_SCRIPT}</script>`, {
    status: 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy':
        `sandbox allow-scripts; default-src 'none'; script-src 'sha256-${FRAME_LEFT_HASH}'; ` +
        `frame-ancestors ${ancestors}`,
    },
  });
}

/**
 * Whether a request on a board's own hostname is a frame that left its door.
 * Fetch metadata decides, and a page cannot change it. The board's own frames
 * are `same-origin` navigations and an opaque frame's are not; a frame on
 * `/workspaces/` is the board's or a door's, whatever the app's script did,
 * and `/s/` is a share link, which answers any frame that follows it. The one
 * address under `/workspaces/` that has left is an app door with no frame
 * flag, which would be served as a bare sandbox with no script allowed.
 * A top-level visit, a fetch and curl are `document`, `empty` and nothing, and
 * get what they always got.
 */
export function leftBoardDoor(req: Request, pathname: string): boolean {
  return (
    (req.method === 'GET' || req.method === 'HEAD') &&
    req.headers.get('sec-fetch-dest') === 'iframe' &&
    req.headers.get('sec-fetch-site') !== 'same-origin' &&
    (!/^\/(?:workspaces|s)\//.test(pathname) ||
      (APP_PATH.test(pathname) && new URL(req.url).searchParams.get(MOCK_FRAME_PARAM) !== '1'))
  );
}

/**
 * A read of a door whose path holds the door again goes to the path after it,
 * or null for any other request. An app that read its path before taking the
 * prefix off, and puts the prefix back on a reload, asks for this; the dev
 * server has no such page. The target is the server's own prefix and what
 * follows the repeat, so it stays under this door.
 */
export function repeatedDoorRedirect(
  method: string,
  tail: string,
  prefix: string,
  search: string,
): Response | null {
  const door = prefix.slice(1);
  if ((method !== 'GET' && method !== 'HEAD') || !tail.startsWith(door)) return null;
  const rest = tail.slice(door.length).replace(/^\/+/, '');
  return new Response(null, { status: 302, headers: { location: `${prefix}${rest}${search}` } });
}

/** The refusal's response. Plain, and the same for every reason. */
export function frameGateRefusal(status: 404 | 405): Response {
  return new Response(status === 405 ? 'Method not allowed\n' : 'Not found\n', {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
