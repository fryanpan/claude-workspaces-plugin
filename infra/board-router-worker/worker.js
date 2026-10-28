/**
 * Router for the one address and each project's own hostname. Cloudflare
 * Access signs the visitor in first; this Worker then picks the server and
 * sends the request down that machine's tunnel and no other.
 *
 * - `<project>-<first label of the one address>.<rest of it>`, e.g.
 *   `riverbend-workspaces.<zone>` beside `workspaces.<zone>`: the project's
 *   own server, from `PROJECT_ORIGINS`. Every path goes there. The name is
 *   one level under the zone, which the zone's free Universal SSL
 *   certificate covers; `<project>.<one address>`, two levels down, needed a
 *   paid one.
 * - `<one address>` itself: the board id in the path picks the server, from
 *   `BOARD_ORIGINS`. This is the path every board uses today, kept until the
 *   boards move.
 * - `<project>.<frame domain>`: the project's frame hostname, on a domain of
 *   its own (`FRAME_DOMAIN`), where its mocks and app doors run. The same
 *   project's origin, from `PROJECT_ORIGINS`, and only the frame cookie goes
 *   with it (`frameCookies`).
 *
 * Anything it cannot place gets a 404 here, and there is no default server: a
 * request this Worker cannot place never reaches any machine.
 *
 * Cookies are cut down on the way out (`keptCookies`) and a response that
 * tries to set a cookie on a parent domain loses that header on the way back
 * (`withoutDomainCookies`), so a cookie one project's pages set cannot ride
 * along to another project's server.
 *
 * With `ONE_ADDRESS_ORIGIN` set, the one address forwards only to the machine
 * that owns its Access application and redirects every other board to its
 * project's own hostname (`keepOneAddressStampHome`), so no server ever holds a
 * copy of a stamp that another server accepts.
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
/** One DNS label: a project's name in its hostname. */
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

/** The one cookie a frame hostname's server reads: the board's frame ticket
 *  (`packages/server/src/frame-ticket.ts`). A frame's page can set any other
 *  name on its own hostname, and none of them grants anything there. */
const FRAME_COOKIE = 'cw_frame';

/** The `Cookie` header on a frame hostname, cut down to the frame cookie. */
export function frameCookies(header) {
  if (!header) return null;
  const kept = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq >= 0 && part.slice(0, eq).trim() === FRAME_COOKIE) kept.push(part.trim());
  }
  return kept.length > 0 ? kept.join('; ') : null;
}

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
 * malformed in any part. Null routes no project hostname.
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

/** The one label in front of `domain`: `<label>.<domain>`, and nothing deeper. */
function labelUnder(hostname, domain) {
  const suffix = `.${domain}`;
  if (!domain || !hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  return PROJECT_LABEL.test(label) ? label : null;
}

/**
 * What every project hostname ends with: `-<first label>.<rest>` of the one
 * address, so `-workspaces.<zone>` for `workspaces.<zone>`. Null for a one
 * address with no dot.
 */
function projectSuffix(oneAddress) {
  const dot = typeof oneAddress === 'string' ? oneAddress.indexOf('.') : -1;
  return dot > 0 ? `-${oneAddress.slice(0, dot)}${oneAddress.slice(dot)}` : null;
}

/**
 * The project a hostname names: `riverbend` for
 * `riverbend-workspaces.<zone>` when the one address is `workspaces.<zone>`.
 * A deeper name, the one address itself and any other host name nothing.
 */
export function projectOfHost(hostname, oneAddress) {
  const suffix = projectSuffix(oneAddress);
  if (!suffix || !hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  return PROJECT_LABEL.test(label) ? label : null;
}

/** A project's own hostname: the inverse of `projectOfHost`. */
export function projectHost(label, oneAddress) {
  return `${label}${projectSuffix(oneAddress) ?? `-${oneAddress}`}`;
}

/** The one project label whose origin this is, or null for none or several. */
function soleLabelOf(origin, projects) {
  let found = null;
  for (const [label, o] of projects ?? []) {
    if (o !== origin) continue;
    if (found !== null) return null;
    found = label;
  }
  return found;
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
 * project hostname goes to its project's origin, the one address goes by board, and
 * any other host goes nowhere. With it unset there are no project hostnames and
 * every request goes by board, which is how the Worker behaved before them.
 */
export function routeRequest(url, referer, env) {
  const oneAddress = typeof env?.ONE_ADDRESS === 'string' ? env.ONE_ADDRESS : '';
  const frameDomain = typeof env?.FRAME_DOMAIN === 'string' ? env.FRAME_DOMAIN : '';
  // A frame domain that is the one address, or under it, would put the
  // frames back on the board's site, so it routes no frame at all.
  if (frameDomain && url.hostname.endsWith(`.${frameDomain}`)) {
    const sameSite =
      oneAddress !== '' &&
      (frameDomain === oneAddress ||
        frameDomain.endsWith(`.${oneAddress}`) ||
        oneAddress.endsWith(`.${frameDomain}`));
    const project = sameSite ? null : labelUnder(url.hostname, frameDomain);
    const origin = project ? parseProjectOrigins(env?.PROJECT_ORIGINS)?.get(project) : undefined;
    return origin ? { kind: 'forward', project, origin, frame: true } : { kind: 'not_found' };
  }
  if (oneAddress && url.hostname !== oneAddress) {
    const project = projectOfHost(url.hostname, oneAddress);
    const origin = project ? parseProjectOrigins(env?.PROJECT_ORIGINS)?.get(project) : undefined;
    return origin ? { kind: 'forward', project, origin } : { kind: 'not_found' };
  }
  const route = routeBoardRequest(url, referer, parseBoardOrigins(env?.BOARD_ORIGINS));
  return oneAddress ? keepOneAddressStampHome(route, url, oneAddress, env) : route;
}

/**
 * One Access application per project. A request on the one address carries a
 * stamp minted for the one address's own application, and the machine that
 * owns that application (`ONE_ADDRESS_ORIGIN`) is the only one that may
 * receive it: any other server holding a copy could replay it to that machine.
 * So with `ONE_ADDRESS_ORIGIN` set, a board held anywhere else is not
 * forwarded. It is redirected to its project's own hostname, where the
 * browser signs in to that project's application and gets a stamp of its own;
 * a board on an origin with no single project label gets a 404. A malformed
 * value routes nothing on the one address. Unset, every board is forwarded as
 * before projects had applications of their own.
 */
function keepOneAddressStampHome(route, url, oneAddress, env) {
  const home = env?.ONE_ADDRESS_ORIGIN;
  if (home === undefined || home === '' || route.kind !== 'forward') return route;
  if (typeof home !== 'string' || !ORIGIN_HOST.test(home)) return { kind: 'not_found' };
  if (route.origin === home) return route;
  const label = soleLabelOf(route.origin, parseProjectOrigins(env?.PROJECT_ORIGINS));
  if (!label) return { kind: 'not_found' };
  return {
    kind: 'redirect',
    location: `https://${projectHost(label, oneAddress)}${url.pathname}${url.search}`,
  };
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
  if (route.kind === 'redirect') {
    // 308 keeps the method and body, so a write lands where it was aimed.
    return new Response(null, {
      status: 308,
      headers: { location: route.location, 'cache-control': 'no-store' },
    });
  }
  if (route.kind !== 'forward') {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  // A copy, because an incoming request's headers are immutable.
  const outbound = new Request(request);
  const cookies = route.frame
    ? frameCookies(request.headers.get('cookie'))
    : keptCookies(request.headers.get('cookie'));
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
