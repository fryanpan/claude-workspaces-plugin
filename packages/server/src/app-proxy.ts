/**
 * A dev server attached to a board, reached through the board's own origin.
 *
 * ── What this is ──
 *
 * An agent runs a site's dev server on a loopback port and attaches it with
 * `attach_app`. The board then serves it at `/workspaces/<ws>/apps/<id>/…`,
 * so a member reads the live app with the sign-in, membership and widget a
 * mock already has, and nobody needs a tunnel hostname or a tailnet grant.
 * `routes/apps.ts` decides the addresses; this module is the part of that
 * which needs no request: which origins may be bound, which proxied paths are
 * inside the app, and which headers cross the proxy in each direction.
 *
 * ── Why only loopback ──
 *
 * The server fetches whatever origin is bound, from this machine, on a
 * member's behalf. A bound origin elsewhere would turn a board into a
 * relay onto any host this machine can reach. So the rule is the one every
 * other bind has, spelled as a URL: `http`, host `127.0.0.1` or `localhost`,
 * a port, nothing else. This server's own port is refused too: bound to
 * itself, the app would fetch this server's trusted-local routes from
 * loopback, which is the address those routes trust.
 *
 * ── Why the path check is ours ──
 *
 * The URL parser already folds `..` and `%2e%2e` before a route sees the
 * path, so a path that climbs out of the app prefix names a different route
 * and never arrives here. What does arrive can still be hostile to the
 * upstream URL we build from it: a tail starting `//host` would resolve as a
 * protocol-relative URL onto another host. So leading slashes are folded
 * away (`<prefix>/__reload` and `<prefix>__reload` are the same path), a
 * tail is refused on any dot segment, encoded slash, backslash or NUL, and
 * the built URL must still name the bound origin.
 */

import { WRITE_VIA_SOCKET_PARAM, queryParamName, searchWithoutFrameParam } from './mockup-frame.ts';

/** The origin an app may be bound to, or why not. */
export type LoopbackOrigin = { ok: true; origin: string } | { ok: false; error: string };

/** The rule, in the words a refused caller is told. */
export const LOOPBACK_RULE =
  'An app origin must be http://127.0.0.1:<port> or http://localhost:<port>, with no path, query or credentials.';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

/**
 * Parse an agent's origin. Accepts a trailing slash, nothing else past the
 * port, and answers the normalised `http://host:port`.
 */
export function parseLoopbackOrigin(raw: unknown, ownPort?: number): LoopbackOrigin {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, error: LOOPBACK_RULE };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: LOOPBACK_RULE };
  }
  if (u.protocol !== 'http:') return { ok: false, error: LOOPBACK_RULE };
  if (!LOOPBACK_HOSTS.has(u.hostname)) return { ok: false, error: LOOPBACK_RULE };
  if (u.username || u.password || u.search || u.hash) return { ok: false, error: LOOPBACK_RULE };
  if (u.pathname !== '/' || u.port === '') return { ok: false, error: LOOPBACK_RULE };
  if (ownPort !== undefined && Number(u.port) === ownPort) {
    return { ok: false, error: 'An app origin cannot be this server itself.' };
  }
  return { ok: true, origin: `http://${u.hostname}:${u.port}` };
}

/** `apps/<id>` and whatever follows it, off a board scope's remainder. */
export const APP_ADDRESS = /^apps\/([^/]+)(?:\/(.*))?$/;

/** The address a board serves an app under, with its trailing slash. */
export function appPrefix(workspaceId: string, docId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(docId)}/`;
}

/**
 * Where an app's dev server is asked for a path: under the board's prefix
 * when it was started there (Vite's `base`, `DocMeta.appServesPrefix`), so
 * it receives the address the reader's browser used; at its root otherwise.
 */
export function upstreamBase(
  meta: { appServesPrefix?: boolean },
  workspaceId: string,
  docId: string,
): string {
  return meta.appServesPrefix ? appPrefix(workspaceId, docId) : '/';
}

function decodeOrNull(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * The upstream URL for `tail`, the undecoded path after the app prefix, or
 * null when the tail could leave the app. `search` is passed through byte
 * for byte as the browser sent it, minus the frame flag, which is the
 * board's and not the app's. The upstream `Host` is the bound origin's own
 * (`127.0.0.1:<port>`), because the request is made to that URL and no
 * reader header named `host` is forwarded.
 *
 * `base` is where the tail is put on the dev server: `/` for a site that
 * serves at its root, the app's own prefix for one started under it
 * (`upstreamBase`). It is built here, never read from the request.
 */
export function upstreamUrl(
  origin: string,
  rawTail: string,
  search: string,
  base = '/',
): URL | null {
  const tail = rawTail.replace(/^\/+/, '');
  if (tail.includes('\\')) return null;
  for (const seg of tail.split('/')) {
    const d = decodeOrNull(seg);
    if (d === null || d === '.' || d === '..') return null;
    if (d.includes('/') || d.includes('\\') || d.includes('\u0000')) return null;
  }
  let u: URL;
  try {
    u = new URL(`${base}${tail}`, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  u.search = searchWithoutFrameParam(search);
  return u;
}

/**
 * The upstream address for a socket: `upstreamUrl`, on the `ws:` scheme, with
 * the host page's relay mark taken off. Everything else in the query is the
 * app's: Vite's client proves itself with `?token=`.
 */
export function upstreamSocketUrl(
  origin: string,
  rawTail: string,
  search: string,
  base = '/',
): URL | null {
  const kept = search
    .replace(/^\?/, '')
    .split('&')
    .filter((part) => queryParamName(part) !== WRITE_VIA_SOCKET_PARAM)
    .join('&');
  const u = upstreamUrl(origin, rawTail, kept === '' ? '' : `?${kept}`, base);
  if (u) u.protocol = 'ws:';
  return u;
}

/** Every address of one app, and the bare one. */
const APP_DOOR_PATH = /^\/workspaces\/[^/]+\/apps\/[^/]+(?:\/|$)/;

/**
 * Keep a door answer out of Cloudflare's cache, whatever the dev server said.
 * A dev server's own caching headers are for a browser on its port, and an
 * edge copy of an app's script outlives the file it was read from, so a reader
 * reviews old code after a hard reload. Stamped on the finished response, so
 * a refusal from a gate above the app routes and a 304 carry it too.
 */
export function withAppDoorCacheRule(pathname: string, res: Response): Response {
  if (APP_DOOR_PATH.test(pathname)) res.headers.set('cloudflare-cdn-cache-control', 'no-store');
  return res;
}

/** RFC 6455's subprotocol name: an HTTP token. */
const SUBPROTOCOL = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
/** The widget's token, which a door socket offers as a subprotocol. */
const WIDGET_TOKEN = /^wt[12]\./;
/** More than any framework offers; the rest of the list is not forwarded. */
const MAX_SUBPROTOCOLS = 8;

/**
 * The subprotocols the dev server is offered, off a handshake's header.
 * A widget token is the reader's credential and stays on this side, for the
 * reason their cookie does.
 */
export function offeredSubprotocols(header: string | null): string[] {
  return (header ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => SUBPROTOCOL.test(s) && !WIDGET_TOKEN.test(s))
    .slice(0, MAX_SUBPROTOCOLS);
}

/**
 * The request headers the dev server is sent: what content negotiation,
 * caching, a resumed event stream and a write need, and nothing that
 * identifies the reader. Their cookie, Access assertion and any token stay on this side.
 */
const FORWARDED_REQUEST = [
  'accept',
  'accept-language',
  'cache-control',
  // What a write needs the app to read its body and retry it safely.
  'content-language',
  'content-type',
  'idempotency-key',
  'if-unmodified-since',
  'prefer',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'last-event-id',
  'range',
  'user-agent',
];

export function upstreamRequestHeaders(from: Headers): Headers {
  const out = new Headers();
  for (const name of FORWARDED_REQUEST) {
    const v = from.get(name);
    if (v !== null) out.set(name, v);
  }
  // The body comes back decoded or not at all; asking for none keeps the
  // bytes we relay the bytes the dev server wrote.
  out.set('accept-encoding', 'identity');
  return out;
}

/**
 * Response headers that never cross: the hop-by-hop set (RFC 9110 §7.6.1),
 * cookies, and the length and encoding the relay itself decides. A dev
 * server's `set-cookie` would land on the board's origin; its CSP and framing
 * headers are replaced by the frame's own.
 */
const DROPPED_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
  'set-cookie2',
  'content-length',
  'content-encoding',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'alt-svc',
]);

/**
 * The dev server's response headers as the reader gets them. A header named
 * in `Connection` is hop-by-hop by declaration and is dropped too. A
 * `Location` on the bound origin is moved under the app prefix, so a
 * trailing-slash redirect does not send the reader to their own loopback.
 */
export function relayedResponseHeaders(from: Headers, origin: string, prefix: string): Headers {
  const declared = new Set(
    (from.get('connection') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const out = new Headers();
  for (const [k, v] of from) {
    const name = k.toLowerCase();
    if (DROPPED_RESPONSE.has(name) || declared.has(name)) continue;
    out.append(k, name === 'location' ? relayedLocation(v, origin, prefix) : v);
  }
  out.set('x-content-type-options', 'nosniff');
  return out;
}

/** A redirect target, kept inside the app when it names the bound origin. */
export function relayedLocation(location: string, origin: string, prefix: string): string {
  let u: URL;
  try {
    u = new URL(location, `${origin}/`);
  } catch {
    return location;
  }
  if (u.origin !== origin) return location;
  const path = u.pathname.startsWith(prefix) ? u.pathname : `${prefix}${u.pathname.slice(1)}`;
  return `${path}${u.search}${u.hash}`;
}

/** Is this a page the browser renders as a document of its own? */
export function isHtmlResponse(headers: Headers): boolean {
  const type = headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  return type === 'text/html' || type === 'application/xhtml+xml';
}

/** The methods that write to an attached app, under `apps/<id>/…`. */
export const APP_WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Who is asking to write to an attached app. `owner` is any caller the board
 * did not admit as a visitor: the owner's own browser, signed in, or a caller
 * on this machine. `member` is a visitor admitted by a board membership with
 * an Access address. Everyone else, a share-link visitor and a board agent's
 * token included, is `outsider`.
 */
export type AppWriter =
  | { kind: 'owner' }
  | { kind: 'member'; email: string }
  | { kind: 'outsider' };

/** Who a write comes from: the board's `visitor` flag and, for a visitor
 *  admitted by membership, their Access address. */
export function appWriterOf(visitor: boolean, member: string | null): AppWriter {
  if (!visitor) return { kind: 'owner' };
  return member ? { kind: 'member', email: member } : { kind: 'outsider' };
}

export interface AppWriteRefusal {
  error: 'app_write_not_member' | 'app_write_cross_origin';
  message: string;
}

/**
 * Whether this write may reach the app, or why not. The one place the rule
 * lives, so a change to it (owner only, or a per-app setting) is made here.
 *
 * Today: the owner and the board's signed-in members may write; a share-link
 * visitor may not. And only from a page on the board's own origin: `Origin`
 * must equal the origin this request was served on, exactly. A write with no
 * `Origin` is refused too. Every browser sends one on a non-GET fetch, so its
 * absence means a caller that is not a page, and such a caller can reach the
 * dev server on loopback itself.
 */
export function appWriteRefusal(input: {
  writer: AppWriter;
  origin: string | null;
  boardOrigin: string;
}): AppWriteRefusal | null {
  if (input.writer.kind === 'outsider') {
    return {
      error: 'app_write_not_member',
      message: "Only the board's signed-in members can save to this app.",
    };
  }
  if (input.origin === null || input.origin !== input.boardOrigin) {
    return {
      error: 'app_write_cross_origin',
      message: "A write to this app must come from a page on the board's own address.",
    };
  }
  return null;
}
