/**
 * ── The Hono app: the router route families move into, one family a PR ──
 *
 * Milestone M12 moves this server's routes from the hand-ordered chain in
 * `request-chain.ts` onto Hono. This file is the first step and moves no
 * route: it builds a Hono app from `HONO_FAMILIES`, which is empty, and the
 * chain tries it below the gates and above every route family it holds.
 *
 * Three properties hold for every family that joins.
 *
 * - **The gates have already run.** The app is called with what
 *   `request-chain-gates.ts` proved — the admitted request and its
 *   attribution — as Hono's `env`, so a handler reads `c.env.gate` instead
 *   of admitting the request again. Admission and share scoping run once per
 *   request, whichever router answers.
 * - **An address no family claims falls through unchanged.** Hono's
 *   not-found answer is never sent; `honoFront` returns null for it and the
 *   chain carries on from the line below its call, as it did before Hono.
 * - **A websocket upgrade never enters the app.** The Yjs, audio and Recall
 *   sockets are taken over by Bun's `server.upgrade` in the chain's stream
 *   block, and stay there.
 *
 * Errors are rethrown rather than answered with Hono's default 500, so a
 * throw inside a Hono handler reaches the chain's Sentry span exactly as a
 * throw inside a chain handler does.
 *
 * MOVING A FAMILY: write it as a `HonoFamily`, add it to `HONO_FAMILIES`, and
 * delete its call from the chain in the same commit. The route-answer
 * snapshot (`test/route-answers.test.ts`) fails if any address in the route
 * table is answered differently afterwards — and the move has to keep the
 * family's position relative to the eight adjacencies `route-table.ts`
 * lists, because Hono is tried before every family still in the chain.
 */
import { Hono } from 'hono';
import type { HonoAppEnv, HonoFamily, HonoGateEnv } from '../hono-env.ts';

/**
 * The families Hono answers, in registration order. Empty until the first
 * family moves; see this file's header for how one joins.
 */
export const HONO_FAMILIES: readonly HonoFamily[] = [];

/** Try the Hono app. Null means no family claimed the request. */
export type HonoFront = (req: Request, env: HonoGateEnv) => Promise<Response | null>;

/** Does this request ask to become a websocket? Those stay on Bun. */
export function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

/** The header that marks Hono's not-found answer. Never sent to a caller. */
const MISS_HEADER = 'x-cw-hono-miss';

/** Build the app from its families, once. */
export function createHonoFront(families: readonly HonoFamily[]): HonoFront {
  const app = new Hono<HonoAppEnv>();
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

  // No shortcut for an empty family list: the app runs on every request that
  // is not an upgrade, so the existing suite exercises the miss path today.
  return async (req, env) => {
    if (isWebSocketUpgrade(req)) return null;
    const res = await app.fetch(req, env);
    return res.headers.get(MISS_HEADER) === missMark ? null : res;
  };
}
