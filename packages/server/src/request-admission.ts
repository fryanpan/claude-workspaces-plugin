/**
 * ── Request admission: may this request reach this server at all, and as whom ──
 *
 * The first thing that happens to every request and the last line of defence
 * in front of everything else: the default-deny host gate, the auth branch
 * its decision selects, the external-access master switch, and the scoping
 * that turns an admitted outsider into a `visitor`. Plus the origin policy
 * the CORS layer and the cross-origin write gate both read, because "may a
 * page at this origin talk to us" is the same question one layer out.
 *
 * ── Why the result is a discriminated union ──
 *
 * This family differs from `board-membership.ts`, `stall-wiring.ts` and
 * `home-pane.ts` by one property that governs its whole shape: it is
 * PER-REQUEST, not a set of long-lived closures. It cannot be a factory of
 * values, so it has to hand something back — and the obvious something, a
 * record of `{ response?, visitor, accessEmail }`, is the bug this shape
 * exists to prevent. A caller can read `visitor` off a record whose
 * `response` it forgot to check, on a path the gate meant to refuse. That is
 * exactly the hazard the exceptions row predicted when it named this seam.
 *
 * So: `{ admitted: false, response }` carries NO per-request values, and
 * `{ admitted: true, … }` carries every one of them. TypeScript will not let
 * `gate.visitor` be read until `gate.admitted` has been checked, so the
 * refused path cannot leak a value by omission rather than by decision.
 *
 * `admitted: false` means "the gate has answered this request", not "denied".
 * The share-link redeem route lives inside the gate — it is the one path on
 * that hostname a non-member may reach — and its 200 comes back the same way
 * a 403 does, because both end the request here.
 *
 * ── Why TWO factories ──
 *
 * `policyFor` is an INPUT to `createIdentitySetup`, and that setup's
 * `accessOnlyBrowserHosts` is an INPUT to the host gate. No single
 * composition point sits on both sides of that, so the origin policy is
 * built where it is needed first and passed into the admission factory
 * built after. One module because they are one subject; two calls because
 * the identity setup genuinely sits between them.
 */
import { normalizeEmail } from '@claude-workspaces/core';
import type { DocMeta } from '@claude-workspaces/core';
import { type BoardAgentClaims, boardAgentBearerOf } from './auth/board-agent-token.ts';
import { type FrameHost, frameGate, frameGateRefusal } from './frame-host.ts';
import { memberBoards, memberHomeResponse, notAMemberResponse, wantsPage } from './member-home.ts';
import { admitBoardAgent } from './middleware/board-agent-door.ts';
import { LOOPBACK_HOSTS, type OriginPolicy, corsHeadersFor } from './middleware/browser-origin.ts';
import type { CfAccessVerifier } from './middleware/cf-access.ts';
import {
  type ShareTarget,
  classifyHost,
  collabScope,
  isLoopbackAddress,
  isProxiedTrustedHost,
  isTrustedLocalHost,
  shareScopeAllows,
} from './middleware/host-guard.ts';
import { recallCallbackAllows } from './middleware/recall-callback-gate.ts';
import { widgetDoorRoute, widgetDoorSignInBody } from './middleware/widget-door.ts';
import { localHostnames } from './public-host.ts';
import { type BoardRole } from './share/board-role.ts';
import { collabMemberKey } from './share/collab-member-key.ts';
import { redactMetaForVisitor, relativeReviewUrl } from './share/redact-meta.ts';
import { shareMemberKey } from './share/share-links.ts';
import type { Shares } from './share/shares.ts';
import type { SharingGate } from './share/sharing-gate.ts';
import type { Share } from './share/types.ts';
import type { BoardWorkspace } from './tasks.ts';

/** The two `ServerOptions` fields the origin policy reads. */
export interface OriginPolicyOptions {
  trustedHosts?: string[];
  allowedOrigins?: string[];
}

/** What the origin policy needs. Built before `createIdentitySetup`, which
 *  takes `policyFor` as one of its own inputs — see the note at the top. */
export interface OriginPolicyContext {
  opts: OriginPolicyOptions;
  /** The operator's own proxied hostnames, and the verifier that proves one
   *  is really Access-fronted. Both are what separate "our own surface" from
   *  "the operator's public door" for origin purposes. */
  proxiedTrustedHosts: string[];
  proxiedTrustedVerifier: CfAccessVerifier | null;
  /** The tailnet widget door's hostnames. A page on one embeds the widget, so
   *  for origin purposes the door is this machine's own surface. A thunk: the
   *  tailnet name is discovered at runtime and can arrive after boot. */
  widgetDoorHosts: () => readonly string[];
}

export function createOriginPolicy(ctx: OriginPolicyContext): {
  policyFor: (req: Request) => OriginPolicy;
  applyCors: (req: Request, res: Response) => Response;
} {
  const { opts, proxiedTrustedHosts, proxiedTrustedVerifier, widgetDoorHosts } = ctx;

  /**
   * CORS is decided once, here, for every response the handler produces,
   * rather than by `j()` — which has no request context and used to stamp
   * `Access-Control-Allow-Origin: *` on everything. See
   * middleware/browser-origin.ts for why that wildcard was a hole.
   */
  /**
   * The origin policy for a request. `localHostnames` mirrors the host gate's
   * own notion of "this machine", so a dev server reached over the tailnet or
   * the LAN — not just loopback — can still embed the widget.
   */
  const policyFor = (req: Request) => {
    // Scheme matters (http://x and https://x are different browser origins),
    // and behind cloudflared the socket is plain http while the browser is on
    // https — so trust the forwarded scheme when the proxy sets one.
    // ALLOWLISTED, not interpolated. This value is concatenated into a URL
    // string, so an unvalidated one rewrites the origin we compare against:
    // `x-forwarded-proto: https://evil.example.com#` makes
    // `new URL('https://evil.example.com#://feedback.example.com').origin`
    // the ATTACKER's origin, originMatch returns 'same-origin', and on the
    // share host — where same-origin is the only rule left — that is the
    // whole boundary gone. A proxy appending to an existing header
    // (`https://evil.example.com#, https`) does it too.
    //
    // Note the asymmetry this fixes: host-guard requires `cf-ray` before it
    // believes a proxy claim, while this trusted a bare header.
    const forwarded = req.headers.get('x-forwarded-proto');
    const scheme =
      forwarded === 'http' || forwarded === 'https'
        ? forwarded
        : new URL(req.url).protocol.replace(':', '');
    const host = req.headers.get('host') ?? '';
    // The dev-server allowances belong to the LOCAL surface, where nothing is
    // cookie-authenticated. A share host is not that: the visitor carries a
    // SameSite=Lax session cookie, and websockets ignore CORS entirely — so an
    // allowed origin that happened to be same-SITE with the share host would
    // carry that cookie into /y/<docId> and act as a logged-in visitor. A
    // share visitor loads the app FROM the share host, so same-origin is all
    // they ever need, and it's all they get.
    // Cached (60s TTL) — tailscaleHost() shells out, and this runs on every
    // write and every websocket handshake.
    // The door's names are this machine's names — in production the tailnet
    // name is already among `localHostnames()`, and a door named explicitly
    // (a test, or a deployment whose MagicDNS lookup failed) must read the
    // same, or its own page's comment would be refused by the cross-origin
    // write gate before the door ever saw it.
    const ourNames = [...localHostnames(), ...widgetDoorHosts()];
    const viaProxy = req.headers.has('cf-ray');
    const isLocalSurface = isTrustedLocalHost(host, {
      lanHosts: ourNames,
      extraHosts: opts.trustedHosts ?? [],
      viaProxy,
    });
    // The operator's own proxied hostname serves the same product, but it is
    // NOT the local surface for origin purposes. Through the tunnel the
    // browser's `localhost` is the VISITOR'S machine, and a LAN name resolves
    // on the visitor's network, so every allowance that makes sense for a
    // TRUSTED_HOSTS name — loopback, LAN names, any port on our own names —
    // would here trust a page the operator merely has open. Same-origin plus
    // the origins the operator configured by name, nothing else. (The
    // configured ones are the one deliberate cross-origin grant, and they
    // are the operator's own call.)
    const isProxiedLocal = isProxiedTrustedHost(host, {
      viaProxy,
      proxiedTrustedHosts,
      accessFronted: proxiedTrustedVerifier !== null,
    });
    return {
      // Canonicalized, not concatenated. A proxy may forward Host with an
      // explicit default port (`feedback.example.com:443`) while the browser
      // sends `Origin: https://feedback.example.com` — a raw string compare
      // would then treat every legitimate request on the share host as
      // foreign and 403 its websocket. URL.origin drops the default port.
      requestOrigin: canonicalOrigin(scheme, host),
      localHostnames: isLocalSurface
        ? [...LOOPBACK_HOSTS, ...ourNames, ...(opts.trustedHosts ?? [])].filter((h) => h !== '')
        : [],
      allowedOrigins: isLocalSurface || isProxiedLocal ? (opts.allowedOrigins ?? []) : [],
    };
  };
  const applyCors = (req: Request, res: Response): Response => {
    const headers = corsHeadersFor(req.headers.get('origin'), policyFor(req));
    if (!headers) return res;
    // Set on the route's own Response, never re-wrapped: `new Response(res.body)`
    // turns a sized body (a file, a file slice) into a stream, which Bun sends
    // chunked, and for a sliced file sends past the slice's end. Safari will
    // not play a 206 that arrives chunked. Bun's Response headers are
    // mutable, even on a `fetch` result.
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  };

  return { policyFor, applyCors };
}

/** The `ServerOptions` fields the gate itself reads. */
export interface RequestAdmissionOptions {
  trustedHosts?: string[];
  meetingBotWebhookSecret?: string;
  /** Setup 4 is configured when `agent` is set — the callback host then
   *  admits its custom-LLM route. */
  spokenReply?: { agent?: object | null };
}

/** What the gate reads. Everything here is long-lived; the request and the
 *  path it addresses arrive per call. */
export interface RequestAdmissionContext {
  opts: RequestAdmissionOptions;
  /** The JSON responder, so a refusal here is spelled exactly as a route's. */
  j: (status: number, body: unknown) => Response;
  /** The sharing registry and the master switch in front of it. */
  shares: Shares | null;
  sharingGate: SharingGate;
  /** A share's target, or null when its workspace is not a board. */
  boardShareTarget: (share: Share | null | undefined) => ShareTarget | null;
  /** The four Access verifiers, one per door. Null means "not configured",
   *  which every branch below re-checks — "I could not verify" must never
   *  mean "serve it". */
  cfAccessVerifier: CfAccessVerifier | null;
  staticAccessVerifier: CfAccessVerifier | null;
  collabAccessVerifier: CfAccessVerifier | null;
  shareLinkVerifier: CfAccessVerifier | null;
  proxiedTrustedVerifier: CfAccessVerifier | null;
  /** The hostnames each door answers on. */
  accessTunnelHosts: string[];
  proxiedTrustedHosts: string[];
  shareLinkHosts: string[];
  recallCallbackHost: string | null;
  /** Whether Access fronts every browser-facing hostname (rule 3 in
   *  host-guard). From the identity setup — the reason this factory is
   *  built after it rather than beside the origin policy. */
  accessOnlyBrowserHosts: boolean;
  /** WHO may come through the operator's own proxied hostname. */
  proxiedTrustedEmails: Set<string>;
  /** Membership, scoping and redemption, from `board-membership.ts`. */
  shareWorkspacesOf: (rawId: string) => string[];
  collabMemberOf: (workspaceId: string, email: string | null) => boolean;
  shareLinkMemberOf: (workspaceId: string, email: string | null) => boolean;
  redeemShareLink: (linkId: string, email: string | null) => Response;
  /** What a caller may DO on a board — `board-membership.ts`'s one reading. */
  boardRoleOf: (workspaceId: string, email: string | null, isVisitor: boolean) => BoardRole;
  /** Every board on this server, for a member's list at `/`. */
  listBoards: () => readonly BoardWorkspace[];
  /** One path segment, decoded without throwing on a bad escape. */
  safeDecodeSegment: (s: string) => string;
  /** Doc metadata decorated with its review URL, before redaction. */
  withReviewUrl: <T extends DocMeta>(meta: T) => T & { reviewUrl?: string };
  /** Whether the meeting relay is wired, for the recall callback allowlist. */
  recallRelay: { configured: () => boolean };
  /** The tailnet widget door's hostnames (a thunk, see `OriginPolicyContext`). */
  widgetDoorHosts: () => readonly string[];
  /** Where a door visitor signs in — the operator's public Access origin — or
   *  null when this deployment has none, which leaves the door unusable
   *  rather than pointing the popup somewhere wrong. */
  widgetSignInOrigin: string | null;
  /** The widget token a request presents (header or socket subprotocol). */
  widgetBearerOf: (req: Request) => string | null;
  /** What a board widget token grants, after every liveness check. */
  boardWidgetGrantFor: (
    raw: string,
    origin: string | null,
  ) => { identity: { id: string }; workspaceId: string; sessionBound: boolean } | null;
  /** A doc's type, or undefined for a doc this server does not hold. */
  docTypeOf: (docId: string) => string | undefined;
  /** The peer address of a request. A forward reference on purpose: the Bun
   *  server is bound below this factory and is only ever asked per request. */
  requestAddress: (req: Request) => string | undefined;
  /** The frame-only hostname (`frame-host.ts`), or null when not configured. */
  frameHost: FrameHost | null;
  /** What a board agent token still grants (`auth/board-agent-token.ts`). */
  boardAgentGrantFor: (bearer: string) => BoardAgentClaims | null;
}

/** Doc metadata as one caller may see it — the full record on the tailnet,
 *  an allowlisted subset for a share visitor. */
export type MetaForVisitor = <T extends DocMeta>(meta: T) => Record<string, unknown>;

/**
 * What the gate decided. `admitted: false` means it ANSWERED the request —
 * a refusal, or the share-link redeem page — and carries no per-request
 * value with it, so nothing below can read a visitor off a request that
 * never got in.
 */
export type Admission =
  | { admitted: false; response: Response }
  | {
      admitted: true;
      /** Non-null when this request came from a SHARE visitor (either mode).
       *  Everything downstream treats it as "untrusted outsider". */
      visitor: ShareTarget | null;
      /** The share that authorized this request, stamped onto any websocket
       *  it upgrades so revocation can find and close it later. */
      visitorShareId: string | null;
      /** The MEMBERSHIP that authorized it, on the share or collaboration
       *  hostname (`shareMemberKey` / `collabMemberKey`). */
      visitorMemberKey: string | null;
      /** The email Cloudflare Access verified for this request, if any. */
      accessEmail: string | null;
      /**
       * Set when a MEMBER came in through a door that lists their boards at
       * `/` — the share, collaboration or main hostname — carrying the address
       * Access verified. The board shell reads it to paint the way back to
       * that list and who is signed in. Null for the owner, a local caller,
       * and a per-share hostname, which has no list above its one board.
       */
      visitorHome: { signedInAs: string } | null;
      /**
       * The board token and page origin a request came through the tailnet
       * widget door with, or null for every other request. Read by the doc
       * socket's upgrade, which opens a door socket READ-ONLY — the widget
       * never writes the doc over it (its comments are REST posts), so a token
       * lifted from a page's storage gets no editing socket — and stamps the
       * pair on it, so the sweep can hang up once the token stops verifying.
       */
      widgetDoorGrant: { token: string; origin: string } | null;
      /**
       * The agent and board an `at2` bearer proved, or null. Set together
       * with `visitor` (that board), so every visitor rule applies; read by
       * attribution, which writes as that agent, and by the watch-set route,
       * which serves it that board's watches only.
       */
      boardAgent: BoardAgentClaims | null;
      /** Doc metadata as this caller may see it. */
      metaFor: MetaForVisitor;
      /**
       * What this caller may DO on a board — `owner` or `member`.
       *
       * On the admitted branch beside `visitor` rather than resolved by each
       * route, for the reason the union itself exists: the two inputs to the
       * answer (is this an outsider, and which email did Access prove) are
       * both per-request values the gate has just settled, and a route that
       * re-derived either would be a second rule free to drift open.
       */
      roleFor: (workspaceId: string) => BoardRole;
      /**
       * The owner gate: `null` when this caller is the board's owner, and the
       * 403 otherwise.
       *
       * A function that RETURNS THE REFUSAL rather than a boolean, so the
       * calling shape is `const denied = requireOwner(id); if (denied) return
       * denied;` — a role that was read and not acted on does not type-check
       * into anything useful, and the refusal is spelled once instead of at
       * every site.
       */
      requireOwner: (workspaceId: string) => Response | null;
    };

export interface RequestAdmission {
  admit: (req: Request, addressed: { pathname: string }) => Promise<Admission>;
}

export function createRequestAdmission(ctx: RequestAdmissionContext): RequestAdmission {
  const {
    opts,
    j,
    shares,
    sharingGate,
    boardShareTarget,
    cfAccessVerifier,
    staticAccessVerifier,
    collabAccessVerifier,
    shareLinkVerifier,
    proxiedTrustedVerifier,
    accessTunnelHosts,
    proxiedTrustedHosts,
    shareLinkHosts,
    recallCallbackHost,
    accessOnlyBrowserHosts,
    proxiedTrustedEmails,
    shareWorkspacesOf,
    collabMemberOf,
    shareLinkMemberOf,
    redeemShareLink,
    boardRoleOf,
    listBoards,
    safeDecodeSegment,
    withReviewUrl,
    recallRelay,
    requestAddress,
    widgetDoorHosts,
    widgetSignInOrigin,
    widgetBearerOf,
    boardWidgetGrantFor,
    docTypeOf,
    frameHost,
    boardAgentGrantFor,
  } = ctx;

  const admit = async (req: Request, addressed: { pathname: string }): Promise<Admission> => {
    const { pathname } = addressed;
    // Set when this request comes from a SHARE visitor (either mode).
    // Everything below treats a non-null value as "untrusted outsider":
    // their claimed identity is rewritten and doc metadata is redacted.
    let visitor: ShareTarget | null = null;
    /** The share that authorized this request, stamped onto any websocket
     *  it upgrades so revocation can find and close it later. */
    let visitorShareId: string | null = null;
    /** The MEMBERSHIP that authorized this request, when it came in on the
     *  share or collaboration hostname. The same job as `visitorShareId` for
     *  the doors no one Cloudflare share admits: without it, ending a
     *  membership or shutting external access off left their open socket
     *  and stream running, because both are authorized once and never
     *  re-checked. */
    let visitorMemberKey: string | null = null;
    /**
     * The email Cloudflare Access verified for this request, if any.
     *
     * Every branch below that runs a verifier fills this in, and nothing
     * reads it unless `CW_REQUIRE_EMAIL_AUTH` is on. A verified claim is
     * an identity; ABSENT it, the visitor stays a `guest-` exactly as
     * before — never unattributed, and never a fallback to whatever the
     * body claimed, because a share visitor's body is the thing the guest
     * namespace exists to distrust.
     */
    let accessEmail: string | null = null;
    /** Set by the widget-door branch below; see the admitted field. */
    let widgetDoorGrant: { token: string; origin: string } | null = null;
    /** Set by the board agent door below; see the admitted field. */
    let boardAgent: BoardAgentClaims | null = null;
    /** Set by `memberDoor` below; see the admitted field. */
    let visitorHome: { signedInAs: string } | null = null;
    /** Where a refused visitor's page links for their list, or null on a door
     *  with none. Set by `memberDoor`, read by every visitor refusal. */
    let listHref: string | null = null;

    /**
     * A visitor's refusal. A browser navigating gets the one page that says
     * who is signed in and where their boards are; anything else keeps the
     * JSON body, because the client's own error handling reads it. The page
     * is built from the email alone, so a board that exists and one that
     * does not answer the same bytes, exactly as the two JSON bodies did.
     */
    const refuseVisitor = (error: 'out_of_share_scope' | 'sharing_disabled'): Response =>
      wantsPage(req) ? notAMemberResponse(accessEmail, listHref) : j(403, { error });

    /**
     * The three MEMBERSHIP doors — the share hostname, the collaboration
     * hostname, and the main hostname for an email that is not the owner's.
     * One rule, so the three cannot drift apart: `/` is the member's own
     * list, every other path is `collabScope` against `isMember`, and the
     * admitted request is a visitor scoped to the board the path names.
     *
     * The list is built from the same `isMember` the scope check asks, with
     * closed boards taken out, so a board it names opens and a board it
     * leaves out does not. `boardRoleOf` answers the badge exactly as it
     * answers the board's own owner gate.
     */
    const memberDoor = (
      isMember: (workspaceId: string) => boolean,
      keyFor: (workspaceId: string, email: string) => string,
    ): Response | null => {
      listHref = accessEmail ? '/' : null;
      if (pathname === '/' && accessEmail && wantsPage(req)) {
        const email = accessEmail;
        const rows = memberBoards(
          listBoards(),
          (id) => isMember(id) && sharingGate.isBoardOpen(id),
          (id) => boardRoleOf(id, email, true),
        );
        return memberHomeResponse(email, rows);
      }
      const scope = collabScope(pathname, req.method, {
        workspacesOf: shareWorkspacesOf,
        isMember,
      });
      if (!scope.allowed) return refuseVisitor('out_of_share_scope');
      // An outsider like any other: identity rewritten to a guest, doc
      // metadata redacted, `visitor`-gated routes closed. No
      // `visitorShareId` — no ONE share admitted it.
      visitor = scope.target;
      // The membership instead, stamped on whatever this request upgrades
      // so that ending it, or throwing the master switch, can hang it up.
      visitorMemberKey =
        accessEmail && scope.target?.workspaceId
          ? keyFor(scope.target.workspaceId, accessEmail)
          : null;
      visitorHome = accessEmail ? { signedInAs: accessEmail } : null;
      return null;
    };

    // --- Cloudflare Access gate ---
    // When cfAccess is configured (server is reachable via a public
    // tunnel), gate the request. Two modes:
    //   - With shares wired: gate ONLY requests whose Host matches an
    //     active share. Tailscale/LAN traffic to the canonical hostname
    //     stays unauthenticated, so the agent's MCP tools can still
    //     hit /api/share over loopback.
    //   - Without shares: gate everything (legacy/test mode).
    // DEFAULT-DENY BY HOST. The tunnel forwards every hostname under the
    // share wildcard here, so "not a known share host" must mean REFUSE,
    // never "skip the gate" (which is what it used to mean — an unknown
    // tunnel hostname reached the whole API unauthenticated). Only our own
    // local names bypass; a share host is gated AND scoped; anything else
    // is denied even when Access isn't configured, so a half-configured
    // deployment fails closed instead of publishing the API.
    /**
     * Every refusal inside runs `return j(...)`, exactly as it did when this
     * was a bare block inside `route()`. Wrapping it in one function rather
     * than rewriting each `return` into a union literal is deliberate: the
     * decision moved without a single line of it being retyped, and there is
     * exactly ONE place where an answer becomes `admitted: false`, so no
     * branch can be added later that refuses and forgets to say so.
     *
     * Falling off the end means admitted.
     */
    const answered = await (async (): Promise<Response | null> => {
      // The frame-only hostname (frame-host.ts): two read families, for the
      // operator alone. Ahead of every other kind, so nothing else this
      // server answers is reachable on it, whatever the lists say.
      if (frameHost?.isFrameHost(req)) {
        const search = new URL(req.url).searchParams;
        const verdict = frameGate(req, pathname, search);
        if (!verdict.ok) return frameGateRefusal(verdict.status);
        // The board's frame ticket (frame-ticket.ts), on or off the tunnel:
        // the one proof a frame on another domain can carry in Safari.
        const proof = frameHost.prove(req, pathname, search);
        if (proof.kind === 'redeem') return proof.response;
        if (proof.kind === 'bad_ticket') return frameGateRefusal(404);
        if (proof.kind === 'public' || proof.kind === 'held') return null;
        // Off the tunnel: a caller on this machine that is not a browser. A
        // browser's frame came from a host page, which handed it a ticket.
        if (!req.headers.has('cf-ray')) {
          if (req.headers.has('sec-fetch-dest')) return j(403, { error: 'frame_ticket_required' });
          return isLoopbackAddress(requestAddress(req)) ? null : j(403, { error: 'unknown_host' });
        }
        // Through it: external reach, so the master switch covers it, and the
        // operator's own token and allowlisted email exactly as on their
        // proxied hostname. A member's token opens nothing here.
        if (!sharingGate.isEnabled()) return j(403, { error: 'sharing_disabled' });
        if (!proxiedTrustedVerifier) return j(503, { error: 'access_not_configured' });
        const result = await proxiedTrustedVerifier(req);
        if (!result.ok) return j(result.status, { error: result.error });
        const who = result.email ? normalizeEmail(result.email) : '';
        if (who === '' || !proxiedTrustedEmails.has(who)) return j(403, { error: 'forbidden' });
        accessEmail = result.email ?? null;
        return null;
      }
      const decision = classifyHost(req.headers.get('host'), {
        // Cached (60s TTL) — this used to spawn `tailscale status` on
        // every single request.
        lanHosts: localHostnames(),
        extraHosts: opts.trustedHosts ?? [],
        // cloudflared forwards the visitor's Host verbatim, so a tunnel
        // visitor could otherwise claim `Host: localhost`. Cloudflare
        // stamps cf-ray on everything it proxies (overwriting any the
        // client sent), so its presence means "not from our LAN".
        viaProxy: req.headers.has('cf-ray'),
        // The opt-in collaboration hostnames, and the fact that Access
        // really is configured for them. Both are required before a
        // proxied host can classify anything but `deny` — see
        // `isAccessTunnelHost`.
        proxiedAccessHosts: accessTunnelHosts,
        // The operator's own proxied address — listed, and honoured only
        // with the same static-audience verifier behind it.
        proxiedTrustedHosts,
        accessFronted: staticAccessVerifier !== null,
        // The share hostname, and the fact that its OWN Access
        // application is configured. `shareLinkAccessFronted` is a
        // separate flag from `accessFronted` because the two hostnames
        // sit behind two applications with two audiences — see the field.
        shareLinkHosts,
        shareLinkAccessFronted: shareLinkVerifier !== null,
        // Recall's own hostname. Neither `viaProxy` nor `accessFronted`
        // applies to it — see the field on TrustedHostOpts for why both
        // absences are deliberate.
        recallCallbackHost,
        // The tailnet widget door. Consulted only for a Host that did not
        // classify `local`, and never through the Cloudflare edge.
        widgetDoorHosts: widgetDoorHosts(),
        // Access on every browser-facing hostname (rule 3 in host-guard).
        // `loopbackPeer` is the half the Host header cannot fake: both of
        // this deployment's proxies dial us over loopback, so it does not
        // separate a tunnel visitor from the box on its own — the Host
        // and the `cf-ray` veto do that — but it does stop a LAN or
        // tailnet client typing `Host: localhost` and being served the
        // product with no identity at all.
        accessOnly: accessOnlyBrowserHosts,
        loopbackPeer: isLoopbackAddress(requestAddress(req)),
        lookupShare: (h) => {
          // LIVE, not merely known: an expired share's hostname must stop
          // being a share hostname, or expiry never takes effect for
          // Access mode (see Shares.findLiveByHostname).
          return boardShareTarget(shares?.findLiveByHostname(h));
        },
      });
      if (decision.kind === 'deny') {
        return j(403, { error: 'unknown_host' });
      }
      // --- External-access master switch ---
      // AHEAD of both auth paths on purpose: while sharing is off, a live
      // Access JWT, an unexpired session cookie and no credential at all
      // must be indistinguishable. Gating after auth would leak which
      // share links are real to anyone still holding one.
      //
      // Only external hosts pass through here — `local` returned above
      // this point untouched, so the agent's MCP calls over loopback and
      // Bryan's own browser keep working while the outside door is shut.
      //
      // `collab` is in here with the other two: it is external reach by
      // the same definition, so the one switch that answers "is anything
      // reachable from outside right now?" has to cover it. A collab request
      // carries no shareId, so what the hang-up sweep finds its live
      // connections by is the membership key stamped in the collab branch
      // below.
      //
      // `proxied-local` is in here too, and it is the WIDEST of the four:
      // the operator's own public hostname through the tunnel, with the
      // whole product behind it. It arrives from outside the machine by
      // exactly the definition the other three do, and leaving it out
      // meant an operator who flipped this switch during a security
      // review — believing the one sentence that describes it — had not
      // closed the widest external door. Being the operator's own door is
      // not an argument for exempting it; it is the argument for the
      // Access token and the email allowlist below, which stay.
      //
      // Nothing local is affected, so the way back is the way in: flip it
      // from the box or the tailnet (`POST /api/share/enabled`, or the
      // `set_sharing_enabled` MCP tool). `CW_SHARING_DISABLED=1` is off
      // AND LOCKED, and it now locks remote operator access with it —
      // which is what "the outside door is shut" was always supposed to
      // mean.
      if (
        (decision.kind === 'share' ||
          decision.kind === 'share-link' ||
          decision.kind === 'collab' ||
          decision.kind === 'proxied-local') &&
        !sharingGate.isEnabled()
      ) {
        return j(403, { error: 'sharing_disabled' });
      }
      // A board agent token is judged by itself and nothing else, whatever
      // the host would otherwise grant (middleware/board-agent-door.ts).
      const boardBearer = boardAgentBearerOf(req.headers);
      if (boardBearer !== null) {
        const door = await admitBoardAgent({
          req,
          pathname,
          hostKind: decision.kind,
          bearer: boardBearer,
          address: requestAddress(req),
          proxiedVerifier: proxiedTrustedVerifier,
          grantFor: boardAgentGrantFor,
          workspacesOf: shareWorkspacesOf,
          j,
        });
        if (!door.ok) return door.response;
        visitor = door.target;
        visitorMemberKey = door.memberKey;
        boardAgent = door.grant;
      } else if (decision.kind === 'share') {
        if (!cfAccessVerifier) {
          // A share exists but we cannot verify Access tokens — refuse
          // rather than serve the doc to an unauthenticated visitor.
          return j(503, { error: 'access_not_configured' });
        }
        const result = await cfAccessVerifier(req);
        if (!result.ok) return j(result.status, { error: result.error });
        accessEmail = result.email ?? null;
        // Authenticated for THIS share — but Access only proves the
        // visitor's email domain, not what they may touch. Scope them to
        // the shared board: no doc enumeration, no workspace/diff
        // creation, no share administration.
        if (!shareScopeAllows(pathname, req.method, decision.target, shareWorkspacesOf)) {
          return refuseVisitor('out_of_share_scope');
        }
        visitor = decision.target;
        visitorShareId = shares?.findLiveByHostname(req.headers.get('host') ?? '')?.shareId ?? null;
      } else if (decision.kind === 'share-link') {
        // THE SHARE HOSTNAME. One Cloudflare Access application covers
        // the whole host with an "everyone" policy and a one-time PIN
        // login, so what arrives here is a verified email address and
        // nothing else — Cloudflare has said WHO, and said nothing about
        // what they may open. Everything below is this server answering
        // the second question.
        //
        // Non-null by construction (the host could not have classified
        // share-link without it), re-checked because "I could not verify"
        // must never mean "serve it".
        if (!shareLinkVerifier) {
          return j(503, { error: 'access_not_configured' });
        }
        const result = await shareLinkVerifier(req);
        if (!result.ok) return j(result.status, { error: result.error });
        accessEmail = result.email ?? null;

        // The redeem route, ABOVE the scope check on purpose: `/s/<id>`
        // names no workspace, so `collabScope` would refuse it as an
        // out-of-scope path and nobody could ever become a member. It is
        // the one path on this hostname a non-member may reach, and all
        // it can do is write the caller's own verified address down
        // against the workspace the link already names.
        const redeemMatch = pathname.match(/^\/s\/([^/]+)$/);
        if (redeemMatch && req.method === 'GET') {
          return redeemShareLink(safeDecodeSegment(redeemMatch[1] ?? ''), accessEmail);
        }

        // Every other request on this hostname is judged on MEMBERSHIP,
        // not on the link. `collabScope` is `shareScopeAllows` with the
        // path's own workspace as the target, so every operator verb a
        // share visitor is refused — the doc list, share administration,
        // folder binds, diff creation, DELETE, wholesale rewrite — is
        // refused here by the same lines, and a route added to one is
        // added to both.
        //
        // A path that names no workspace (root, `/api/docs`, anything
        // this deployment serves that is not a board's content) reaches
        // only the static app shell, which is what makes "root answers
        // nothing useful" true rather than asserted.
        //
        // The refusal is spelled exactly like the collaboration
        // hostname's, on purpose: two different bodies would tell a
        // signed-in stranger which guessed workspace ids are real.
        //
        // The root is the member's own list (`memberDoor`), and the key
        // stamped on an upgrade is the share-link spelling, so removing the
        // member hangs it up.
        const refused = memberDoor((wsId) => shareLinkMemberOf(wsId, accessEmail), shareMemberKey);
        if (refused) return refused;
      } else if (decision.kind === 'collab') {
        // The collaboration hostname: one stable public address, an
        // Access application in front of it, and the SHARE surface behind
        // it — scoped per request to whichever workspace the path names.
        //
        // Non-null by construction (the host could not have classified
        // collab otherwise), re-checked because "I could not verify"
        // must never mean "serve it".
        if (!collabAccessVerifier) {
          return j(503, { error: 'access_not_configured' });
        }
        const result = await collabAccessVerifier(req);
        if (!result.ok) return j(result.status, { error: result.error });
        accessEmail = result.email ?? null;
        // Access proves an identity Bryan admitted, not what they may
        // touch. `collabScope` is `shareScopeAllows` with the path's own
        // workspace as the target, so every operator verb a share visitor
        // is refused — the doc list, share administration, folder binds,
        // diff creation, delete, wholesale rewrite, the landing page — is
        // refused here by the same lines.
        // …and Access proves the visitor was admitted to the HOSTNAME,
        // not to a board behind it. `isMember` is the second condition:
        // the workspace the path names must list this email, through a
        // live share's allow list or the owner allowlist.
        //
        // The refusal is spelled exactly like the out-of-scope one, on
        // purpose. Two different bodies would tell an admitted
        // collaborator which guessed workspace ids are real, which is an
        // enumeration oracle over precisely the ids this check exists to
        // stop them opening.
        //
        // The collaboration spelling of the key, so revoking or expiring a
        // share, or throwing the master switch, can find the connection and
        // ask the question above again.
        const refused = memberDoor((wsId) => collabMemberOf(wsId, accessEmail), collabMemberKey);
        if (refused) return refused;
      } else if (decision.kind === 'recall-callback') {
        // Recall's dedicated hostname. No Access token is demanded and
        // none could be presented: this caller is a vendor's backend.
        // What stands in for it is that the hostname serves THREE routes
        // and each one carries its own credential — a 128-bit per-bot
        // token in the websocket path, a Svix signature over the webhook
        // body, setup 4's bearer secret on its custom-LLM route — verified
        // by the routes themselves one layer in. So the
        // gate's whole job here is to refuse everything else, and it is
        // an allowlist rather than a denylist: a route added to this
        // server tomorrow is closed on this hostname by default.
        //
        // 404 rather than 403, and rather than the 401 the operator
        // hostname answers: this name is not an address the product is
        // served on, so "there is nothing here" is both true and the
        // least it can say about what this deployment runs.
        //
        // Deliberately NOT under the external-access master switch above.
        // That switch answers "is anything reachable from outside right
        // now?" about workspace CONTENT reached by people; these two
        // routes read no doc and are reachable only by whoever holds a
        // token this server minted for one bot. Turning sharing off in
        // the middle of a meeting must not silently strand its bot.
        if (
          !recallCallbackAllows(pathname, req.method, {
            relayConfigured: recallRelay.configured(),
            webhookSecretSet: Boolean(opts.meetingBotWebhookSecret),
            voiceAgentConfigured: Boolean(opts.spokenReply?.agent),
          })
        ) {
          return j(404, { error: 'not_found' });
        }
        // Nothing else: no `visitor`, no scope, no accessEmail. The three
        // routes below authenticate themselves.
      } else if (decision.kind === 'widget-door') {
        // The tailnet hostname under access-only (middleware/widget-door.ts).
        // An allowlist first, so every route this server has that the
        // widget does not call is 404 here — deploy, refresh, MCP, share
        // administration, the board, the doc list — whatever token comes
        // with it. 404 for the reason the recall host gives: on this name
        // there is nothing else.
        const route = widgetDoorRoute(pathname, req.method);
        if (!route) return j(404, { error: 'not_found' });
        // The bundle is the one request with no token: the widget cannot ask
        // for one before it has run, and the bytes are the same for everyone.
        if (route.kind === 'bundle') return null;
        // Every other route needs a live BOARD token that Access minted,
        // presented from the page origin it was minted for. No token, a
        // retired `wt1`, one a session cookie minted for another page, a
        // forged, expired or revoked one, or one from another origin all get
        // the same answer — the widget's cue to offer sign-in, and where —
        // because telling them apart would hand a caller a decision tree.
        const raw = widgetBearerOf(req);
        const origin = req.headers.get('origin');
        const grant = raw && origin ? boardWidgetGrantFor(raw, origin) : null;
        if (!grant || grant.sessionBound || !raw || !origin) {
          return j(401, widgetDoorSignInBody(widgetSignInOrigin));
        }
        if (route.kind === 'doc') {
          // One board: exactly the one the token names. The workspace scope
          // middleware then refuses a doc that board does not hold.
          if (route.workspaceId !== grant.workspaceId) {
            return j(403, { error: 'out_of_widget_scope' });
          }
          // And only a WIDGET doc on it — a mockup or dev page, or one that
          // does not exist yet (the widget's socket creates it). A bound
          // markdown doc's prose is not what a page's comment button needs,
          // so a token lifted from that page cannot read it.
          const type = docTypeOf(route.docId);
          if (type !== undefined && type !== 'mockup') {
            return j(403, { error: 'out_of_widget_scope' });
          }
        }
        widgetDoorGrant = { token: raw, origin };
      } else if (decision.kind === 'proxied-local') {
        // The operator's own hostname through the tunnel: an Access
        // application in front of it, and the WHOLE product behind it.
        // The token is the only thing between the tunnel and loopback
        // privileges, so it is demanded here REGARDLESS of whether shares
        // are wired — the legacy whole-server branch below stops running
        // the moment link sharing is configured, and prod has it.
        //
        // Non-null by construction (the host could not have classified
        // proxied-local otherwise), re-checked because "I could not
        // verify" must never mean "serve it".
        //
        // NOTHING SKIPS THE TOKEN HERE. Two requests used to — Recall's
        // bot callbacks, because the operator hostname was the only
        // public address this deployment had. They now arrive on a
        // hostname of their own (`recallCallbackHost`, handled above),
        // which is a strictly better trade: what a vendor's backend can
        // reach and what a person can reach are two names, and this one
        // is back to having no holes in it at all.
        if (!proxiedTrustedVerifier) {
          return j(503, { error: 'access_not_configured' });
        }
        const result = await proxiedTrustedVerifier(req);
        if (!result.ok) return j(result.status, { error: result.error });
        // A token is admission, not identity. The Access policy this
        // server cannot read may admit collaborators through the same
        // application, and their tokens verify exactly as the operator's
        // does. The verified email is the only thing that says WHO, so it
        // must be on the allowlist — folded the way the roster folds — or
        // the door stays shut. The body names nothing: not the email, not
        // that an allowlist exists.
        //
        // A token with no email names nobody, and nobody is refused outright.
        const who = result.email ? normalizeEmail(result.email) : '';
        if (who === '') return j(403, { error: 'forbidden' });
        accessEmail = result.email ?? null;
        // Any other email is a MEMBER, not the operator: a visitor on exactly
        // the terms the collaboration hostname gives, never a step past this
        // line into loopback privileges. Membership is either record — a
        // redeemed share link or a live share's allow list — because both are
        // how the owner gives somebody a board, and this is the address they
        // were most likely to type. The key names which record admitted
        // them, so the verb that ends that record hangs up the connection.
        if (!proxiedTrustedEmails.has(who)) {
          const refused = memberDoor(
            (wsId) => shareLinkMemberOf(wsId, accessEmail) || collabMemberOf(wsId, accessEmail),
            (wsId, email) =>
              shareLinkMemberOf(wsId, email)
                ? shareMemberKey(wsId, email)
                : collabMemberKey(wsId, email),
          );
          if (refused) return refused;
        }
        // The operator: no `visitor`, no scope. From here on the request is
        // what a loopback request is.
      } else if (cfAccessVerifier && !shares && !shareLinkVerifier) {
        // Legacy whole-server mode: cfAccess configured WITHOUT any
        // sharing surface means the entire deployment sits behind Access,
        // so even a local-looking Host must present a token. (With
        // sharing wired, local traffic is the agent's own MCP calls over
        // loopback and stays unauthenticated.)
        //
        // A share-link hostname counts as a sharing surface, and it has
        // to. The per-share mode it replaces is retired: an operator who
        // finishes draining those records and removes the old settings
        // would otherwise fall into this branch by deletion, and every
        // agent on the box would start being asked for an Access token it
        // has no way to hold.
        const result = await cfAccessVerifier(req);
        if (!result.ok) return j(result.status, { error: result.error });
        accessEmail = result.email ?? null;
      }
      // One board closed to outside visitors (`closedBoards` in
      // share/sharing-gate.ts). Only a share, share-link or collab visitor
      // carries a `visitor` target, so the owner's own hostname and every
      // local caller never reach this line. Spelled like the master switch:
      // this caller was already admitted to the board, so naming the reason
      // tells them nothing they could not see.
      if (visitor?.workspaceId && !sharingGate.isBoardOpen(visitor.workspaceId)) {
        return refuseVisitor('sharing_disabled');
      }
      return null;
    })();
    if (answered) return { admitted: false, response: answered };

    /**
     * Doc metadata as this caller may see it. On the tailnet that's all of
     * it; a share visitor gets an allowlisted subset — the full DocMeta
     * carries absolute paths on Bryan's machine and a tailnet hostname,
     * none of which is needed to render a review.
     */
    const metaFor = <T extends DocMeta>(meta: T): Record<string, unknown> => {
      const decorated = withReviewUrl(meta);
      if (!visitor) return decorated as unknown as Record<string, unknown>;
      return {
        ...redactMetaForVisitor(decorated, {
          workspaceScoped: Boolean(visitor.workspaceId),
        }),
        // Same path, no host, and under the workspace THIS visitor was
        // shared rather than whichever one holds the doc first.
        ...(relativeReviewUrl(decorated.reviewUrl, visitor.workspaceId) !== undefined
          ? { reviewUrl: relativeReviewUrl(decorated.reviewUrl, visitor.workspaceId) }
          : {}),
      };
    };

    const roleFor = (workspaceId: string): BoardRole =>
      boardRoleOf(workspaceId, accessEmail, visitor !== null);

    /**
     * 403 and a sentence, never 404. The caller is a member of this board and
     * already knows it exists, so hiding the route behind "not found" would
     * buy nothing and cost them the explanation.
     */
    const requireOwner = (workspaceId: string): Response | null =>
      roleFor(workspaceId) === 'owner'
        ? null
        : j(403, {
            error: 'owner_only',
            message: 'Only this board’s owner can do that.',
          });

    return {
      admitted: true,
      visitor,
      visitorShareId,
      visitorMemberKey,
      accessEmail,
      visitorHome,
      widgetDoorGrant,
      boardAgent,
      metaFor,
      roleFor,
      requireOwner,
    };
  };

  return { admit };
}
function canonicalOrigin(scheme: string, host: string): string {
  try {
    return new URL(`${scheme}://${host}`).origin;
  } catch {
    return `${scheme}://${host}`;
  }
}
