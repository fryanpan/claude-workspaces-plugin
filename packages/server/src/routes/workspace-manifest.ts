/**
 * `GET /workspaces/<id>/manifest.webmanifest` — the web-app manifest for ONE
 * board, so that "Add to Home Screen" from a shared board installs that
 * board rather than the whole product.
 *
 * The root manifest (`/manifest.webmanifest`, shipped with the app bundle)
 * starts at `/` and is scoped to `/`. That is right for the owner, whose
 * landing page is the list of every board, and wrong for a collaborator on
 * a share hostname, where `/` is out of scope and answers a refusal: the
 * install they got had no icon (the icons were not on the share allowlist
 * either), the product's name rather than their board's, and opened on a
 * page they may not see. This route is the board-shaped answer — its name is
 * the board's title and its start URL and scope are the board's own address,
 * so the app that lands on a phone opens where the link did.
 *
 * Served to anyone the workspace guard has already admitted to the board:
 * the manifest names the board's title and its address, both of which the
 * page that links it already showed them. Which shell links it is decided in
 * `shells.ts` — the visitor's board shell points here, the owner's keeps the
 * root manifest, because the owner's install is the whole product.
 */
import { matchRest } from '../middleware/workspace-scope.ts';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

/**
 * One board's manifest. The icons are the root ones on purpose: they are the
 * product's mark, and a single set means an install from any board shares a
 * cache entry with every other. `id` is the start URL, which is what makes
 * two boards two distinct apps on the same origin rather than one install
 * that the second overwrites.
 */
export function buildBoardManifest(workspaceId: string, name: string): Record<string, unknown> {
  const boardPath = `/workspaces/${encodeURIComponent(workspaceId)}`;
  const title = name.trim() || 'Workspaces';
  return {
    id: boardPath,
    name: title,
    // What a phone prints under the icon. Twelve characters is the iOS
    // Home Screen's comfortable width before it ellipsises.
    short_name: title.length > 12 ? `${title.slice(0, 11).trimEnd()}…` : title,
    description: 'Review docs, diffs and tasks with the people and agents doing the work.',
    start_url: boardPath,
    scope: `${boardPath}/`,
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#2e7dd7',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}

/** Answers the board manifest, or `undefined` when the path is not it. */
export function handleWorkspaceManifest(
  _ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Response | undefined {
  const { req, scope } = rq;
  if (!matchRest(scope, /^manifest\.webmanifest$/) || !scope) return undefined;
  if (req.method !== 'GET') return undefined;
  return new Response(JSON.stringify(buildBoardManifest(scope.workspaceId, scope.board.name)), {
    headers: {
      'content-type': 'application/manifest+json',
      // A board is renamed rarely and an install reads this once; an hour
      // keeps a phone from refetching it on every launch without letting a
      // rename go unseen for a day.
      'cache-control': 'private, max-age=3600',
    },
  });
}
