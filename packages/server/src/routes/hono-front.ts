/**
 * ── The Hono app: the router route families move into, one family a PR ──
 *
 * Milestone M12 moves this server's routes from the hand-ordered chain in
 * `request-chain.ts` onto Hono. This file builds the Hono app from a list of
 * families, and the chain tries each app at the position its families held.
 * After batch 5 the chain itself holds no route family: what is left in
 * `request-chain.ts` is the front door, the gates, the upgrade-and-stream run
 * (which stays on Bun, for the reason below) and the bare 404.
 *
 * Three properties hold for every family that joins.
 *
 * - **The gates have already run.** The app is called with what
 *   `request-chain-gates.ts` proved — the admitted request and its
 *   attribution — as Hono's `env`, so a handler reads `c.env.gate` instead
 *   of admitting the request again. Admission and share scoping run once per
 *   request, whichever router answers. The one exception is the open app,
 *   which IS one of the gates: it is tried inside them, above admission,
 *   with an empty env, and each of its families checks its own caller.
 * - **An address no family claims falls through unchanged.** Hono's
 *   not-found answer is never sent; `honoFront` returns null for it and the
 *   chain carries on from the line below its call, as it did before Hono.
 * - **A websocket upgrade never enters the front.** The Yjs, audio and Recall
 *   sockets are taken over by Bun's `server.upgrade` in the chain's stream
 *   block, and stay there: a Hono handler has to return a `Response`, and a
 *   socket that took the connection over has none to give. The board app,
 *   tried below that block, does let an upgrade in (`upgrades: 'enter'`).
 *
 * Errors are rethrown rather than answered with Hono's default 500, so a
 * throw inside a Hono handler reaches the chain's Sentry span exactly as a
 * throw inside a chain handler does.
 *
 * MOVING A FAMILY: register it in `hono-families.ts` — or, if it reads the
 * workspace scope, in `hono-board-families.ts`; if it answers above
 * admission, in `hono-open-families.ts` — and delete its call from the chain
 * in the same commit. The route-answer
 * snapshot (`test/route-answers.test.ts`) fails if any address in the route
 * table is answered differently afterwards — and the move has to keep the
 * family's position relative to the eight adjacencies `route-table.ts`
 * lists, because Hono is tried before every family still in the chain.
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
