/**
 * ── The router: every request, in the order it is tried ──
 *
 * `createServer` composes; this answers. Two layers.
 *
 * - **The front door** (`createHonoApp`): the bad-path refusal, the hydration
 *   prewarm, the Sentry span, and on the way out compression, CORS, the
 *   session refresh and the slow-request line. It wraps the router rather
 *   than being middleware inside it because it decorates whatever comes out,
 *   and Hono's `c.res` setter copies the old response's headers onto a new
 *   one, which would carry a stale `content-length` onto a compressed body.
 * - **The router** (`createRouter`): one Hono app, middleware in the order
 *   the hand-written chain tried them — the gates (`hono-gates.ts`, with the
 *   open families inside them), the owner proof, the front families
 *   (`hono-front.ts` with `hono-families.ts`), the upgrades and streams
 *   (`upgrade-stream.ts`), and the board app: the workspace scope, the board
 *   families (`hono-board-families.ts`) and the tail
 *   (`hono-tail-families.ts`). Hono's not-found is the bare 404.
 *
 * The order is behaviour: Hono runs the middleware that match an address in
 * registration order, and every middleware here matches `*`, so registration
 * order is the order. See `route-table.ts` for the eight adjacencies Bun's
 * specificity matching would not keep.
 *
 * Everything here is long-lived and arrives once, as `HonoAppContext`. The
 * peer address is `requestAddress(req)` rather than
 * `server.requestIP(req)?.address`, because this module cannot hold
 * `Bun.serve`'s return value.
 */
import { Hono } from 'hono';
import { isOwnerActor } from '../actor-identity.ts';
import { withAppDoorCacheRule } from '../app-proxy.ts';
import { mayMintAppVoice as mayMintAppVoiceFor } from '../app-voice/gate.ts';
import { maybeCompress, maybeNotModified } from '../compress.ts';
import { setRequestAuthor } from '../event-origin.ts';
import type { HonoRouterEnv } from '../hono-env.ts';
import { refusedWriteLine } from '../middleware/refused-write-log.ts';
import { malformedPathSegment } from '../path-params.ts';
import { captureServerError, routePatternForSpan, withRouteSpan } from '../sentry.ts';
import type { HonoAppContext } from './hono-app-context.ts';
import { honoGates } from './hono-gates.ts';

/**
 * The handler `Bun.serve` dispatches every request to, through the
 * `handleWithOrigin` wrapper in `createServer`. `undefined` means the request
 * became a websocket.
 */
export function createHonoApp(
  ctx: HonoAppContext,
): (req: Request) => Promise<Response | undefined> {
  const { docStore, applyCors, refreshSession, slowRequestMs, policyFor, isValidDocId } = ctx;
  const route = createRouter(ctx);

  return async function handleRequest(req: Request): Promise<Response | undefined> {
    const startedAt = performance.now();
    const pathname = new URL(req.url).pathname;
    // Counted before any gate, so the memory line names refused traffic too.
    docStore.noteRequest(req.method, pathname);
    // A stray `%` anywhere in the path is a caller's typo, and it has to
    // be answered before anything decodes it: `decodeURIComponent` throws a
    // `URIError` inside whichever matcher pulls the id out of the path, and
    // that surfaces as a 500 naming nothing. Front door rather than per
    // route — a check each route must remember covers only the routes
    // somebody remembered to change, and there are 95 direct decode calls.
    const badSegment = malformedPathSegment(pathname);
    if (badSegment !== undefined) {
      return applyCors(
        req,
        new Response(
          JSON.stringify({
            error: 'bad-path',
            message: 'a path segment is not valid percent-encoding',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    // A docId-addressed request may HYDRATE that doc, and hydration reads
    // the doc's bound file. That read used to run on the main thread, where
    // a cloud-sync folder that had stopped answering parked the whole
    // server — every route, not just this one (see slow-fs.ts). Doing it
    // here, on the thread pool and under a deadline, means the synchronous
    // hydrate inside the route either finds the bytes already in hand or
    // finds the path quarantined and parks the doc without touching it.
    const prewarmUrl = new URL(req.url);
    const prewarmIds = docIdsAddressedBy(prewarmUrl, isValidDocId);
    if (prewarmIds.length > 0) {
      await Promise.all(prewarmIds.map((id) => docStore.prewarmHydration(id)));
    }
    // Server-side Sentry (a no-op passthrough when unconfigured — see
    // sentry.ts): one span per request, named by route PATTERN never raw
    // path, continuing the browser's trace when it sent one so a page load
    // reads end to end. A throw inside `route()` is reported with the same
    // route-pattern context, then rethrown unchanged — this wrapper only
    // observes, it does not change what a request returns.
    let routed: Response | undefined;
    try {
      routed = await withRouteSpan(req, pathname, () => route(req));
    } catch (err) {
      captureServerError(err, { route: routePatternForSpan(pathname), method: req.method });
      throw err;
    }
    // Compress BEFORE the CORS merge so the encoding headers ride out on the
    // same response the wrapper copies; `maybeCompress` skips anything whose
    // content-type isn't on its allowlist (see compress.ts for why that gate
    // is narrow — a live stream must never be buffered to compress it).
    //
    // `maybeNotModified` runs first: when the client already holds the body,
    // gzipping it is the one case where the CPU buys nothing, and a 304 has
    // no body for `maybeCompress` to act on anyway.
    // `undefined` means the request became a websocket — nothing to decorate.
    if (routed === undefined) return undefined;
    const refused = await refusedWriteLine(req, routed, policyFor);
    if (refused) console.error(refused);
    const response = withAppDoorCacheRule(
      pathname,
      applyCors(req, refreshSession(req, await maybeCompress(req, maybeNotModified(req, routed)))),
    );
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs >= slowRequestMs) {
      // Path only — the query can carry a person's name (`?user=`), and
      // the line is for a grep over durations, not a record of who asked.
      console.error(
        `[timing] ${req.method} ${pathname} ${Math.round(elapsedMs)}ms ` +
          `status=${response.status} bytes=${response.headers.get('content-length') ?? '?'}`,
      );
    }
    return response;
  };
}

/**
 * The router app: every route family and every gate, in the order the chain
 * tried them, as one Hono app. `route` answers a request, or `undefined` when
 * a websocket took the connection over.
 */
function createRouter(ctx: HonoAppContext): (req: Request) => Promise<Response | undefined> {
  const { requireSignInToWrite, serveUpgradeAndStreamRoutes } = ctx;
  const app = new Hono<HonoRouterEnv>();
  /** Requests a socket took over. `route` hands Bun `undefined` for these. */
  const upgraded = new WeakSet<Request>();

  // ── The gates ── see routes/hono-gates.ts.
  // The preflight, the cross-origin write gates, the open families (the home
  // feed, the board import and the GitHub hub), admission, the local-only
  // gate, attribution and both sign-in gates, in that order. They run ONCE,
  // above every family: a `Response` is a gate's answer and nothing below
  // sees the request; otherwise `c.var` holds what they proved.
  for (const gate of honoGates(ctx)) app.use('*', gate);

  // Writers that see no request read who it proved from here, and the
  // families read the owner proof.
  app.use('*', async (c, next) => {
    const { gate, attribution } = c.var;
    setRequestAuthor(attribution.provenAuthor);
    /** A person proof naming the owner — never a body, a widget token or an
     *  agent token. Incoming Messages is shown to and moved by this alone
     *  (routes/inbox.ts). */
    c.set('ownerProven', (): boolean => {
      if (gate.visitor) return false;
      const proven = attribution.provenIdentityFor();
      return proven !== null && isOwnerActor({ id: proven.id });
    });
    await next();
    return undefined;
  });

  // ── The front app ── see routes/hono-front.ts and hono-families.ts.
  // Tried first among the families, with what the gates proved. It never
  // takes a websocket upgrade: the stream block below has to see every one.
  //
  // The sign-in, session and share routes (`auth-share.ts`) are the first
  // family it answers. They stay AFTER the host decision on purpose, so a
  // share visitor reaches them only if `shareScopeAllows` lets them, and it
  // does not: a share visitor is already proven by Cloudflare Access, and
  // sign-in is not a second way to claim an identity on a share host.
  //
  // Recall's status webhook is in it, and has to be tried before the
  // `/recall/` websocket upgrade in the stream block below, whose own test is
  // `startsWith('/recall/')` and would answer a status POST with the token
  // lookup's 404. The front is registered above that block, so it still is —
  // keep it that way.
  app.use('*', async (c, next) => {
    const { gate, attribution, ownerProven } = c.var;
    const fronted = await ctx.honoFront(c.req.raw, { gate, attribution, ownerProven });
    if (fronted) return fronted;
    await next();
    return undefined;
  });

  // ── Upgrade and stream ── see routes/upgrade-stream.ts.
  // Six blocks that end in a long-lived connection rather than a body: the
  // three websocket upgrades and the three SSE openers, below the front app
  // so the `/recall/` upgrade is still tried after Recall's status webhook.
  // A socket that took the connection over answers Hono with an empty
  // `Response` and is marked, and `route` hands Bun `undefined` for it:
  // `test/hono-upgrade-probe.test.ts` reads the raw bytes and shows Bun
  // writes nothing after the 101 either way, including for an app's socket,
  // which upgrades after an await. Null means no block there claimed this
  // address, and the request goes on.
  app.use('*', async (c, next) => {
    const req = c.req.raw;
    const url = new URL(req.url);
    const { gate, attribution, ownerProven } = c.var;
    const { visitor, visitorShareId, visitorMemberKey, widgetDoorGrant } = gate;
    const { widgetIdentity, provenIdentityFor, browserProvedNobody, provenAuthor } = attribution;
    const streamed = serveUpgradeAndStreamRoutes({
      req,
      url,
      pathname: url.pathname,
      visitor,
      visitorShareId,
      visitorMemberKey,
      accessEmail: gate.accessEmail,
      browserProvedNobody,
      provenAuthor,
      ownerProven,
      anyoneProven: () => provenIdentityFor() !== null,
      widgetDoorGrant,
      widgetTokenProved: widgetIdentity !== null,
      appMember: visitor && !gate.boardAgent ? (gate.visitorHome?.signedInAs ?? null) : null,
      personProof: provenIdentityFor,
      boardAgent: gate.boardAgent !== null && gate.boardAgent !== undefined,
    });
    if (!streamed) {
      await next();
      return undefined;
    }
    const settled = streamed.kind === 'dialing' ? await streamed.outcome : streamed;
    if (settled.kind === 'response') return settled.response;
    upgraded.add(req);
    return new Response(null);
  });

  // ── The board app ── `hono-board-families.ts` then `hono-tail-families.ts`.
  // Its first middleware is the workspace scope: below the stream block,
  // because a websocket upgrade and an SSE open are taken over rather than
  // answered, and above every REST handler, because no handler resolves a
  // board for itself. Then the board families in the old board run's order,
  // then the tail in its order.
  app.use('*', async (c, next) => {
    const { gate, attribution, ownerProven } = c.var;
    const mayMintAppVoice = (): boolean =>
      mayMintAppVoiceFor({
        visitor: gate.visitor !== null,
        ownerProven: ownerProven(),
        anyoneProven: attribution.provenIdentityFor() !== null,
        mustSignIn: requireSignInToWrite && attribution.browserProvedNobody(),
        frameGrant: gate.frameAppVoice,
      });
    const boarded = await ctx.honoBoardFront(c.req.raw, {
      gate,
      attribution,
      ownerProven,
      mayMintAppVoice,
    });
    if (boarded) return boarded;
    await next();
    return undefined;
  });

  // Nothing claimed the address: the bare 404 the chain always ended on.
  app.notFound(() => new Response('not found', { status: 404 }));
  // A throw reaches the Sentry span in `handleRequest` unchanged.
  app.onError((err) => {
    throw err;
  });

  return async (req) => {
    const res = await app.fetch(req);
    return upgraded.has(req) ? undefined : res;
  };
}

/**
 * Every docId a request might address, from anywhere in its URL.
 *
 * This used to be a list of five path prefixes, and the list was the bug: it
 * covered `/events/`, `/y/`, `/review/`, `/audio/` and `/mockup/` while the
 * canonical `/workspaces/<ws>/docs/<docId>` address and every `/api` route
 * that names a doc in its path went the unprewarmed way and hydrated on the
 * main thread. A prefix list also has to be maintained: a route added later
 * is silently uncovered, and nothing fails until a bound file stops
 * answering.
 *
 * So this walks the path instead of matching the front of it. Every segment
 * that could be a docId is offered to the prewarm, which looks each one up in
 * the doc index and does nothing for the ones it does not know — so a
 * workspace slug or a verb like `archive` costs a Map lookup and no syscall.
 * Being liberal here is safe in exactly the way being conservative was not:
 * an extra candidate reads a file the request was likely to read anyway, a
 * missing one puts a blocking read back on the main thread.
 *
 * There is no body-reading companion to this, and there was briefly: a
 * function that pulled `docId` out of a JSON body for the routes that address
 * a doc there rather than in the URL. It could never run. `isValidDocId`
 * accepts any ordinary URL-safe word, so `api` and `docs` are candidates and
 * the list this returns is empty only for `/` itself. Those body-addressed
 * routes are the bind and attach pair, and they are covered where it
 * actually holds — they call `attachFileAsync`, which does its own pooled
 * read before it touches the doc.
 */
function docIdsAddressedBy(url: URL, isValidDocId: (s: string) => boolean): string[] {
  const found: string[] = [];
  const add = (raw: string | null | undefined): void => {
    if (!raw) return;
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return;
    }
    // `/mockup/<docId>.html` is the one address that carries an extension.
    const bare = decoded.replace(/\.html?$/i, '');
    if (!isValidDocId(bare) || found.includes(bare)) return;
    found.push(bare);
  };
  for (const segment of url.pathname.split('/')) add(segment);
  add(url.searchParams.get('docId'));
  return found;
}
