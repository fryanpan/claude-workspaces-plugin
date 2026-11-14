import { basemapOf } from '@claude-workspaces/core/map-basemaps';
import { mapBasemapsNamed } from '../doc-file-scope.ts';
import type { DocResourceRouteRequest, DocRoutesContext } from './docs-routes-context.ts';

/**
 * The key a keyed basemap needs, handed to a doc page that draws a map on it.
 *
 *   GET /workspaces/<ws>/docs/<docId>/map-key/<basemap>
 *
 * Answers `{ key }` only when the basemap is one `core/map-basemaps.ts` says
 * needs a key, the server holds that key, and a `<StreetMap>` in the doc's
 * CURRENT content names that basemap in a literal `basemap="…"`. Every other
 * request is a 404 whose `reason` the page reads to say why it fell back:
 * `not-named` (no map in this doc asks for it) or `no-key` (this server has
 * none). A doc that stops naming the basemap stops getting the key on the
 * next read, because the check runs on every request against live content.
 *
 * The key is a Google Maps JavaScript API browser key: Google restricts it to
 * the board's site, and any page that draws the map holds it, so it is a
 * value the reader sees, not a server credential. It still goes nowhere a
 * page does not draw that map, and never into a log or an error body.
 *
 * Gate: `share-scope`. The host guard admits `map-key/*` on a doc only when
 * the doc is inside the shared board, GET only (`docSubrouteAllowed`,
 * `middleware/host-guard.ts`): a visitor who reads the doc reads its map.
 * `no-store`, `nosniff` and `Cross-Origin-Resource-Policy: same-origin`,
 * with CORS only for the server's own allowed origins, so another site's
 * page can neither read the answer nor load it as a script.
 */

const MAP_KEY_SEGMENT = 'map-key/';

const HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
};

const answer = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: HEADERS });

export async function handleDocMapKeyRoute(
  ctx: DocRoutesContext,
  rq: DocResourceRouteRequest,
): Promise<Response | undefined> {
  const { rest, req, doc } = rq;
  if (!rest.startsWith(MAP_KEY_SEGMENT)) return undefined;
  if (req.method !== 'GET') return answer(405, { error: 'method not allowed' });
  const name = rest.slice(MAP_KEY_SEGMENT.length);
  const base = basemapOf(name);
  if (!base?.key) return answer(404, { error: 'no keyed basemap by that name' });
  if (!mapBasemapsNamed(doc.ydoc).includes(name)) {
    return answer(404, { error: 'no map in this doc draws on that basemap', reason: 'not-named' });
  }
  // One provider holds a key today; a second names its own option here.
  const key = name === 'google' ? ctx.googleMapsKey : undefined;
  if (!key)
    return answer(404, { error: 'this server has no key for that basemap', reason: 'no-key' });
  return answer(200, { key });
}
