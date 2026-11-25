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
 * PATTERNS are each module's rows in `route-table-rows.ts`, and each handler
 * is handed the row the request matched (`row-dispatch.ts`): it answers
 * exactly the addresses its rows name, without testing the path again. The
 * handler still decides; an address it declines goes to `next()`.
 */
import type { HonoOpenAppEnv, HonoOpenFamily } from '../hono-env.ts';
import { type BoardImportRoutesContext, handleBoardImportRoute } from './board-import.ts';
import { type GithubHubRoutesContext, handleGithubHubRoute } from './github-hub.ts';
import { type HomeFeedRoutesContext, handleHomeFeedRoute } from './home-feed.ts';
import { claimRowsWith } from './hono-families.ts';

/** Everything long-lived the open families read. Built once by `server.ts`. */
export interface HonoOpenFamiliesContext {
  homeFeedCtx: HomeFeedRoutesContext;
  /** Undefined on a server built without the board import; the family
   *  declines every address then. */
  boardImportCtx: BoardImportRoutesContext | undefined;
  githubHubCtx: GithubHubRoutesContext;
}

/** The request: all an open family reads besides its row. */
const requestOf = (c: { req: { raw: Request } }) => ({ req: c.req.raw });

/** The families, in the order the gates used to try them. */
export function honoOpenFamilies(ctx: HonoOpenFamiliesContext): HonoOpenFamily[] {
  return [
    // routes/home-feed.ts — `/workspaces/<id>/home-feed` and its stream.
    (app) =>
      claimRowsWith<HonoOpenAppEnv, ReturnType<typeof requestOf>>(
        app,
        requestOf,
        'home-feed.ts',
        (v, row) => handleHomeFeedRoute(ctx.homeFeedCtx, v.req, row),
      ),
    // routes/board-import.ts — `/api/board-import/<board>` and its print.
    (app) =>
      claimRowsWith<HonoOpenAppEnv, ReturnType<typeof requestOf>>(
        app,
        requestOf,
        'board-import.ts',
        (v, row) => handleBoardImportRoute(ctx.boardImportCtx, v.req, row),
      ),
    // routes/github-hub.ts — the push keys, a board's own subscriptions, and
    // the relay's subscriptions and events.
    (app) =>
      claimRowsWith<HonoOpenAppEnv, ReturnType<typeof requestOf>>(
        app,
        requestOf,
        'github-hub.ts',
        (v, row) => handleGithubHubRoute(ctx.githubHubCtx, v.req, row),
      ),
  ];
}
