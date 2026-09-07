/**
 * A 404 that says WHICH prefix was wrong, for the guesses an agent makes at
 * a workspace-scoped route.
 *
 * Every board resource lives at `/workspaces/<id>/<family>/…` with no `/api`
 * in front, while the process-level routes (`/api/deploy`, `/api/auth/…`,
 * `/api/plugin/…`) do carry one. So the natural first guess at a board route
 * — `/api/workspaces/<ws>/tasks/<id>/schedule`, or `/api/tasks/<id>/…` with
 * the board left out — gets a bare `not found`, which reads as "this build
 * does not have that route" rather than "wrong prefix". The first peer to
 * arm real scheduler rules (2026-09-07) diffed prod's checkout against dev
 * to learn whether the feature had shipped. It had; the prefix was wrong.
 *
 * This is the tail of the router: it runs only after every real route has
 * declined, so it can shadow nothing that exists, and after the share guard
 * in `request-admission.ts` has already refused a visitor — a share visitor
 * gets the same 403 for the prefixed path as for the real one and never
 * sees the hint. Status stays 404; only the body changes, and only for a
 * path this module can name the right address for.
 */

/** The board's collections a caller reaches under `/workspaces/<id>/`. Only
 *  these get a hint when named bare under `/api/`: an unknown word after
 *  `/api/` is a route that does not exist, and saying otherwise would be a
 *  second wrong answer. */
const WORKSPACE_FAMILIES = new Set(['tasks', 'docs', 'goals', 'threads', 'attachments', 'next']);

export interface WrongPrefix {
  /** The address the caller should have used; `<workspaceId>` where the
   *  board was left out. */
  path: string;
  hint: string;
}

/** What the caller meant, if the path is a known wrong-prefix shape. */
export function wrongPrefixOf(pathname: string): WrongPrefix | undefined {
  if (pathname.startsWith('/api/workspaces/')) {
    const path = pathname.slice('/api'.length);
    return {
      path,
      hint: `no /api prefix on board routes — the address is ${path}`,
    };
  }
  const m = /^\/api\/([^/]+)(\/.*)?$/.exec(pathname);
  const family = m?.[1];
  if (!family || !WORKSPACE_FAMILIES.has(family)) return undefined;
  const path = `/workspaces/<workspaceId>/${family}${m?.[2] ?? ''}`;
  return {
    path,
    hint: `${family} live under a board and take no /api prefix — the address is ${path}`,
  };
}

/** The tail 404 for a wrong-prefix path, or `undefined` for every other. */
export function handleWrongPrefix(pathname: string): Response | undefined {
  const wrong = wrongPrefixOf(pathname);
  if (!wrong) return undefined;
  return new Response(JSON.stringify({ error: 'not found', ...wrong }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}
