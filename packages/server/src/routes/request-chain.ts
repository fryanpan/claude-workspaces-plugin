/**
 * ── The request chain: every request, in the order it is tried ──
 *
 * `createServer` composes; this answers. It used to be `handleRequest` and
 * its inner `route()` inside `createServer`, and it moved whole: the front
 * door (the bad-path refusal, the hydration prewarm, the Sentry span,
 * compression, CORS and the slow-request line), then the gates in the order
 * they must run — the CORS preflight, the cross-origin write gate, the home
 * feed, admission, the local-only gate, attribution, the sign-in write gate,
 * the sign-in and share routes, the two vendor callbacks, the upgrades and
 * streams, and the workspace scope — and then the two halves below them:
 * the board and REST families (`request-chain-board.ts`) and the top-level
 * families with the tail (`request-chain-tail.ts`).
 *
 * The order is behaviour. Every comment below that says a position is
 * load-bearing says so about the order of these calls, which is why they
 * moved as a run rather than being sorted into the route table: see
 * `route-table.ts` for the eight adjacencies Bun's specificity matching would
 * not keep.
 *
 * Everything the chain reads is long-lived and arrives once, as
 * `RequestChainContext`. The only substitution in the moved lines is the peer
 * address: `server.requestIP(req)?.address` is `requestAddress(req)` here,
 * because this module cannot hold `Bun.serve`'s return value.
 */
import { isOwnerActor } from '../actor-identity.ts';
import { LOCAL_ONLY_REFUSAL, addressesLocalOnlySet, isOnBox } from '../attachment-privacy.ts';
import { maybeCompress, maybeNotModified } from '../compress.ts';
import { isAllowedBrowserOrigin } from '../middleware/browser-origin.ts';
import {
  type WorkspaceScope,
  memberAddressed,
  resolveWorkspaceScope,
} from '../middleware/workspace-scope.ts';
import { isGatedWrite, signInRequiredBody } from '../middleware/write-gate.ts';
import { malformedPathSegment } from '../path-params.ts';
import { captureServerError, routePatternForSpan, withRouteSpan } from '../sentry.ts';
import { renderBoardMemberNotFound, renderBoardNotFound } from '../shells.ts';
import type { BoardWorkspace } from '../tasks.ts';
import { matchWorkspaceRoute } from '../workspace-path.ts';
import { handleAuthShareRoutes } from './auth-share.ts';
import { handleHomeFeedRoute } from './home-feed.ts';
import { handleRecallWebhookRoute } from './recall-webhook.ts';
import { serveBoardRoutes } from './request-chain-board.ts';
import type { RequestChainContext } from './request-chain-context.ts';
import { serveTopLevelRoutes } from './request-chain-tail.ts';
import { handleVoiceAgentLlmRoute } from './voice-agent-llm.ts';

/**
 * The handler `Bun.serve` dispatches every request to, through the
 * `handleWithOrigin` wrapper in `createServer`. `undefined` means the request
 * became a websocket.
 */
export function createRequestChain(
  ctx: RequestChainContext,
): (req: Request) => Promise<Response | undefined> {
  const {
    docStore,
    applyCors,
    refreshSession,
    slowRequestMs,
    policyFor,
    isValidDocId,
    j,
    requestAddress,
    homeFeedCtx,
    admit,
    localOnlyGate,
    attributeRequest,
    requireSignInToWrite,
    authShareRoutesCtx,
    voiceAgentLlmRoutesCtx,
    recallWebhookRoutesCtx,
    serveUpgradeAndStreamRoutes,
    taskStore,
    workspacesOfMember,
  } = ctx;

  /**
   * A folder member a link names before anybody opened it becomes its doc.
   * Only for a set filed on the board in the path; `openListedMember` opens
   * only what the set's listing holds, so this reaches what `context-file`
   * does and nothing more. A local-only set's member is not opened for a
   * caller off the box, whom the gate below refuses anyway.
   */
  async function openUnopenedMember(req: Request, pathname: string): Promise<void> {
    const match = matchWorkspaceRoute(pathname);
    const member = match ? memberAddressed(match.rest) : undefined;
    if (!match || member?.collection !== 'docs') return;
    const id = member.memberId;
    const cut = id.indexOf(':');
    if (cut <= 0 || docStore.docExists(id)) return;
    const setId = id.slice(0, cut);
    if (!workspacesOfMember('attachments', setId).includes(match.workspaceId)) return;
    if (
      localOnlyGate.isLocalOnlySet(setId) &&
      !isOnBox(req.headers, requestAddress(req) ?? undefined)
    )
      return;
    await docStore.openListedMember(id);
  }

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
    const response = applyCors(
      req,
      refreshSession(req, await maybeCompress(req, maybeNotModified(req, routed))),
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

    async function route(req: Request): Promise<Response | undefined> {
      const url = new URL(req.url);
      const { pathname } = url;

      // --- CORS preflight ---
      // The canonical embed loads the widget bundle from this server but
      // runs on a different origin (e.g. an Astro dev server on :4321).
      // Every REST call from the widget is therefore cross-origin and
      // browsers preflight non-simple requests (POST + JSON body) with an
      // OPTIONS. Reply once here so we don't have to thread the response
      // through every route handler.
      // The wrapper above attaches the CORS headers when the origin is
      // allowed. A disallowed origin gets a bare 204 with no
      // Access-Control-Allow-* — which is exactly how the browser learns no.
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204 });
      }

      // --- Cross-origin WRITE gate ---
      // Withholding CORS headers only hides the RESPONSE. A "simple request"
      // — POST with content-type text/plain — is never preflighted, so the
      // browser sends it and the write lands; the page just can't read the
      // reply. safeJson() parses the body whatever the content-type says, so
      // that was a working CSRF write: post comments as someone else, or
      // create a doc bound to any file on the machine.
      //
      // GET stays open on purpose. Its response is already withheld by CORS,
      // and refusing it would break <script>/<img>-style loads of the widget
      // bundle from arbitrary dev sites (those send no Origin at all).
      if (
        req.method !== 'GET' &&
        req.method !== 'HEAD' &&
        !isAllowedBrowserOrigin(req.headers.get('origin'), policyFor(req))
      ) {
        return j(403, { error: 'origin_not_allowed' });
      }

      // ── The home feed ── see routes/home-feed.ts. ABOVE admission, with a
      // gate of its own: its one remote caller is a service token, which
      // names nobody, and admission refuses a stamp that names nobody.
      const homeFeed = await handleHomeFeedRoute(homeFeedCtx, req, pathname);
      if (homeFeed) return homeFeed;

      // ── Request admission ── see request-admission.ts.
      // The gate ANSWERS this request or hands back what it proved. A
      // refused answer carries no per-request value with it, so nothing
      // below can read a visitor off a request that never got in — the
      // union is what makes that a compile error rather than a review note.
      const gate = await admit(req, { pathname });
      if (!gate.admitted) return gate.response;
      // Below admission, so only a caller the set is open to reaches it, and
      // ABOVE the local-only gate and the upgrades, which then judge the doc
      // the member became rather than an id nothing holds.
      await openUnopenedMember(req, pathname);
      // A local-only attachment set's files stay on this machine. Here,
      // below admission and ABOVE the upgrades, because a socket is
      // authorized once at open and a gate below it would never see one.
      if (
        !isOnBox(req.headers, requestAddress(req) ?? undefined) &&
        addressesLocalOnlySet(pathname, localOnlyGate)
      ) {
        return j(403, LOCAL_ONLY_REFUSAL);
      }
      const { visitor, visitorShareId, visitorMemberKey, widgetDoorGrant } = gate;

      // --- REST: email login ---
      // Reachability (the host gate, Access, a share session) and identity
      // (who you are) stay orthogonal: a local host still bypasses the host
      // guard — it may REACH the server — and still has to say who it is.
      // These routes are what "saying who you are" means.
      //
      // They sit AFTER the host decision on purpose, so a share visitor
      // reaches them only if `shareScopeAllows` lets them, and it does not:
      // a share visitor is already proven by Cloudflare Access, and this is
      // not a second way to claim an identity on a share host.
      // ── Request attribution ── see request-attribution.ts.
      // Chained after admission rather than composed beside it, because its
      // input is what the gate just proved. Called from the position the
      // widget-token gate held — that gate lives inside, and its 401 has to
      // land exactly here. `attributed: false` carries no helpers at all, so
      // no route can name an author on a request whose token was refused.
      const attribution = attributeRequest(req, gate);
      if (!attribution.attributed) return attribution.response;
      const {
        widgetIdentity,
        provenIdentityFor,
        accessIdentityFor,
        browserProvedNobody,
        provenAuthor,
      } = attribution;
      /** A person proof naming the owner — never a body, a widget token or
       *  an agent token. Incoming Messages is shown to and moved by this
       *  alone (routes/inbox.ts). */
      const ownerProven = (): boolean => {
        if (visitor) return false;
        const proven = provenIdentityFor();
        return proven !== null && isOwnerActor({ id: proven.id });
      };

      // --- Sign-in write gate ---
      // Every ordinary write — a comment, a task edit, a review answer, a
      // doc bind — passes through here, because every one of them is a
      // non-GET and every route on this server lives below this line. The
      // predicate is method-keyed rather than a route list on purpose: a
      // list is a thing that silently stops being complete.
      //
      // Reads are untouched, agents are untouched (see write-gate.ts for
      // what tells them apart and what that boundary is worth), and the
      // refusal carries the URL that fixes it — a bare 401 is
      // indistinguishable from a bug, and the client turns this body into
      // a sign-in prompt.
      //
      // Order: below the widget-token gate so a valid token counts as
      // proof, and below the host/Access gates so an Access visitor's
      // verified email is already in hand.
      if (requireSignInToWrite && isGatedWrite(req.method, pathname) && browserProvedNobody()) {
        return j(401, signInRequiredBody());
      }

      // --- Sign-in, session and share links (routes/auth-share.ts) ---
      // Extracted whole and called from the position the block occupied, so
      // nothing above or below it overtakes anything. See that file's header
      // for the two places the order inside it is load-bearing.
      {
        const handled = await handleAuthShareRoutes(authShareRoutesCtx, {
          req,
          url,
          pathname,
          widgetIdentity,
          browserProvedNobody,
          provenIdentityFor,
          accessIdentityFor,
        });
        if (handled) return handled;
      }

      // --- ElevenLabs' agent asking for setup 4's reply --- see
      // ./routes/voice-agent-llm.ts. It answers one exact path, so where it
      // sits changes nothing; it is beside Recall's webhook because both are
      // a vendor's backend calling in on the callback hostname.
      {
        const handled = await handleVoiceAgentLlmRoute(voiceAgentLlmRoutesCtx, {
          req,
          pathname,
          shareVisitor: visitor !== null,
        });
        if (handled) return handled;
      }

      // --- Recall's bot status-change webhook --- see
      // ./routes/recall-webhook.ts. Called from the position the block
      // held: it must stay IMMEDIATELY above the `/recall/` websocket
      // upgrade below, because that upgrade's own test is
      // `startsWith('/recall/')` and would answer a status POST with the
      // token lookup's 404. That adjacency is behaviour — keep these two
      // adjacent.
      {
        const handled = await handleRecallWebhookRoute(recallWebhookRoutesCtx, {
          req,
          pathname,
        });
        if (handled) return handled;
      }

      // ── Upgrade and stream ── see routes/upgrade-stream.ts.
      // Six blocks that end in a long-lived connection rather than a body:
      // the three websocket upgrades and the three SSE openers. Called from
      // the position the run held, so the `/recall/` upgrade still sits
      // IMMEDIATELY below the status webhook above it — that adjacency is
      // load-bearing and the comment on the webhook says why. Null means no
      // block there claimed this address, which is the same fall-through the
      // run did in place; `upgraded` is the one outcome that must reach Bun
      // as `undefined`, and this is the only place that spells it.
      const streamed = serveUpgradeAndStreamRoutes({
        req,
        url,
        pathname,
        visitor,
        visitorShareId,
        visitorMemberKey,
        browserProvedNobody,
        provenAuthor,
        ownerProven,
        widgetDoorGrant,
      });
      if (streamed) {
        if (streamed.kind === 'upgraded') return undefined;
        return streamed.response;
      }

      // ── The workspace scope ── see middleware/workspace-scope.ts.
      //
      // ONE resolver for every canonical `/workspaces/<id>/…` request, run
      // once here rather than at the top of each handler. It answers two
      // questions and refuses on either: does this board exist, and does the
      // row named under it belong to it. That second question only became
      // askable when the board went into the path — `/api/goals/<id>` named
      // a row and left the server to find its board, so "a goal on somebody
      // else's board" was not a shape a request could have.
      //
      // Placed BELOW the stream block, because a websocket upgrade and an
      // SSE open are taken over rather than answered, and ABOVE every REST
      // handler, because the whole point is that no handler resolves a board
      // for itself. Whether the CALLER may reach the board is not asked here
      // — `shareScopeAllows` in the host guard has already answered it, and
      // a second copy of that rule is the thing this file exists to remove.
      //
      // `pass` means the path is not its business: not under `/workspaces/`,
      // or one of the board's HTML pages, which the shell at the tail of the
      // chain serves with its own not-found.
      //
      // What it hands DOWN is the other half. `scope` travels on every
      // resource route's request and is what those routes match against —
      // see `matchRest`. A handler with no scope has no remainder to match,
      // so "the workspace was resolved" stops being something each route
      // remembers to check and becomes the condition of it answering at
      // all.
      let scope: WorkspaceScope<BoardWorkspace> | undefined;
      {
        const scoped = resolveWorkspaceScope(
          {
            workspaceRecord: (id: string) => taskStore.getWorkspace(id),
            workspacesOfMember,
            j,
            // A browser asked for a page; answer it with one — naming the
            // board it can go back to, which is the whole difference between
            // a dead end and a wrong turn. Unless the BOARD is what is
            // missing, in which case there is nowhere on it to go and the
            // board's own not-found page is the honest answer: offering to
            // open a board that does not exist is a second dead end.
            notFoundPage: (address) =>
              new Response(
                address.boardExists
                  ? renderBoardMemberNotFound(address.workspaceId, address.rest)
                  : renderBoardNotFound(address.workspaceId),
                { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
              ),
          },
          { pathname, method: req.method, url, accept: req.headers.get('accept') },
        );
        if (scoped.kind === 'refused') return scoped.response;
        if (scoped.kind === 'scope') scope = scoped.scope;
      }

      // ── Below the scope ── the board and REST families, then the
      // top-level families and the tail, in that order and in the order
      // each file lists them. `null` from the first means nothing there
      // claimed the address; the second always answers.
      const rq = { req, url, pathname, scope, gate, attribution, ownerProven };
      return (await serveBoardRoutes(ctx, rq)) ?? (await serveTopLevelRoutes(ctx, rq));
    }
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
