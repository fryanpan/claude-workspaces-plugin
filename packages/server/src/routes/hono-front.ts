/**
 * ── The Hono sub-apps the router calls, one per place families sit ──
 *
 * Milestone M12 moved this server's routes from a hand-ordered chain onto
 * Hono. The router is `hono-app.ts`: one Hono app whose middleware are the
 * gates (`hono-gates.ts`), the front app, the upgrade-and-stream run and the
 * board app, in that order. This file builds each sub-app from a list of
 * families; the router calls it from its own middleware, so the order
 * families are tried in is the order they had in the chain.
 *
 * Three properties hold for every family that joins.
 *
 * - **The gates have already run.** The app is called with what
 *   `hono-gates.ts` proved — the admitted request and its attribution — as
 *   Hono's `env`, so a handler reads `c.env.gate` instead of admitting the
 *   request again. Admission and share scoping run once per request. The one
 *   exception is the open app, which IS one of the gates: it is tried inside
 *   them, above admission, with an empty env, and each of its families
 *   checks its own caller.
 * - **An address no family claims falls through unchanged.** Hono's
 *   not-found answer is never sent; `honoFront` returns null for it and the
 *   router's next middleware runs, as the next line of the chain did.
 * - **A websocket upgrade skips the front.** The Yjs, audio and Recall
 *   sockets are taken over in the router's upgrade-and-stream middleware,
 *   which sits below the front, so an upgrade request must not be answered
 *   by a front family first. The board app, below that middleware, does let
 *   an upgrade in (`upgrades: 'enter'`).
 *
 * Errors are rethrown rather than answered with Hono's default 500, so a
 * throw inside a Hono handler reaches the front door's Sentry span.
 *
 * MOVING OR ADDING A FAMILY: register it in `hono-families.ts` — or, if it
 * reads the workspace scope, in `hono-board-families.ts`; if it answers
 * above admission, in `hono-open-families.ts`. The route-answer snapshot
 * (`test/route-answers.test.ts`) fails if any address in the route table is
 * answered differently afterwards — and a family has to keep its position
 * relative to the eight adjacencies `route-table.ts` lists.
 */
import { type Env, Hono } from 'hono';
import type { HonoAppEnv, HonoGateEnv } from '../hono-env.ts';

/** Try the Hono app. Null means no family claimed the request. */
export type HonoFront<E extends object = HonoGateEnv> = (
  req: Request,
  env: E,
) => Promise<Response | null>;

/** Does this request ask to become a websocket? Those stay on Bun. */
export function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

/** The header that marks Hono's not-found answer. Never sent to a caller. */
const MISS_HEADER = 'x-cw-hono-miss';

export interface HonoFrontOptions {
  /**
   * What a websocket upgrade does at this app. `skip` (the default) hands it
   * back unseen, for the front: it is tried ABOVE the stream block, which has
   * to see every upgrade first. `enter` lets it in like any request, for the
   * open app (whose paths no upgrade uses) and the board app (tried BELOW the
   * stream block, so an upgrade reaching it is one no socket took).
   */
  upgrades?: 'skip' | 'enter';
}

/**
 * Build an app from its families, once. Three are built: the open app, tried
 * inside the gates above admission (`HonoOpenAppEnv`); the front, tried above
 * the stream block with the gates' proof (`HonoAppEnv`); and the board app,
 * tried below the stream block, which resolves the workspace scope and ends
 * in the tail (`HonoBoardAppEnv`).
 */
export function createHonoFront<A extends Env = HonoAppEnv>(
  families: readonly ((app: Hono<A>) => void)[],
  opts: HonoFrontOptions = {},
): HonoFront<NonNullable<A['Bindings']>> {
  const app = new Hono<A>();
  for (const family of families) family(app);

  // The not-found answer Hono builds is a marker, never a reply. It is
  // recognised by a header carrying a value made once per app, so no family
  // can produce one by returning a 404 of its own. Not by object identity:
  // Hono answers a HEAD by dispatching it as a GET and copying the status and
  // headers into a NEW Response, so a miss on HEAD is a different object from
  // the one built here. The route-answer snapshot caught exactly that — nine
  // HEAD rows answered Hono's empty 404 instead of falling through.
  const missMark = crypto.randomUUID();
  app.notFound(() => new Response(null, { status: 404, headers: { [MISS_HEADER]: missMark } }));
  app.onError((err) => {
    throw err;
  });

  const skipUpgrades = (opts.upgrades ?? 'skip') === 'skip';
  // No shortcut for an empty family list: the app runs on every request that
  // is not an upgrade, so the existing suite exercises the miss path today.
  return async (req, env) => {
    if (skipUpgrades && isWebSocketUpgrade(req)) return null;
    const res = await app.fetch(req, env);
    return res.headers.get(MISS_HEADER) === missMark ? null : res;
  };
}
