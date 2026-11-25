/**
 * Host-based access control for a server that is reachable over a public
 * tunnel.
 *
 * Three rules live here. The first two were learned from a security review
 * (2026-08-05); the third is the owner's 2026-09-02 call, below.
 *
 * 1. **Default-deny by host.** The cloudflared ingress forwards EVERY
 *    hostname under the share wildcard to this process. The old gate only
 *    challenged requests whose Host matched an ACTIVE share, so any other
 *    hostname — `anything.tunnel.example.com` — sailed past the Access check
 *    and reached the full API (list every doc, read/write any doc over the
 *    websocket, bind arbitrary folders). Trust is now an allowlist: local
 *    hostnames bypass, everything else must authenticate. A host we do not
 *    recognise is denied even when Access isn't configured at all — a
 *    misconfigured deployment must fail closed, not serve the API to the
 *    internet.
 *
 * 2. **Share scoping.** Passing Cloudflare Access proves the visitor's email
 *    domain is allow-listed for ONE shared doc; it says nothing about the
 *    rest of the server. Without scoping, an external reviewer could
 *    enumerate every bound doc (titles + absolute filesystem paths), open any
 *    doc's websocket, and mint or revoke shares. A share host may therefore
 *    reach only the app shell and the shared doc's own endpoints.
 *
 * 3. **Access on every browser-facing hostname** (Bryan, 2026-09-02: *"Every
 *    access including share link or reading requires sign in via one time
 *    code or otherwise… Let's make everyone go through cloudflare access. No
 *    internal hole."*). `accessOnly` is that rule, and the server turns it on
 *    by default.
 *
 *    THE RULE: the only zone that reaches this server without a verified
 *    Cloudflare Access identity is a process on the box — a request whose
 *    Host is a loopback name AND whose socket peer is a loopback address.
 *    Every other hostname is browser-facing, so it must classify into a kind
 *    that verifies an Access token (`share`, `collab`, `proxied-local`) or be
 *    denied.
 *
 *    THE HOLE IT CLOSES, in two halves. The first is the tailnet and the LAN:
 *    `tailscaleHost`, `lanHosts` and `extraHosts` classified `local`, so any
 *    browser on the private network read every board, doc, attachment, file
 *    tree and diff, and opened any Yjs socket, with no identity at all. The
 *    second is that `local` was decided from the `Host` header, which the
 *    client writes: measured 2026-08-17, a LAN client and a tailnet client
 *    each sending `Host: localhost:1` were both classified local, so the
 *    first half could be walked around by typing. Requiring the peer address
 *    to be loopback is what makes "on the box" a fact the kernel reports
 *    rather than a claim the caller makes.
 *
 *    What it does NOT close: a process already running on the box. That is
 *    inside the trust boundary either way — it can read this server's memory.
 *
 * All three are pure predicates so they can be unit-tested without a server,
 * and are additionally exercised at the HTTP layer — the route layer is the part
 * nothing type-checks (see docs/process/learnings.md).
 */

import { ROUTE_TABLE } from '../route-table-rows.ts';
import type { RouteEntry, RouteGate } from '../route-table.ts';

/** Strip the port and lowercase, so `Host: mac-mini.local:8787` compares. */
export function normalizeHost(host: string | null | undefined): string {
  if (!host) return '';
  const h = host.trim().toLowerCase();
  // IPv6 literal: [::1]:8787 → ::1
  if (h.startsWith('[')) {
    const close = h.indexOf(']');
    if (close > 0) return h.slice(1, close);
  }
  const colon = h.lastIndexOf(':');
  // Only strip a trailing :port (digits), never part of a bare IPv6 address.
  if (colon > 0 && /^\d+$/.test(h.slice(colon + 1))) return h.slice(0, colon);
  return h;
}

export interface TrustedHostOpts {
  /** Tailscale MagicDNS name, when the daemon is up. */
  tailscaleHost?: string | null;
  /** LAN hostnames / IPv4 addresses for this machine. */
  lanHosts?: string[];
  /** Extra hostnames an operator explicitly marks local. */
  extraHosts?: string[];
  /**
   * True when the request came through the Cloudflare edge (it carries a
   * `cf-ray`, which Cloudflare stamps on everything it proxies and
   * overwrites if a client sends its own). cloudflared forwards the
   * visitor's Host verbatim, so without this a tunnel visitor could send
   * `Host: localhost` and be classified local. A proxied request is never
   * local, whatever its Host claims.
   */
  viaProxy?: boolean;
  /**
   * Hostnames an operator has opted in as COLLABORATION addresses — reachable
   * through the tunnel from outside the tailnet, gated by Cloudflare Access,
   * and scoped to the share surface (`collabScope` below).
   *
   * Deliberately a SECOND list rather than a widening of `extraHosts`, and
   * the difference is the security property. `extraHosts` means "another name
   * for this machine on a network I control", so its entries classify
   * `local` — the whole product, unauthenticated. Reusing it here would hand
   * tunnel visitors everything anyone ever added for a LAN reason.
   *
   * The `viaProxy` veto above is untouched: an entry here never classifies
   * local, and a request that did NOT arrive through the proxy never
   * classifies collab. The two lists cannot leak into each other.
   */
  proxiedAccessHosts?: string[];
  /**
   * Hostnames an operator has opted in as THEIR OWN public address — the
   * whole product, reached through the tunnel from outside the tailnet, gated
   * by Cloudflare Access over that hostname.
   *
   * The third list, and the widest grant, so its separation from the other
   * two is the security property. `extraHosts` classifies `local` with no
   * token at all and is refused through the proxy; `proxiedAccessHosts`
   * classifies `collab` (token, then the share surface only). An entry here
   * classifies `proxied-local`: a token, then everything loopback gets. None
   * of the three can leak into another — an entry on this list is still
   * refused by `isTrustedLocalHost` through the proxy, and an `extraHosts`
   * entry never satisfies `isProxiedTrustedHost`.
   *
   * Requires `accessFronted` exactly as the collaboration list does, and for
   * a stronger reason: honoured without Access in front, this would be the
   * full API — every doc, every workspace, share administration, the deploy
   * verb — to anyone who can reach the tunnel and type the hostname.
   */
  proxiedTrustedHosts?: string[];
  /**
   * The SHARE hostname(s) — `share.<domain>` — where a share link is opened
   * and where the people who redeemed one keep working.
   *
   * The FIFTH list, and the one whose Access application admits EVERYONE:
   * its policy is "any email, one-time PIN", so passing Cloudflare there
   * proves an address and grants nothing at all. What decides a share-host
   * visitor's reach is this server's own membership record — the emails that
   * have redeemed a live link for a workspace (`ShareLinks.isMember`).
   *
   * Separate from `proxiedAccessHosts` for exactly that reason, and the
   * separation is the security property. A collaboration hostname sits behind
   * an application whose policy names people the operator admitted; this one
   * sits behind an application that admits the world. Merging the lists would
   * make "the operator let this address through the door" and "anybody with
   * an email" the same fact, and every workspace reachable from the wider one
   * would inherit the narrower one's trust.
   *
   * Requires `shareLinkAccessFronted` — its own audience, not the owner's.
   */
  shareLinkHosts?: string[];
  /**
   * True when a Cloudflare Access verifier is configured for the SHARE
   * hostname specifically: team domain AND the share application's own
   * audience (`CF_ACCESS_SHARE_AUD`).
   *
   * A SECOND flag rather than a reuse of `accessFronted`, and this is the
   * audience cross-check made structural. The share application and the
   * owner's application are different applications with different AUD tags;
   * verifying a share-host request against the owner's audience would accept
   * the operator's own token on the everyone-policy hostname, and verifying
   * an owner-host request against the share audience would accept a token
   * anyone on the internet can mint by typing an email. One flag would have
   * let a deployment configure one and silently get the other.
   */
  shareLinkAccessFronted?: boolean;
  /**
   * True when a Cloudflare Access verifier really is configured for the
   * proxied hosts above — team domain AND a static audience.
   *
   * Without it the list is ignored entirely. That is the load-bearing half:
   * an opt-in host that classified collab with no Access application in front
   * would hand the share surface to anyone who can reach the tunnel and type
   * the hostname, which is precisely the hole the `viaProxy` veto closed
   * (security review 2026-08-05). Failure mode is refusal, never exposure.
   */
  accessFronted?: boolean;
  /**
   * The ONE hostname Recall.ai's backend dials this deployment on — a
   * dedicated first-level name pointed at the same tunnel, e.g.
   * `recall.<domain>` (`CW_RECALL_CALLBACK_HOST`).
   *
   * The FOURTH list, and by far the narrowest grant: not the product, not the
   * share surface, not the app shell — three routes, each of which carries
   * its own credential (a 128-bit per-bot token in the path; a Svix signature
   * over the webhook body; setup 4's bearer secret, for ElevenLabs' backend). Everything else on it is 404. See
   * middleware/recall-callback-gate.ts for the allowlist and why each route
   * is armed only while its credential is configured.
   *
   * A SINGLE hostname rather than a list, deliberately: it is derived into
   * the callback URL handed to the vendor, and a list would have no answer to
   * "which one did we tell Recall to dial".
   *
   * Two conditions the other proxied lists impose are deliberately ABSENT
   * here, and both absences are reasoned rather than overlooked:
   *
   * - **No `accessFronted`.** Cloudflare Access is a browser flow. Recall's
   *   backend has no browser and no way to acquire a token, so an Access
   *   application in front of this hostname would refuse every real caller —
   *   which is the whole reason the exemptions this replaces existed. The
   *   credentials the three routes carry are what authenticates them.
   * - **No `viaProxy` requirement.** That veto exists so a tunnel visitor
   *   cannot claim `Host: localhost` and be served the product; there is no
   *   product here to serve. Requiring it would also break any deployment
   *   fronted by something that is not Cloudflare (no `cf-ray`), turning a
   *   working bot into one that joins, records, bills and delivers nothing.
   */
  recallCallbackHost?: string | null;
  /**
   * ACCESS-ONLY mode: every browser-facing hostname is behind Cloudflare
   * Access, and the only unauthenticated zone is a process on the box.
   *
   * On, `isTrustedLocalHost` answers true for a loopback Host and a loopback
   * `loopbackPeer` and nothing else — `tailscaleHost`, `lanHosts` and
   * `extraHosts` stop granting anything, so a tailnet or LAN browser falls
   * through to `deny` unless its hostname is on one of the Access lists. See
   * rule 3 in this file's header for the hole that closes.
   *
   * Off restores the pre-2026-09-02 classification, which is what the tests
   * of the LAN-alias grant still exercise. The deployment switch is
   * `CW_ACCESS_ONLY_BROWSER_HOSTS` (server-config.ts), and it defaults ON;
   * this option defaults OFF so that a caller constructing opts by hand gets
   * the behaviour its other fields describe rather than a silent narrowing.
   */
  accessOnly?: boolean;
  /**
   * True when the request's SOCKET PEER is a loopback address — what
   * `isLoopbackAddress(server.requestIP(req)?.address)` answers.
   *
   * Read only under `accessOnly`, and it is the half the Host header cannot
   * fake. Absent answers false, so "I could not read the peer" is never "on
   * the box".
   *
   * Note what it does NOT distinguish: both of this deployment's reverse
   * proxies terminate on this machine and dial the server over loopback, so
   * a Cloudflare visitor and a `tailscale serve` visitor BOTH arrive with a
   * loopback peer (measured — see middleware/client-address.ts). Their Host
   * is the tunnel or MagicDNS name rather than a loopback name, which is
   * what separates them here, and the `viaProxy` veto separates the
   * Cloudflare one again.
   */
  loopbackPeer?: boolean;
  /**
   * The TAILNET WIDGET DOOR's hostnames — this machine's MagicDNS name, where
   * an app page on the tailnet loads the widget (middleware/widget-door.ts).
   *
   * Read only when the Host did not already classify `local`, so with
   * access-only OFF — where the tailnet name is local and the whole product —
   * it grants nothing new. With access-only ON it is the one grant the tailnet
   * hostname gets: the widget's own routes, each behind a board token.
   *
   * A request through the Cloudflare edge never classifies here, whatever its
   * Host claims: the door is for the private network, and a tunnel visitor
   * typing the tailnet name must not reach it.
   */
  widgetDoorHosts?: readonly string[];
  /**
   * The local test sign-in's address (`auth/test-signin.ts`), a `*.localhost`
   * name. Classifies `proxied-local` — a session, then everything loopback
   * gets — only off the Cloudflare edge AND from a loopback peer, the reverse
   * of the operator's proxied list: a browser on this machine resolves the
   * name to loopback by itself, and nothing else should reach it.
   */
  localSignInHosts?: readonly string[];
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * Is this PEER ADDRESS loopback — i.e. did the request come from a process on
 * this machine?
 *
 * Deliberately not a Host check, and the difference is the whole point.
 * Everything else in this file classifies the `Host` header, which is
 * client-controlled: measured 2026-08-17 against a real `Bun.serve`, a LAN
 * client (`192.168.x.x`) and a tailnet client (`100.x.x.x`) both connected
 * while sending `Host: localhost:1`, and both were classified local. A gate
 * built on the Host header is therefore spoofable by exactly the callers it
 * would exist to exclude. `server.requestIP(req)` reports the address the
 * kernel saw, which a client cannot choose.
 *
 * Two shapes that are easy to get wrong, both pinned by tests:
 *
 * - Bun reports an IPv4 loopback peer as **`::ffff:127.0.0.1`** (IPv4-mapped
 *   IPv6). An `=== '127.0.0.1'` comparison refuses the only caller this is
 *   meant to allow.
 * - Loopback is the whole of `127.0.0.0/8`, not just `127.0.0.1`.
 *
 * `null` answers false. `requestIP` returns null for a socket that has
 * already gone away, and "I could not read the peer" must never authorise a
 * privileged operation. `0.0.0.0` and `::` are bind wildcards rather than
 * peer addresses, so they answer false too — they appear in the Host-matching
 * set above for a different question.
 */
export function isLoopbackAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const a = addr.trim().toLowerCase();
  if (a === '::1') return true;
  // Unwrap IPv4-mapped IPv6 (`::ffff:127.0.0.1`) before matching v4.
  const v4 = a.startsWith('::ffff:') ? a.slice('::ffff:'.length) : a;
  // Anchored and fully numeric: `127.0.0.1.evil.example` must not match.
  const m = v4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  return octets[0] === 127;
}

/**
 * Is this Host header one of OUR local names (loopback / tailnet / LAN)?
 * Only these bypass authentication. Matching is exact — no suffix matching,
 * because `evil-mac-mini.attacker.com` must not match `mac-mini.local`.
 */
export function isTrustedLocalHost(
  host: string | null | undefined,
  opts: TrustedHostOpts,
): boolean {
  const h = normalizeHost(host);
  if (h === '') return false; // HTTP/1.1 requires Host; absent = not trusted
  if (opts.viaProxy) return false; // arrived via Cloudflare — not our LAN
  // Access-only: the box, and nothing else. BOTH halves are required — the
  // Host says which surface was asked for, the peer address says the caller
  // is really on this machine, and the header alone is client-controlled.
  if (opts.accessOnly) return LOOPBACK.has(h) && opts.loopbackPeer === true;
  if (LOOPBACK.has(h)) return true;
  // NOTE: deliberately no "any private IPv4 is local" rule. Host is
  // client-controlled, so trusting 10/8, 192.168/16, 172.16/12 or CGNAT
  // wholesale would let a caller self-classify as local. This machine's
  // real addresses — including the tailnet utun address — are enumerated
  // into `lanHosts`, so exact matching costs nothing.
  const candidates = [
    opts.tailscaleHost ?? '',
    ...(opts.lanHosts ?? []),
    ...(opts.extraHosts ?? []),
  ]
    .map((c) => normalizeHost(c))
    .filter((c) => c !== '');
  return candidates.includes(h);
}

/**
 * Is this Host an operator-declared COLLABORATION address arriving through
 * the Cloudflare tunnel?
 *
 * Three conditions, all required, and each one closes a different door:
 *
 *   - `viaProxy` — the request really came through the edge. A host in the
 *     list reached any other way (a LAN client sending the name directly)
 *     has no Access token in front of it, so it is denied rather than
 *     collab. Note this is the OPPOSITE test to `isTrustedLocalHost`, on
 *     purpose: that one refuses proxied requests, this one requires them, and
 *     no request can satisfy both.
 *   - `accessFronted` — Cloudflare Access is configured. See the field.
 *   - exact membership — no suffix matching, same rule as the local list:
 *     `workspaces.example.com.attacker.com` must not match.
 */
export function isAccessTunnelHost(
  host: string | null | undefined,
  opts: TrustedHostOpts,
): boolean {
  if (!opts.viaProxy) return false;
  if (!opts.accessFronted) return false;
  const h = normalizeHost(host);
  if (h === '') return false;
  return (opts.proxiedAccessHosts ?? [])
    .map((c) => normalizeHost(c))
    .filter((c) => c !== '')
    .includes(h);
}

/**
 * Is this Host the OPERATOR'S own public address arriving through the
 * Cloudflare tunnel?
 *
 * The same three conditions as `isAccessTunnelHost` — the request really came
 * through the edge, Access really is configured, exact membership — against
 * the `proxiedTrustedHosts` list instead. What differs is what the caller
 * does with a `true`: verify the Access token and then serve the product as
 * if the request were on loopback, rather than the share surface.
 *
 * Deliberately NOT a widening of `isTrustedLocalHost`. That predicate's
 * `viaProxy` veto is the fix from the 2026-08-05 review and stays absolute;
 * this one is a separate door with a separate key.
 */
export function isProxiedTrustedHost(
  host: string | null | undefined,
  opts: TrustedHostOpts,
): boolean {
  if (!opts.viaProxy) return false;
  if (!opts.accessFronted) return false;
  const h = normalizeHost(host);
  if (h === '') return false;
  return (opts.proxiedTrustedHosts ?? [])
    .map((c) => normalizeHost(c))
    .filter((c) => c !== '')
    .includes(h);
}

/**
 * Is this Host the SHARE hostname arriving through the Cloudflare tunnel?
 *
 * The same three conditions every proxied list imposes — the request really
 * came through the edge, Access really is configured, exact membership — with
 * one difference that is the whole point: the Access condition it checks is
 * `shareLinkAccessFronted`, the SHARE application's own audience, not the
 * owner's. A deployment that configured `CF_ACCESS_AUD` and nothing else
 * classifies no share host at all, which is refusal rather than a hostname
 * verified against the wrong application.
 *
 * What a `true` means to the caller is narrower than it looks: the
 * application behind this hostname admits any email, so classifying here
 * grants only the chance to present a verified address. Everything after that
 * is the membership check.
 */
export function isShareLinkHost(host: string | null | undefined, opts: TrustedHostOpts): boolean {
  if (!opts.viaProxy) return false;
  if (!opts.shareLinkAccessFronted) return false;
  const h = normalizeHost(host);
  if (h === '') return false;
  return (opts.shareLinkHosts ?? [])
    .map((c) => normalizeHost(c))
    .filter((c) => c !== '')
    .includes(h);
}

/**
 * Is this Host the dedicated hostname Recall.ai dials back on?
 *
 * Exact match against the single configured name, same rule as every other
 * list here: no suffix matching, so `recall.example.com.attacker.com` is not
 * it. Unconfigured (the ordinary state — no meeting bots, or bots reached
 * some other way) answers false for every Host, which leaves the hostname
 * unknown and therefore denied.
 *
 * Deliberately NOT a widening of any existing list. `extraHosts` classifies
 * `local` — the whole product, no token; `proxiedAccessHosts` classifies
 * `collab`; `proxiedTrustedHosts` classifies `proxied-local`. All three are
 * grants to PEOPLE, gated by something a person can present. This one is a
 * grant to a VENDOR'S BACKEND, gated by credentials only that backend holds,
 * and it reaches three routes. Keeping it a fourth door is what stops the
 * unauthenticated one from ever being the door people use.
 */
export function isRecallCallbackHost(
  host: string | null | undefined,
  opts: TrustedHostOpts,
): boolean {
  const configured = normalizeHost(opts.recallCallbackHost ?? '');
  if (configured === '') return false;
  const h = normalizeHost(host);
  if (h === '') return false;
  return h === configured;
}

/**
 * Is this Host the local test sign-in's address, reached from this machine
 * and not through the edge? See `localSignInHosts`.
 */
export function isLocalSignInHost(host: string | null | undefined, opts: TrustedHostOpts): boolean {
  if (opts.viaProxy || opts.loopbackPeer !== true) return false;
  const h = normalizeHost(host);
  if (h === '') return false;
  return (opts.localSignInHosts ?? []).map((c) => normalizeHost(c)).includes(h);
}

/**
 * Is this Host one of the tailnet widget door's names, reached directly
 * rather than through the Cloudflare edge?
 *
 * Exact match, no suffix matching, same rule as every list here. The
 * `viaProxy` veto is the same one `isTrustedLocalHost` applies and for the
 * same reason: cloudflared forwards the visitor's Host verbatim.
 */
export function isWidgetDoorHost(host: string | null | undefined, opts: TrustedHostOpts): boolean {
  if (opts.viaProxy) return false;
  const h = normalizeHost(host);
  if (h === '') return false;
  return (opts.widgetDoorHosts ?? [])
    .map((c) => normalizeHost(c))
    .filter((c) => c !== '')
    .includes(h);
}

/**
 * What a share hostname grants access to.
 *
 * One field, and that is the whole point. A target used to carry a `docId`
 * as well — the doc the share URL opened — and while it was documented as a
 * landing address rather than a grant, "always in scope" is precisely what a
 * per-doc share WAS. That base case went with the per-doc removal, and the
 * field went with the board-only removal after it: a board share opens the
 * board, so there is no entry doc left for anything to read.
 */
export interface ShareTarget {
  /**
   * The BOARD this share covers. Every doc filed on it is in scope, along
   * with the navigation endpoints that make the set browsable.
   *
   * REQUIRED, and it is the ONLY source of scope. Typed optional so a caller
   * that still constructs the old doc-only shape is refused by the guard
   * below rather than rejected by the compiler and then shipped anyway — an
   * absent workspaceId grants nothing.
   */
  workspaceId?: string;
}

export type HostDecision =
  | { kind: 'local' } // trusted local caller: no gate
  | { kind: 'share'; target: ShareTarget } // per-share Access host: JWT + scope
  | { kind: 'share-link' } // the share hostname: JWT (share aud) + membership
  | { kind: 'collab' } // Access-fronted collaboration host: JWT + collabScope
  | { kind: 'proxied-local' } // Access-fronted operator host: JWT, then local
  | { kind: 'recall-callback' } // the vendor callback host: three routes, nothing else
  | { kind: 'widget-door' } // the tailnet host under access-only: widget routes, token each
  | { kind: 'deny'; reason: 'unknown_host' }; // anything else: refuse

/**
 * Classify a request's Host.
 *
 * Order matters: our own names win, then the bot callback hostname, then the
 * tailnet widget door, then a per-share Access hostname, then the share
 * hostname, then the operator's opt-in collaboration hosts, then the
 * operator's own proxied address.
 * Anything else is refused — the tunnel forwards every hostname under its
 * ingress here, so "unrecognised" must mean refuse, never "skip the gate".
 *
 * There is no `link` kind any more. The single public hostname link-mode
 * shares were served from used to classify here and be authorized from a
 * signed COOKIE, which is precisely the browser-facing surface that reached
 * board content with no verified identity behind it. It is now an
 * unrecognised hostname like any other unless the operator also lists it as
 * a collaboration host, where it gets an Access token like everyone else.
 *
 * The external kinds are checked narrowest-first on purpose, and the widest
 * — `proxied-local`, the whole product — LAST. Putting a name in an opt-in
 * list must never quietly take a hostname AWAY from the narrower rule that
 * already claimed it: a host listed as both collab and proxied-trusted stays
 * collab. With both lists empty — every deployment that has not opted in —
 * this function behaves exactly as it did before either branch existed.
 */
export function classifyHost(
  host: string | null | undefined,
  opts: TrustedHostOpts & {
    lookupShare: (host: string) => ShareTarget | null;
  },
): HostDecision {
  if (isTrustedLocalHost(host, opts)) return { kind: 'local' };
  // The narrowest external kind, so it is checked FIRST among them: a name
  // configured as the bot callback host can only ever lose surface by being
  // matched here, never gain any.
  if (isRecallCallbackHost(host, opts)) return { kind: 'recall-callback' };
  // Next narrowest: the widget's own routes, each behind a board token. Below
  // `local`, so a deployment with access-only off keeps serving its tailnet
  // name the whole product exactly as before.
  if (isWidgetDoorHost(host, opts)) return { kind: 'widget-door' };
  const h = normalizeHost(host);
  const target = opts.lookupShare(h);
  if (target) return { kind: 'share', target };
  // Ahead of `collab` on purpose. The two surfaces are the same size, and a
  // hostname on both lists must resolve to the one whose Access application
  // admits the WORLD — served as a share host, every workspace decided by
  // this server's membership record. Resolving it as `collab` instead would
  // judge an everyone-policy visitor by the collaboration hostname's
  // membership rule (a live share's allow list), which was written for an
  // application that admits only people the operator named.
  if (isShareLinkHost(host, opts)) return { kind: 'share-link' };
  if (isAccessTunnelHost(host, opts)) return { kind: 'collab' };
  if (isProxiedTrustedHost(host, opts)) return { kind: 'proxied-local' };
  if (isLocalSignInHost(host, opts)) return { kind: 'proxied-local' };
  return { kind: 'deny', reason: 'unknown_host' };
}

/**
 * ===== SHARE SCOPE, read off the route table =====
 *
 * Which addresses a share visitor may reach used to be written out here a
 * second time: five tables and two if-chains naming the same paths the route
 * table names, kept in step by `route-table.test.ts` checking one against the
 * other. The rows are now the only place a path is written. A row whose gate
 * is in `SHARE_VISIBLE_GATES` is an address a visitor reaches, for exactly the
 * methods the row lists; every other address, including one no row names, is
 * refused. A route added later is therefore closed until its row says
 * otherwise, which is the property the hand-written allowlist existed for.
 *
 * WHAT THE ROW CANNOT SAY is which board an id in the path belongs to. That
 * half is `PARAM_SCOPE`: one entry per parameter name, saying what a value in
 * that position must be inside before the row admits it. Three questions,
 * every time, and all three must pass:
 *
 *   the method must be one the row lists, AND
 *   the `:ws` segment must be the shared board, AND
 *   every id nested under it must be inside that board.
 *
 * Any one alone admits something. The segment alone would let a visitor read
 * any doc on the server by spelling their own board id in front of it; the
 * membership alone would ignore which board was asked; the method alone would
 * grant every board.
 *
 * Why each share row is granted is the row's own business, and its `reason`
 * says so where the grant is not obvious. The history of each grant (the
 * 2026-09-03 call that made a member a participant, the `docs:attach` key
 * move, the region-edit verbs) is in git: `git log -S BOARD_MEMBER_ROUTES`.
 */

/**
 * The gates the host guard admits a share visitor through.
 *
 * `owner-in-handler` is here because the guard admits the visitor and the
 * route refuses them a layer lower; `collab-scope` because a collaboration
 * host is the share surface plus a membership check (`collabScope`).
 */
export const SHARE_VISIBLE_GATES: ReadonlySet<RouteGate> = new Set<RouteGate>([
  'share-scope',
  'collab-scope',
  'owner-in-handler',
]);

/**
 * What a path parameter's value must be inside, for a share row to admit it.
 *
 * - `board` — the shared board itself.
 * - `board-doc` — a doc (or mockup, app, whiteboard: all docs) filed on it.
 * - `board-row` — a task or goal row on it, which a board holds as `task:<id>`.
 * - `board-attachment` — a review filed on it, or the board's own id. A group
 *   bind is filed on the board, so the review row a visitor sees is reached
 *   through the GROUPING's id while the share is scoped to the board's.
 * - `unchecked` — a value inside a resource already checked to its left: a
 *   thread, suggestion, meeting or review item of the doc or row before it,
 *   or a member's email on the board before it (which board's list is
 *   administered is settled by `:ws`; who may change it is `requireOwner`).
 *
 * A share row naming a parameter not in this table throws when the table is
 * read, so a new kind of id cannot reach a visitor without someone deciding
 * what it must belong to.
 */
type ParamScope = 'board' | 'board-doc' | 'board-row' | 'board-attachment' | 'unchecked';

const PARAM_SCOPE: Readonly<Record<string, ParamScope>> = {
  ws: 'board',
  docId: 'board-doc',
  taskId: 'board-row',
  goalId: 'board-row',
  setId: 'board-attachment',
  threadId: 'unchecked',
  itemId: 'unchecked',
  sid: 'unchecked',
  meetingId: 'unchecked',
  email: 'unchecked',
};

/** One share-visible row, split once so a request is matched without re-parsing. */
interface ShareRoute {
  readonly pattern: string;
  readonly segments: readonly string[];
  readonly methods: ReadonlySet<string>;
}

/**
 * The share-visible rows of a route table, checked.
 *
 * Throws, rather than refusing quietly, on a row the matcher could only get
 * wrong: a parameter `PARAM_SCOPE` does not name, or a parameter that is not
 * under `/workspaces/:ws/`. Every id a visitor reaches is reached under the
 * board that owns it; a share row outside that shape has nothing to scope its
 * ids against.
 */
export function shareRoutesOf(entries: readonly RouteEntry[]): readonly ShareRoute[] {
  const routes: ShareRoute[] = [];
  for (const entry of entries) {
    if (!SHARE_VISIBLE_GATES.has(entry.gate)) continue;
    const segments = entry.pattern.split('/');
    const params = segments.filter((s) => s.startsWith(':')).map((s) => s.slice(1));
    if (params.length > 0 && (segments[1] !== 'workspaces' || segments[2] !== ':ws')) {
      throw new Error(`share route ${entry.pattern}: a parameter outside /workspaces/:ws/`);
    }
    for (const name of params) {
      if (!Object.hasOwn(PARAM_SCOPE, name)) {
        throw new Error(`share route ${entry.pattern}: no PARAM_SCOPE entry for :${name}`);
      }
    }
    routes.push({ pattern: entry.pattern, segments, methods: new Set(entry.methods) });
  }
  return routes;
}

/**
 * The `shareScopeAllows` a set of share rows spells. Exported so a test can
 * build one from the real table plus a row of its own; the server uses the one
 * below, built from `ROUTE_TABLE`.
 */
export function shareScopeFrom(
  routes: readonly ShareRoute[],
): (
  pathname: string,
  method: string,
  target: ShareTarget,
  workspacesOf?: (id: string) => string[],
) => boolean {
  return (pathname, method, target, workspacesOf) => {
    // A workspace is the unit of sharing, so a target that names none grants
    // NOTHING — not even the app shell. A legacy record or a caller still
    // building the old doc-only shape is refused here.
    const wsId = target.workspaceId;
    if (!wsId) return false;

    // The agent-multiplexed feed carries every channel that agent watches,
    // which is wider than any board a share covers. Refused by name, so no
    // row added later can open it.
    if (pathname.startsWith('/events/agent/')) return false;

    /**
     * Is this id inside the shared workspace? The only place `workspacesOf` is
     * read. `Array.isArray` because this parameter used to return a bare
     * string, and a string also answers `.includes` — a caller still handing
     * the old shape would grant on any substring. Refusing a non-array can
     * only close.
     */
    const insideSharedWorkspace = (id: string): boolean => {
      const owners = workspacesOf?.(id);
      return Array.isArray(owners) && owners.includes(wsId);
    };
    const inScope = (scope: ParamScope, value: string): boolean => {
      const id = safeDecode(value);
      switch (scope) {
        case 'board':
          return id === wsId;
        case 'board-doc':
          return insideSharedWorkspace(id);
        case 'board-row':
          return insideSharedWorkspace(`task:${id}`);
        case 'board-attachment':
          return id === wsId || insideSharedWorkspace(id);
        case 'unchecked':
          return true;
      }
    };

    const got = pathname.split('/');
    for (const route of routes) {
      if (!route.methods.has(method)) continue;
      if (matchesInScope(route.segments, got, inScope)) return true;
    }
    return false;
  };
}

/**
 * Does `got` match these pattern segments, with every parameter in scope?
 * The same shape as `patternMatches` in `route-table.ts`: `:name` is one
 * non-empty segment, a trailing `*` is one or more, a mid-segment colon is
 * literal.
 * The literal segments are matched first, so `workspacesOf` is asked only
 * about a path that is this route.
 */
function matchesInScope(
  segments: readonly string[],
  got: readonly string[],
  inScope: (scope: ParamScope, value: string) => boolean,
): boolean {
  const params: [ParamScope, string][] = [];
  let tail = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as string;
    if (seg === '*') {
      if (got.length <= i) return false;
      tail = true;
      break;
    }
    const here = got[i];
    if (here === undefined) return false;
    if (seg.startsWith(':')) {
      // An empty segment names no id. Bun's router does not match one either,
      // and the old allowlist's `[^/]+` refused it.
      if (here === '') return false;
      const scope = PARAM_SCOPE[seg.slice(1)];
      if (scope === undefined) return false;
      params.push([scope, here]);
      continue;
    }
    if (seg !== here) return false;
  }
  if (!tail && segments.length !== got.length) return false;
  return params.every(([scope, value]) => inScope(scope, value));
}

/**
 * May a request on a SHARE host touch this path?
 *
 * Allowlist, not denylist, and the list is the route table's share-visible
 * rows (see the block above). `workspacesOf` answers every workspace an id
 * belongs to, most specific first — empty when it belongs to none. A doc
 * belongs to more than one at once (its review, and the board that review is
 * filed on), so membership is a set; an exact `=== workspaceOf(id)` was what
 * once refused a board visitor every review row on their own board.
 */
export const shareScopeAllows = shareScopeFrom(shareRoutesOf(ROUTE_TABLE));
/**
 * A workspace id no store can mint, used as the target when a path names no
 * workspace at all. Every workspace-dependent rule in `shareScopeAllows`
 * compares against `target.workspaceId` or looks it up in `workspacesOf`, so
 * a value containing a NUL byte answers false everywhere — leaving exactly
 * the static app-shell allowances, which is what a shell path should get.
 *
 * A sentinel rather than an `undefined` workspace because an absent
 * `workspaceId` is refused outright by the guard, shell and all.
 */
const NO_WORKSPACE = '\u0000collab-no-workspace';

/**
 * What `collabScope` needs to answer, beyond the path itself.
 *
 * `isMember` is REQUIRED, and the options object exists so that it is. It
 * used to be a third positional parameter list ending in an optional
 * `workspacesOf`, and appending an optional membership check to that would
 * have made "forgot to pass it" mean "admitted everybody" — the exact
 * failure this predicate was added to remove.
 */
export interface CollabScopeOpts {
  /** See the same parameter on `shareScopeAllows`. */
  workspacesOf?: (id: string) => string[];
  /**
   * Is the request's Access-verified email a member of this workspace?
   *
   * The server owns the answer, because membership is recorded outside this
   * module: the allow lists of the workspace's LIVE shares, plus the owner
   * allowlist. This module owns only WHICH workspace is asked about, which is
   * the half that has to agree with the scope verdict.
   */
  isMember: (workspaceId: string) => boolean;
}

/**
 * May a request on a COLLABORATION host touch this path?
 *
 * The surface is the share surface — read the docs, open the board, comment —
 * for whichever workspace the path names, rather than for one workspace fixed
 * at mint time. That is the whole difference between this and a share host:
 * a share hostname carries its scope, and a collaboration hostname is one
 * stable address whose scope is decided per request.
 *
 * TWO conditions, both required. The path must be in scope for the workspace
 * it names, AND the visitor must be a member of that workspace. Passing
 * Cloudflare Access proves only that the operator admitted this email to the
 * HOSTNAME; it says nothing about which boards behind it that person was
 * given, so without the second condition every admitted email reached every
 * workspace on the server by id. `isMember` is that condition, and it is
 * asked about the same workspace the scope verdict was made about — one
 * derivation, so the two halves cannot answer about different boards.
 *
 * A path can name MORE THAN ONE workspace, and both conditions are asked of
 * each in turn. A doc filed on two boards belongs to both; taking only the
 * first — whichever the store happened to iterate first — asked membership
 * about a board the visitor was never given and refused them a doc their own
 * board shows them. So the candidates are walked in order and the answer is
 * the first that satisfies BOTH, which is also the workspace the request is
 * then served as: redaction and scoping run against a board this visitor
 * really holds, never against one they merely reached through.
 *
 * A path that names NO workspace — the app shell, the widget bundle, the
 * favicon — is not membership-checked, because there is nothing to be a
 * member of. That is the whole of what an admitted non-member reaches.
 *
 * It is ONE rule, not two. Everything else is answered by `shareScopeAllows`
 * with the path's own workspace as the target, so the operator verbs a share
 * visitor is refused — the doc list, share administration, folder binds, diff
 * creation, DELETE, `content`, `reparse_from_disk`, the landing page — are
 * refused here by the same lines, and a route added to one is added to both.
 * A second allowlist would agree today and drift later, and the one that
 * drifts open is the breach.
 *
 * Returns the target as well as the verdict because the caller needs it: the
 * request is served as an untrusted visitor scoped to that workspace, exactly
 * as a share visitor is.
 */
export function collabScope(
  pathname: string,
  method: string,
  opts: CollabScopeOpts,
): { allowed: false } | { allowed: true; target: ShareTarget } {
  const { workspacesOf, isMember } = opts;
  const candidates = pathWorkspaces(pathname);
  // A shell path names no workspace, so there is nothing to be a member of.
  // It is judged against the sentinel — leaving exactly the static
  // allowances — and the visitor it creates is scoped to no workspace: `{}`
  // rather than the sentinel, which must never escape this file.
  if (candidates.length === 0) {
    const shell = shareScopeAllows(pathname, method, { workspaceId: NO_WORKSPACE }, workspacesOf);
    return shell ? { allowed: true, target: {} } : { allowed: false };
  }
  for (const workspaceId of candidates) {
    if (!isMember(workspaceId)) continue;
    if (!shareScopeAllows(pathname, method, { workspaceId }, workspacesOf)) continue;
    return { allowed: true, target: { workspaceId } };
  }
  return { allowed: false };
}

/**
 * Which workspace does this path address? Empty when it names none, which is
 * every static asset and every enumerate-the-server route.
 *
 * A LIST, and now always of length 0 or 1 — kept as a list because the caller
 * loops it and because the shape is the honest one: it USED to return several
 * candidates, because a doc belongs to more than one workspace at once (its
 * review, and every board that review or doc is filed on) and four of the
 * five addresses it parsed named a resource without saying which board it was
 * on. Answering with the first of them asked the membership question about
 * whichever board the store iterated first, so a doc filed on two boards was
 * refused to a visitor who holds the second.
 *
 * The canonical shape ends that class of bug rather than working around it:
 * the board is the first segment, so there is exactly one candidate and it
 * came from the caller rather than from a resolver.
 */
function pathWorkspaces(pathname: string): string[] {
  /** The first path segment after `prefix`, or null when it doesn't match. */
  const seg = (prefix: string): string | null => {
    if (!pathname.startsWith(prefix)) return null;
    const rest = pathname.slice(prefix.length);
    const slash = rest.indexOf('/');
    const s = slash < 0 ? rest : rest.slice(0, slash);
    return s === '' ? null : safeDecode(s);
  };

  // The canonical shape spells the workspace out, so there is nothing left to
  // resolve: ONE candidate, read straight off the path.
  //
  // This used to be five branches — `/workspaces/`, `/api/reviews/`,
  // `/api/tasks/` through `task:<id>`, `/y/ws:<id>`, and a doc resolved from
  // four more prefixes — because four of those addresses named a resource and
  // left the server to work out which board it was on. That derivation is
  // exactly what moving the board into the path deletes, HERE as much as in
  // the guard: a path under `/workspaces/<id>/` names its board in its first
  // segment, whatever collection follows.
  const named = seg('/workspaces/');
  if (named) return [named];

  // Nothing else names a workspace. `/review/<docId>` and `/mockup/<docId>`
  // were the last two addresses that made this function resolve a board from
  // a doc, and they are deleted; `workspacesOf` is kept in the signature
  // because the guard's other caller still passes it and removing a
  // parameter is not what this change is about.
  return [];
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
