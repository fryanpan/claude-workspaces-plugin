/**
 * Who may reach this server, over which hostname — built once, from the
 * settings this deployment resolved.
 *
 * The composition root has two halves already: `server-config.ts` decides
 * what the environment says, and `server-deps.ts` builds the adapters that
 * talk OUT (Postmark, Recall, the deployer). This is the third piece and it
 * faces the other way: the sharing registry, the share-link store, the
 * sharing master switch, and the three Cloudflare Access verifiers with the
 * host lists each of them arms. It reads no environment and serves no
 * request; what comes back is a bag of long-lived collaborators the request
 * chain then consults.
 *
 * They are one family rather than five because the three verifiers are
 * written in terms of each other. A shared one would refuse every
 * collaboration request with `no_share_for_host`, and the fail-closed rule —
 * null, and the whole host list ignored, unless BOTH halves are configured —
 * is stated three times because it has to hold three times. Splitting them
 * would leave that rule in one file and the lists it governs in another.
 *
 * Lifted verbatim out of the top of `createServer`.
 */
import { normalizeEmail } from '@claude-workspaces/core';
import type { PasswordSignIn } from './auth/board-signin-password.ts';
import { type GoogleClient, createBoardSignIn } from './auth/board-signin.ts';
import { createOwnerSignInRecord } from './auth/owner-signin-record.ts';
import { type CfAccessOptions, createCfAccessVerifier } from './middleware/cf-access.ts';
import type { ShareTarget } from './middleware/host-guard.ts';
import { type SignInMode, createSignInDoor } from './middleware/signin-door.ts';
import { CfApi } from './share/cf-api.ts';
import { loadCookieKey } from './share/link-session.ts';
import { ShareLinks } from './share/share-links.ts';
import { Shares } from './share/shares.ts';
import { SharingGate } from './share/sharing-gate.ts';
import type { Share, ShareConfig } from './share/types.ts';

/**
 * The `ServerOptions` fields these adapters are built from, and no more.
 *
 * Structural rather than importing `ServerOptions`: that type lives in
 * server.ts, which imports this module, so naming it here would close a
 * cycle. Adding a field is therefore a decision somebody makes in this list.
 */
export interface AccessDepsOptions {
  share?: { config: ShareConfig; cfApiToken?: string; cfApi?: CfApi };
  shareLinkHosts?: string[];
  shareLinkAudience?: string;
  sharingEnvLocked?: boolean;
  cfAccess?: CfAccessOptions;
  accessTunnelHosts?: string[];
  proxiedTrustedHosts?: string[];
  proxiedTrustedEmails?: string[];
  recallCallbackHost?: string;
  /** `CW_SIGNIN` and what Better Auth needs (`middleware/signin-door.ts`).
   *  Absent is `access`: today's Cloudflare Access sign-in, unchanged. */
  signIn?: {
    mode: SignInMode;
    origin: string;
    google: GoogleClient;
    password?: PasswordSignIn;
    localOnly?: boolean;
    extraAccounts?: readonly string[];
  };
}

export interface AccessDepsContext {
  /** Where the share registry, the link store and the cookie key live. */
  dataDir: string;
  /** The resolved settings, narrowed to what this file builds from. */
  opts: AccessDepsOptions;
  /**
   * Whether a workspace id names a BOARD.
   *
   * A thunk because the task store is built after these adapters and
   * `boardShareTarget` is only ever asked at request time — the same forward
   * reference it was when both lived in one closure.
   */
  isBoard: (workspaceId: string) => boolean;
  /**
   * May this address hold a Better Auth account here: the owner, or an
   * address a board on this machine is shared with. A thunk for the reason
   * `isBoard` is: membership is built after these adapters.
   */
  mayHaveAccount?: (email: string, verified: boolean) => boolean;
  /** Told each address a Better Auth session admitted. */
  onSignInPerson?: (email: string) => void;
}

/** Build the sharing and Access adapters once per server. */
export function createAccessDeps(ctx: AccessDepsContext) {
  const { dataDir, opts, isBoard } = ctx;
  let shares: Shares | null = null;
  if (opts.share) {
    // Only build a Cloudflare client when the embedder handed one, or a
    // token. The board server hands neither (`server-deps.ts`).
    const accountId = opts.share.config.cfAccountId;
    const cfApi =
      opts.share.cfApi ??
      (accountId && opts.share.cfApiToken
        ? new CfApi({ accountId, token: opts.share.cfApiToken })
        : undefined);
    shares = new Shares({
      dataDir,
      cfApi,
      config: opts.share.config,
    });
  }

  /**
   * Share links and the workspace membership redeeming one creates.
   *
   * Built ALWAYS, not only when `opts.share` is set, and the difference
   * matters: a `Shares` registry exists to talk to Cloudflare, so a
   * deployment with no Cloudflare wiring has none. A share link needs no
   * Cloudflare API at all — only an Access application the operator made by
   * hand — so the store that answers "is this email a member of this
   * workspace" must exist wherever the gate can be asked, and a null one
   * would have to be read as "nobody is a member" at exactly the place that
   * decides who gets in.
   */
  const shareLinks = new ShareLinks({ dataDir });
  // The upgrade that gave boards an audience also seeds it from the older
  // Cloudflare shares still live, so nobody they let in loses access.
  shareLinks.seedFromOlderShares(
    (shares?.list() ?? []).filter((s) => s.mode !== 'link' && s.expiresAt > Date.now()),
  );

  /**
   * The hostname share URLs are built from — the first configured share host.
   * Empty when the deployment has none, which is what the mint route refuses
   * on: a link whose URL names no hostname is a link nobody can open.
   */
  const shareLinkHosts = opts.shareLinkHosts ?? [];
  const shareLinkBaseHost = shareLinkHosts[0] ?? '';

  /**
   * The Access verifier for the SHARE hostname — its own application, its own
   * audience, built from `shareLinkAudience` and never from `cfAccess`.
   *
   * This is the audience cross-check, and it is one line because it is
   * structural rather than a comparison somewhere: a token minted for the
   * owner's application carries the owner's AUD and simply fails `jwtVerify`
   * here, and a token minted at the everyone-policy share sign-in fails at
   * the owner's verifier for the mirror reason. Neither check can be
   * forgotten, because neither is a check.
   *
   * Null — and the whole host list ignored — unless BOTH a team domain and
   * the share audience are configured. `server-config.ts` warns at boot; this
   * is the half in the request path, for an embedded caller that never goes
   * through bin.ts.
   */
  const shareLinkVerifier =
    opts.cfAccess?.teamDomain && opts.shareLinkAudience
      ? createCfAccessVerifier({
          teamDomain: opts.cfAccess.teamDomain,
          audience: opts.shareLinkAudience,
          ...(opts.cfAccess.jwks ? { jwks: opts.cfAccess.jwks } : {}),
        })
      : null;

  /**
   * The master switch for external access. Consulted on every request whose
   * Host is a share or link host, AHEAD of authentication — see the host
   * decision block below.
   */
  const sharingGate = new SharingGate({
    dataDir,
    envLocked: opts.sharingEnvLocked ?? false,
  });

  // Root HMAC key for this server's own tokens — the email session cookie and
  // the widget token derive from it. Made at boot, mode 600, so the key file
  // exists before the first request: the wall report's cross-project probe
  // (`infra/project-machine/wall-probe.ts`) reads it and refuses a missing one.
  const cookieKeyValue = loadCookieKey(dataDir);
  const cookieKey = (): string => cookieKeyValue;

  /**
   * What a share may reach — or null, when it may reach nothing.
   *
   * A BOARD is the unit of sharing (Bryan, 2026-08-17). Minting a share of a
   * folder bind or diff review is refused at the route, but a record written
   * BEFORE that keeps its slug and its already-signed session cookies, so the
   * mint guard alone would retire the grant everywhere except where it is
   * actually exercised. This is that place: every serving path resolves a
   * share through here, and a share whose workspace is not a board resolves
   * to nothing.
   *
   * Deliberately not a drop in `Shares.load`, which is how the per-doc
   * removal did it. Two reasons: `Shares` has no way to ask what a board is
   * (only `taskStore` knows), and a load-time drop would destroy a row an
   * operator can still want to list and revoke. Removing a capability is not
   * deleting user content.
   */
  const boardShareTarget = (share: Share | null | undefined): ShareTarget | null => {
    if (!share?.workspaceId) return null;
    if (!isBoard(share.workspaceId)) return null;
    return { workspaceId: share.workspaceId };
  };

  // When shares is wired, automatically derive the cf-access audience from
  // the registry so each share-<slug> host can use its own AUD. Callers
  // can still override by passing cfAccess.audience explicitly.
  const cfAccessConfig =
    opts.cfAccess && shares
      ? { ...opts.cfAccess, audience: shares.audienceResolver }
      : opts.cfAccess;
  const cfAccessVerifier = cfAccessConfig ? createCfAccessVerifier(cfAccessConfig) : null;

  /**
   * The Access verifier for the collaboration hostnames — its OWN verifier,
   * built from the static env audience rather than the share registry's
   * per-hostname resolver.
   *
   * That separation is not tidiness, it is the only thing that makes the
   * feature work beside link sharing. When `shares` is wired, the resolver
   * above answers `null` for any host that is not a live share hostname, and
   * a collaboration host is by definition not one — so a shared verifier
   * would refuse every collab request with `no_share_for_host`. Cloudflare
   * issues one AUD per Access application, and the collaboration hostname has
   * its own application, so the static `CF_ACCESS_AUD` is the right tag for it.
   *
   * Null — and therefore the whole opt-in list ignored — unless BOTH a
   * hostname is listed and `cfAccess` carries a string audience. This is the
   * server-side half of the refusal; bin.ts also warns at boot. Two checks
   * because only this one is in the request path: an embedded caller that
   * never goes through bin.ts must fail closed too.
   */
  /**
   * This machine's own sign-in (`CW_SIGNIN`), when it runs Better Auth. The
   * static verifier below is the one every door that asks "who is this?"
   * runs, so composing it here is the whole wiring: in `both` it takes an
   * Access stamp or a session, in `better-auth` only a session, and in
   * `access` it is the Access verifier it always was.
   */
  const proxiedTrustedEmails = new Set(
    (opts.proxiedTrustedEmails ?? []).map((e) => normalizeEmail(e)).filter((e) => e !== ''),
  );
  const signInMode: SignInMode = opts.signIn?.mode ?? 'access';
  // The lock-out guard: `better-auth` runs as `both` until the owner has
  // signed in here once. The record is written when the session is made, at
  // Google's callback — not on a later request, because while Access is
  // still in front its stamp admits every later request before a session is
  // read.
  const ownerSignIn = createOwnerSignInRecord(dataDir);
  const recordOwner = (email: string, verified: boolean) => {
    if (verified && proxiedTrustedEmails.has(email)) ownerSignIn.record(email);
  };
  const boardSignIn =
    opts.signIn && signInMode !== 'access'
      ? createBoardSignIn({
          dataDir,
          baseKey: cookieKey(),
          origin: opts.signIn.origin,
          google: opts.signIn.google,
          ...(opts.signIn.password ? { password: opts.signIn.password } : {}),
          ...(opts.signIn.localOnly ? { localOnly: true } : {}),
          mayHaveAccount: (email, verified) =>
            (verified && (opts.signIn?.extraAccounts ?? []).includes(email)) ||
            (ctx.mayHaveAccount?.(email, verified) ?? false),
          onSessionCreated: (p) => recordOwner(p.email, p.emailVerified),
        })
      : null;
  const signInDoor = createSignInDoor({
    mode: signInMode,
    signIn: boardSignIn,
    onPerson: (email) => {
      recordOwner(email, true);
      ctx.onSignInPerson?.(email);
    },
    ownerSignedIn: () => ownerSignIn.read() !== null,
  });
  const staticAccessVerifier = signInDoor.verifier(
    opts.cfAccess && typeof opts.cfAccess.audience === 'string'
      ? createCfAccessVerifier(opts.cfAccess)
      : null,
  );
  const accessTunnelHosts = opts.accessTunnelHosts ?? [];
  const collabAccessVerifier = accessTunnelHosts.length > 0 ? staticAccessVerifier : null;
  /**
   * The verifier for the operator's own proxied hostnames — the same static
   * audience verifier, for the same reason: the hostname has its own Access
   * application, and the per-share resolver cannot answer for it. Null, and
   * the whole list ignored, unless Access really is configured AND somebody
   * is named as the operator; bin.ts also refuses at boot, but this check is
   * the one in the request path.
   */
  // The local test sign-in's address is not on the list (it must not
  // classify through the edge), but it is verified the same way.
  const proxiedTrustedVerifier =
    ((opts.proxiedTrustedHosts ?? []).length > 0 || signInDoor.localHost !== null) &&
    proxiedTrustedEmails.size > 0
      ? staticAccessVerifier
      : null;
  // The list as the gate and the origin policy see it: EMPTY unless everything
  // needed to honour it exists, so a half-configured deployment answers
  // 403 unknown_host rather than reaching a branch that then has to refuse.
  const proxiedTrustedHosts = proxiedTrustedVerifier ? (opts.proxiedTrustedHosts ?? []) : [];
  /**
   * Recall's dedicated callback hostname, or null.
   *
   * Deliberately NOT conditioned on a verifier the way the list above is:
   * there is no Access application in front of this name and there cannot be
   * one (Recall's backend has no browser). What arms it is the credential
   * each of its two routes carries, checked per request in
   * `recallCallbackAllows` — so a server with no Recall key and no webhook
   * secret answers 404 to everything on the hostname rather than serving a
   * route with nothing behind it.
   */
  const recallCallbackHost = opts.recallCallbackHost?.trim() || null;

  return {
    shares,
    shareLinks,
    shareLinkHosts,
    shareLinkBaseHost,
    shareLinkVerifier,
    sharingGate,
    cookieKey,
    boardShareTarget,
    cfAccessVerifier,
    staticAccessVerifier,
    accessTunnelHosts,
    collabAccessVerifier,
    proxiedTrustedEmails,
    proxiedTrustedVerifier,
    proxiedTrustedHosts,
    recallCallbackHost,
    boardSignIn,
    signInDoor,
    ownerSignIn,
  };
}
