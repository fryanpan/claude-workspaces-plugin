import type { MiddlewareHandler } from 'hono';
/**
 * ── The gates: everything that decides whether a request gets in ──
 *
 * The router app's first middleware (`hono-app.ts`), in the order the chain
 * ran them: the CORS preflight, the cross-origin write gates, the home feed,
 * the board import and the GitHub hub (each above admission with its own
 * caller check, answered by the open Hono app, `hono-open-families.ts`),
 * admission with the unopened folder member and the local-only gate,
 * attribution, the sign-in write gate and the fresh sign-in check.
 *
 * A gate that answers returns its `Response` and nothing registered after it
 * sees the request. Admission and attribution put what they proved in
 * `c.var`, and every app below reads that one result, so admission and share
 * scoping run once per request whichever family answers. The checks
 * themselves moved byte-identical; what changed is that each is a middleware
 * that calls `next()` instead of a line in one function that falls through.
 */
import { LOCAL_ONLY_REFUSAL, addressesLocalOnlySet, isOnBox } from '../attachment-privacy.ts';
import type { HonoRouterEnv } from '../hono-env.ts';
import {
  crossOriginCredentialedWrite,
  isAllowedBrowserOrigin,
} from '../middleware/browser-origin.ts';
import { memberAddressed } from '../middleware/workspace-scope.ts';
import { isGatedWrite, signInRequiredBody } from '../middleware/write-gate.ts';
import { matchWorkspaceRoute } from '../workspace-path.ts';
import type { HonoAppContext } from './hono-app-context.ts';

/**
 * The gates, in order, as middleware for the router app (`hono-app.ts`). A
 * gate that answers returns its `Response`, and nothing registered after it
 * sees the request. Admission and attribution put what they proved in
 * `c.var` (`gate`, `attribution`) for everything below them.
 */
export function honoGates(ctx: HonoAppContext): MiddlewareHandler<HonoRouterEnv>[] {
  const {
    docStore,
    policyFor,
    j,
    requestAddress,
    honoOpenFront,
    admit,
    localOnlyGate,
    attributeRequest,
    requireSignInToWrite,
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

  return [
    async (c, next) => {
      const req = c.req.raw;
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
      await next();
      return undefined;
    },
    async (c, next) => {
      const req = c.req.raw;
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
      // An allowed origin that is not this server's own may write only
      // without the reader's credentials — `crossOriginCredentialedWrite`.
      if (crossOriginCredentialedWrite(req.method, req.headers, policyFor(req))) {
        return j(403, {
          error: 'cross_origin_credentials',
          message:
            'A page on another origin may not write with your sign-in. Use this server’s own pages.',
        });
      }
      await next();
      return undefined;
    },
    async (c, next) => {
      const req = c.req.raw;
      // ── Home feed, board import, GitHub hub ── ABOVE admission, own gates: callers name nobody.
      // The open Hono app (`hono-open-families.ts`), tried at this position.
      const above = await honoOpenFront(req, {});
      if (above) return above;
      await next();
      return undefined;
    },
    async (c, next) => {
      const req = c.req.raw;
      const pathname = new URL(req.url).pathname;
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
      c.set('gate', gate);
      await next();
      return undefined;
    },
    async (c, next) => {
      const req = c.req.raw;
      // ── Request attribution ── see request-attribution.ts.
      // Chained after admission rather than composed beside it, because its
      // input is what the gate just proved. Called from the position the
      // widget-token gate held — that gate lives inside, and its 401 has to
      // land exactly here. `attributed: false` carries no helpers at all, so
      // no route can name an author on a request whose token was refused.
      const attribution = attributeRequest(req, c.var.gate);
      if (!attribution.attributed) return attribution.response;
      c.set('attribution', attribution);
      await next();
      return undefined;
    },
    async (c, next) => {
      const req = c.req.raw;
      const pathname = new URL(req.url).pathname;
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
      if (
        requireSignInToWrite &&
        isGatedWrite(req.method, pathname) &&
        c.var.attribution.browserProvedNobody()
      ) {
        return j(401, signInRequiredBody());
      }
      await next();
      return undefined;
    },
    async (c, next) => {
      const req = c.req.raw;
      const pathname = new URL(req.url).pathname;
      // --- Fresh sign-in for a person's destructive action --- (fresh-signin.ts)
      // Above every route it guards; below the gates that proved the person.
      const staleSignIn = await ctx.freshSignInGate(
        req,
        pathname,
        c.var.gate,
        c.var.attribution.widgetIdentity,
      );
      if (staleSignIn) return staleSignIn;
      await next();
      return undefined;
    },
  ];
}
