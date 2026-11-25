/**
 * ── The families Hono answers above admission (M12) ──
 *
 * The home feed, the board import and the GitHub hub. Their callers name
 * nobody — a peer server, a relay, a loopback tool — so each family checks
 * its own caller, and all three are tried inside the gates
 * (`hono-gates.ts`): below the CORS preflight and the cross-origin
 * write gates, above admission. That is where they sat in the chain, and this
 * app is tried from the same line, so nothing above or below them moved.
 *
 * WHY A THIRD APP. The front (`hono-families.ts`) is tried below admission
 * with what it proved, and these must not wait for admission: a peer's
 * request would be refused there before its own check could run. So the env
 * here is empty (`HonoOpenAppEnv`), and a handler reads only the request.
 *
 * PATTERNS are each module's rows in `route-table-rows.ts` (`rowPatterns`):
 * each handler answers exactly the addresses its rows name. The handler
 * still decides; an address it declines goes to `next()`.
 */
import type { HonoOpenAppEnv, HonoOpenFamily } from '../hono-env.ts';
import { type BoardImportRoutesContext, handleBoardImportRoute } from './board-import.ts';
import { type GithubHubRoutesContext, handleGithubHubRoute } from './github-hub.ts';
import { type HomeFeedRoutesContext, handleHomeFeedRoute } from './home-feed.ts';
import { claimWith, rowPatterns } from './hono-families.ts';

/** Everything long-lived the open families read. Built once by `server.ts`. */
export interface HonoOpenFamiliesContext {
  homeFeedCtx: HomeFeedRoutesContext;
  /** Undefined on a server built without the board import; the family
   *  declines every address then. */
  boardImportCtx: BoardImportRoutesContext | undefined;
  githubHubCtx: GithubHubRoutesContext;
}

/** The request and its path: all an open family reads. */
const requestOf = (c: { req: { raw: Request } }) => {
  const req = c.req.raw;
  return { req, pathname: new URL(req.url).pathname };
};

/** The families, in the order the gates used to try them. */
export function honoOpenFamilies(ctx: HonoOpenFamiliesContext): HonoOpenFamily[] {
  return [
    // routes/home-feed.ts — `/workspaces/<id>/home-feed` and its stream.
    (app) =>
      claimWith<HonoOpenAppEnv, ReturnType<typeof requestOf>>(
        app,
        requestOf,
        rowPatterns('home-feed.ts'),
        (v) => handleHomeFeedRoute(ctx.homeFeedCtx, v.req, v.pathname),
      ),
    // routes/board-import.ts — `/api/board-import/<board>` and its print.
    (app) =>
      claimWith<HonoOpenAppEnv, ReturnType<typeof requestOf>>(
        app,
        requestOf,
        rowPatterns('board-import.ts'),
        (v) => handleBoardImportRoute(ctx.boardImportCtx, v.req, v.pathname),
      ),
    // routes/github-hub.ts — the push keys, a board's own subscriptions, and
    // the relay's subscriptions and events.
    (app) =>
      claimWith<HonoOpenAppEnv, ReturnType<typeof requestOf>>(
        app,
        requestOf,
        rowPatterns('github-hub.ts'),
        (v) => handleGithubHubRoute(ctx.githubHubCtx, v.req, v.pathname),
      ),
  ];
}
