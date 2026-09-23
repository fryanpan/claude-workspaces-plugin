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

import { searchWithoutFrameParam } from './mockup-frame.ts';

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

/** The address a board serves an app under, with its trailing slash. */
export function appPrefix(workspaceId: string, docId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(docId)}/`;
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
 */
export function upstreamUrl(origin: string, rawTail: string, search: string): URL | null {
  const tail = rawTail.replace(/^\/+/, '');
  if (tail.includes('\\')) return null;
  for (const seg of tail.split('/')) {
    const d = decodeOrNull(seg);
    if (d === null || d === '.' || d === '..') return null;
    if (d.includes('/') || d.includes('\\') || d.includes('\u0000')) return null;
  }
  let u: URL;
  try {
    u = new URL(`/${tail}`, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  u.search = searchWithoutFrameParam(search);
  return u;
}

/**
 * The request headers the dev server is sent: what content negotiation,
 * caching and a resumed event stream need, and nothing that identifies the
 * reader. Their cookie, Access assertion and any token stay on this side.
 */
const FORWARDED_REQUEST = [
  'accept',
  'accept-language',
  'cache-control',
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
