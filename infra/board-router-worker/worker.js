/**
 * Router for the one address and its project subdomains. Cloudflare Access
 * signs the visitor in first; this Worker then picks the server and sends the
 * request down that machine's tunnel and no other.
 *
 * - `<project>.<one address>`: the project's own server, from
 *   `PROJECT_ORIGINS`. Every path goes there.
 * - `<one address>` itself: the board id in the path picks the server, from
 *   `BOARD_ORIGINS`. This is the path every board uses today, kept until the
 *   boards move.
 *
 * Anything it cannot place gets a 404 here, and there is no default server: a
 * request this Worker cannot place never reaches any machine.
 *
 * Cookies are cut down on the way out (`keptCookies`) and a response that
 * tries to set a cookie on a parent domain loses that header on the way back
 * (`withoutDomainCookies`), so a cookie one project's pages set cannot ride
 * along to another project's server.
 *
 * The Worker is routing, not authorization. `Cf-Access-Jwt-Assertion` goes
 * through as it arrived, and every server verifies that stamp against
 * Cloudflare's keys itself (`packages/server/src/middleware/cf-access.ts`). A
 * forged or missing stamp routed here is refused by the server, not by this
 * file.
 *
 * Deploying it: `bun run router:deploy` (README.md).
 */

/** A board id is one path segment of id characters, compared undecoded. */
const BOARD_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A hostname as Cloudflare DNS holds it: lower-case labels, no port. */
const ORIGIN_HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** One DNS label: the project's name in `<project>.<one address>`. */
const PROJECT_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The cookies a server receives. A browser sends only `name=value`, never the
 * Domain a cookie was set for, so the Worker cannot see which cookies were set
 * on a parent domain. It keeps names instead:
 *
 * - any `__Host-` name. A browser accepts one only with no Domain, so it was
 *   set by this exact host and by nothing above it. The session is one
 *   (`__Host-cw_session`, PR 1353).
 * - the four host-only cookies the server and its pages set without that
 *   prefix today (README "Cookies"). A parent-domain cookie under one of these
 *   names still gets through; each is signed or only labels an event, so a
 *   planted one can sign a reader out but reads nothing.
 *
 * Everything else is dropped, `CF_Authorization` included: Access sends the
 * same stamp as the `Cf-Access-Jwt-Assertion` header, which the server reads
 * first.
 */
const KEPT_COOKIES = new Set(['cw_session', 'lf_share', 'cw_geo', 'cw_touch']);

/** The `Cookie` header cut down to the names above, or null when none is left. */
export function keptCookies(header) {
  if (!header) return null;
  const kept = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name.startsWith('__Host-') || KEPT_COOKIES.has(name)) kept.push(part.trim());
  }
  return kept.length > 0 ? kept.join('; ') : null;
}

/** Whether a `Set-Cookie` value names a Domain, which reaches every subdomain under it. */
export function setsDomainCookie(setCookie) {
  return setCookie
    .split(';')
    .slice(1)
    .some((attr) => attr.trim().toLowerCase().startsWith('domain='));
}

/**
 * Parse the routing table. The config is grouped by machine, which is how it
 * is edited: `{"<origin hostname>": ["<board id>", ...], ...}`. Answers a
 * Map from board id to origin hostname, or null when the config is missing or
 * malformed in any part — a bad hostname, a bad id, or one board listed under
 * two origins. Null routes nothing, so a broken config fails closed.
 */
export function parseBoardOrigins(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const table = new Map();
  for (const [origin, boards] of Object.entries(parsed)) {
    if (!ORIGIN_HOST.test(origin) || !Array.isArray(boards)) return null;
    for (const board of boards) {
      if (typeof board !== 'string' || !BOARD_ID.test(board) || table.has(board)) return null;
      table.set(board, origin);
    }
  }
  return table;
}

/**
 * Parse the project table: `{"<project label>": "<origin hostname>", ...}`.
 * Answers a Map from label to origin, or null when the config is missing or
 * malformed in any part. Null routes no subdomain.
 */
export function parseProjectOrigins(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const table = new Map();
  for (const [label, origin] of Object.entries(parsed)) {
    if (!PROJECT_LABEL.test(label) || typeof origin !== 'string' || !ORIGIN_HOST.test(origin)) {
      return null;
    }
    table.set(label, origin);
  }
  return table;
}

/**
 * The project a hostname names: the one label in front of the one address.
 * `a.b.<one address>` names nothing, and neither does the one address itself.
 */
export function projectOfHost(hostname, oneAddress) {
  const suffix = `.${oneAddress}`;
  if (!oneAddress || !hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  return PROJECT_LABEL.test(label) ? label : null;
}

/** The board a path names: `/workspaces/<id>` or anything under it. */
export function boardIdOfPath(pathname) {
  const m = /^\/workspaces\/([^/]+)(?:\/|$)/.exec(pathname);
  return m && BOARD_ID.test(m[1]) ? m[1] : null;
}

/**
 * Where a request goes. The path's own board decides. A path that names no
 * board (the app's scripts and styles) takes the board of the page that asked
 * for it, read from a Referer on this same host; a Referer from anywhere else
 * names nothing. Answers `{ kind: 'forward', boardId, origin }` or
 * `{ kind: 'not_found' }`, and never a default.
 */
export function routeBoardRequest(url, referer, table) {
  if (!table) return { kind: 'not_found' };
  let boardId = boardIdOfPath(url.pathname);
  if (!boardId && referer) {
    let from;
    try {
      from = new URL(referer);
    } catch {
      from = null;
    }
    if (from && from.origin === url.origin) boardId = boardIdOfPath(from.pathname);
  }
  const origin = boardId ? table.get(boardId) : undefined;
  return origin ? { kind: 'forward', boardId, origin } : { kind: 'not_found' };
}

/**
 * Where a request goes, by its host first. With `ONE_ADDRESS` set, a
 * subdomain goes to its project's origin, the one address goes by board, and
 * any other host goes nowhere. With it unset there are no subdomains and every
 * request goes by board, which is how the Worker behaved before subdomains.
 */
export function routeRequest(url, referer, env) {
  const oneAddress = typeof env?.ONE_ADDRESS === 'string' ? env.ONE_ADDRESS : '';
  if (oneAddress && url.hostname !== oneAddress) {
    const project = projectOfHost(url.hostname, oneAddress);
    const origin = project ? parseProjectOrigins(env?.PROJECT_ORIGINS)?.get(project) : undefined;
    return origin ? { kind: 'forward', project, origin } : { kind: 'not_found' };
  }
  return routeBoardRequest(url, referer, parseBoardOrigins(env?.BOARD_ORIGINS));
}

/** The response without any `Set-Cookie` that names a Domain; untouched when it has none. */
export function withoutDomainCookies(response) {
  const all = response.headers.getSetCookie();
  if (!all.some(setsDomainCookie)) return response;
  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  for (const value of all) if (!setsDomainCookie(value)) headers.append('set-cookie', value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The fetch handler, with the outbound call injectable so the routing can be
 * driven against real servers in a test. `resolveOverride` sends the request
 * to the origin's DNS record (its tunnel) while the Host header stays the one
 * the browser asked for, so each server sees a hostname it is configured for.
 */
export async function handleBoardRequest(request, env, upstream = fetch) {
  const route = routeRequest(new URL(request.url), request.headers.get('referer'), env);
  if (route.kind !== 'forward') {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  // A copy, because an incoming request's headers are immutable.
  const outbound = new Request(request);
  const cookies = keptCookies(request.headers.get('cookie'));
  if (cookies) outbound.headers.set('cookie', cookies);
  else outbound.headers.delete('cookie');
  // `manual`: a redirect the server answers (sign-in, a share redeem) goes
  // back to the browser to follow, never followed here on its behalf.
  const response = await upstream(outbound, {
    redirect: 'manual',
    cf: { resolveOverride: route.origin },
  });
  return withoutDomainCookies(response);
}

export default {
  fetch(request, env) {
    return handleBoardRequest(request, env);
  },
};
