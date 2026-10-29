/**
 * The routes a person's request may need a fresh sign-in for, by method and
 * path. One list for both sides: the server's check
 * (`packages/server/src/fresh-signin.ts`) starts here and then reads the body
 * where the body decides the direction, and the page
 * (`packages/workspaces-app/src/fresh-signin-client.ts`) offers a held action
 * again only if its method and path are on it.
 */

const WS = '/workspaces/[^/]+';

/** Each counted action, the method it is sent with and the path it is sent to. */
export const COUNTED_ROUTES = {
  'delete-workspace': ['DELETE', new RegExp(`^${WS}$`)],
  'delete-doc': ['DELETE', new RegExp(`^${WS}/docs/[^/]+$`)],
  // Without `purge` this archives the review; with it, it destroys. Both count.
  'delete-attachment-set': ['DELETE', new RegExp(`^${WS}/attachments/[^/]+$`)],
  'archive-doc': ['POST', new RegExp(`^${WS}/docs/[^/]+/archive$`)],
  'archive-attachment-set': ['POST', new RegExp(`^${WS}/attachments/[^/]+/archive$`)],
  'share-workspace': ['POST', /^\/api\/share\/workspace$/],
  'share-link': ['POST', /^\/api\/share\/link$/],
  'retire-workspace': ['PUT', new RegExp(`^${WS}/retired$`)],
  'raise-role': ['POST', new RegExp(`^${WS}/members/[^/]+/role$`)],
  'add-member': ['POST', new RegExp(`^${WS}/audience$`)],
  'approve-access': ['POST', new RegExp(`^${WS}/tasks/[^/]+/review-items/[^/]+/access$`)],
  'sharing-on': ['POST', /^\/api\/share\/enabled$/],
  'unlock-board': ['POST', /^\/api\/share\/lock$/],
  'lengthen-share': ['POST', /^\/api\/share\/[^/]+\/ttl$/],
} as const satisfies Record<string, readonly [string, RegExp]>;

export type CountedRoute = keyof typeof COUNTED_ROUTES;

/** Trailing slashes off: the routers answer `/docs/<id>/` as `/docs/<id>`. */
export function trimTrailingSlashes(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;
}

/** The counted route a method and path are, before any body is read. */
export function countedRouteOf(method: string, pathname: string): CountedRoute | null {
  const path = trimTrailingSlashes(pathname);
  for (const [name, [m, pattern]] of Object.entries(COUNTED_ROUTES)) {
    if (m === method && pattern.test(path)) return name as CountedRoute;
  }
  return null;
}
