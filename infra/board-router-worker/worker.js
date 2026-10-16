/**
 * Board router for the one address. Cloudflare Access signs the visitor in
 * first; this Worker then reads the board id out of the path and sends the
 * request down the tunnel of the machine that holds that board. A board the
 * table does not list gets a 404 here, and there is no default server: a
 * request this Worker cannot place never reaches any machine.
 *
 * The Worker is routing, not authorization. It forwards the request as it
 * arrived, `Cf-Access-Jwt-Assertion` and cookies included, and every board
 * server verifies that stamp against Cloudflare's keys itself
 * (`packages/server/src/middleware/cf-access.ts`). A forged or missing stamp
 * routed here is refused by the server, not by this file.
 *
 * Deploying it is a manual step for Bryan — see README.md.
 */

/** A board id is one path segment of id characters, compared undecoded. */
const BOARD_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A hostname as Cloudflare DNS holds it: lower-case labels, no port. */
const ORIGIN_HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

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
 * The fetch handler, with the outbound call injectable so the routing can be
 * driven against real servers in a test. `resolveOverride` sends the request
 * to the origin's DNS record (its tunnel) while the Host header stays the one
 * address, so each server sees the same hostname it is configured for today.
 */
export async function handleBoardRequest(request, env, upstream = fetch) {
  const route = routeBoardRequest(
    new URL(request.url),
    request.headers.get('referer'),
    parseBoardOrigins(env?.BOARD_ORIGINS),
  );
  if (route.kind !== 'forward') {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  return upstream(request, { cf: { resolveOverride: route.origin } });
}

export default {
  fetch(request, env) {
    return handleBoardRequest(request, env);
  },
};
