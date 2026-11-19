/**
 * Which sign-in a machine runs, and the door it opens in front of admission.
 *
 * `CW_SIGNIN` has three values (plan 3.5):
 *
 * - `access` — today, and the default. Cloudflare Access stamps every
 *   request; the Better Auth routes do not exist (they answer what any
 *   unknown path answers).
 * - `both` — Access stays in front, and the server accepts either proof: an
 *   Access stamp, or a Better Auth session on the sign-in address. The
 *   step that lets the owner sign in once before Access is taken away.
 * - `better-auth` — the Access stamp is never read. A person is who their
 *   Better Auth session says, on the sign-in address only.
 *
 * Better Auth's answer is shaped as a `CfAccessResult`, so every door that
 * already asks "who is this?" — the owner's own hostname, the collaboration
 * hostnames — asks it unchanged, and everything after (the owner allowlist,
 * membership, the master switch, attribution) is the same code it was.
 *
 * Only a VERIFIED address is ever an answer: Google said so, or the person
 * followed a link emailed to it (plan 3.4). An unverified session names
 * nobody, so a domain share can never admit an address nobody proved.
 */
import type { BoardSignIn, GoogleClient } from '../auth/board-signin.ts';
import { SIGNIN_PAGE_PATH } from '../auth/board-signin.ts';
import type { CfAccessResult, CfAccessVerifier } from './cf-access.ts';
import { normalizeHost } from './host-guard.ts';

export type SignInMode = 'access' | 'both' | 'better-auth';

export const SIGNIN_MODES: readonly SignInMode[] = ['access', 'both', 'better-auth'];

/** `CW_SIGNIN`, or why it was refused. Unset is `access`. */
export function parseSignInMode(raw: string | undefined): SignInMode | { error: string } {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return 'access';
  const mode = SIGNIN_MODES.find((m) => m === value);
  return mode ?? { error: `CW_SIGNIN must be one of ${SIGNIN_MODES.join(', ')} (got ${value})` };
}

/** What `CW_SIGNIN` and its companions resolve to. */
export interface SignInSetting {
  mode: SignInMode;
  origin: string;
  google: GoogleClient;
}

/**
 * `CW_SIGNIN`, `CW_SIGNIN_ORIGIN`, `CW_GOOGLE_CLIENT_ID` and
 * `CW_GOOGLE_CLIENT_SECRET`. `{ setting: null }` in `access` mode; an error
 * when another mode is asked for without everything it needs, because
 * falling back to Access on a machine whose Access application is gone would
 * lock everybody out without a word.
 */
export function signInFromEnv(
  env: NodeJS.ProcessEnv,
): { setting: SignInSetting | null } | { error: string } {
  const mode = parseSignInMode(env.CW_SIGNIN);
  if (typeof mode !== 'string') return mode;
  if (mode === 'access') return { setting: null };
  const rawOrigin = (env.CW_SIGNIN_ORIGIN ?? '').trim();
  let origin: string;
  try {
    origin = new URL(rawOrigin).origin;
  } catch {
    return { error: `CW_SIGNIN=${mode} needs CW_SIGNIN_ORIGIN, an https origin` };
  }
  if (!origin.startsWith('https://')) {
    return { error: `CW_SIGNIN_ORIGIN must be https (got ${origin})` };
  }
  const clientId = (env.CW_GOOGLE_CLIENT_ID ?? '').trim();
  const clientSecret = (env.CW_GOOGLE_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) {
    return { error: `CW_SIGNIN=${mode} needs CW_GOOGLE_CLIENT_ID and CW_GOOGLE_CLIENT_SECRET` };
  }
  return { setting: { mode, origin, google: { clientId, clientSecret } } };
}

export interface SignInDoorOptions {
  mode: SignInMode;
  /** This machine's Better Auth, or null in `access` mode. */
  signIn: BoardSignIn | null;
  /** Told each address a Better Auth session admitted (the owner record). */
  onPerson?: (email: string) => void;
  /**
   * The lock-out guard (`auth/owner-signin-record.ts`): has the owner signed
   * in here through Better Auth? Until it answers yes, `better-auth` runs as
   * `both`, so the Access stamp still opens the board. Absent means yes.
   */
  ownerSignedIn?: () => boolean;
}

export interface SignInDoor {
  /** The configured mode. */
  mode: SignInMode;
  /** The mode in force now: `both` for `better-auth` until the guard opens. */
  effectiveMode(): SignInMode;
  /**
   * The verifier a door runs: the Access verifier given, Better Auth's, or
   * either, by mode. Null when neither half exists.
   */
  verifier(access: CfAccessVerifier | null): CfAccessVerifier | null;
  /**
   * A sign-in route's answer, or null. Asked before the master switch and
   * before any proof is demanded, because these are the routes a person with
   * no session has to reach. Only on the sign-in address.
   */
  claim(req: Request, pathname: string): Promise<Response | null>;
  /**
   * Where a browser page with no proof is sent: the sign-in page on the
   * sign-in address, or the sign-in address itself from any other host this
   * server answers (the Mac's own subdomain, plan choice 4). Null for
   * anything that is not a page load, which keeps its 401.
   */
  redirectFor(req: Request, pathname: string, isPage: boolean): Response | null;
}

const unverified: CfAccessResult = { ok: false, status: 401, error: 'signin_unverified' };
const noSession: CfAccessResult = { ok: false, status: 401, error: 'missing_session' };

export function createSignInDoor(opts: SignInDoorOptions): SignInDoor {
  const { mode, signIn } = opts;
  const active = mode !== 'access' && signIn !== null;
  const effectiveMode = (): SignInMode =>
    mode === 'better-auth' && opts.ownerSignedIn && !opts.ownerSignedIn() ? 'both' : mode;

  const viaSession = async (req: Request): Promise<CfAccessResult> => {
    if (!signIn) return noSession;
    // The cookie is host-only, so it cannot arrive anywhere else; refusing
    // it by Host as well means a forwarded copy proves nothing either.
    if (normalizeHost(req.headers.get('host')) !== signIn.host) return noSession;
    const person = await signIn.personOf(req);
    if (!person) return noSession;
    if (!person.emailVerified) return unverified;
    opts.onPerson?.(person.email);
    return { ok: true, email: person.email, issuedAt: person.issuedAt };
  };

  const verifier = (access: CfAccessVerifier | null): CfAccessVerifier | null => {
    if (!active) return access;
    return async (req) => {
      if (effectiveMode() === 'better-auth') return viaSession(req);
      if (access) {
        const stamped = await access(req);
        if (stamped.ok) return stamped;
        const session = await viaSession(req);
        return session.ok ? session : stamped;
      }
      return viaSession(req);
    };
  };

  const claim = async (req: Request, pathname: string): Promise<Response | null> => {
    if (!active || !signIn) return null;
    if (normalizeHost(req.headers.get('host')) !== signIn.host) return null;
    return signIn.handle(req, pathname);
  };

  const redirectFor = (req: Request, pathname: string, isPage: boolean): Response | null => {
    if (!active || !signIn || !isPage) return null;
    const search = new URL(req.url).search;
    if (normalizeHost(req.headers.get('host')) === signIn.host) {
      const next = encodeURIComponent(`${pathname}${search}`);
      return redirect(302, `${SIGNIN_PAGE_PATH}?next=${next}`);
    }
    // In `both`, Access still fronts the other host and its stamp still
    // works there; only `better-auth` moves every page to the one address.
    if (effectiveMode() !== 'better-auth') return null;
    return redirect(308, `${signIn.origin}${pathname}${search}`);
  };

  return { mode, effectiveMode, verifier, claim, redirectFor };
}

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location, 'cache-control': 'no-store' } });
}
