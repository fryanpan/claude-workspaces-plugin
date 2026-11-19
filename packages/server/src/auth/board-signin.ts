/**
 * Better Auth sign-in, one copy per machine.
 *
 * Every machine — the Mac, each Fly project — runs its own instance, so a
 * sign-in at one means nothing at another. Three things keep them apart:
 *
 * 1. **Its own user list**: `<dataDir>/signin.sqlite`, mode 600. A session is
 *    a row there; a cookie naming a row this machine never wrote signs
 *    nobody in, whatever its signature.
 * 2. **Its own secret**: derived from this machine's cookie key file through
 *    `tokenKey`, under a key domain of its own (`SIGNIN_KEY_DOMAIN`). Two data
 *    directories never derive the same secret.
 * 3. **Cookies for its own address only**: every cookie is named
 *    `__Host-cw-ba.…`, `Secure`, `Path=/`, with no `Domain`, so the browser
 *    returns it only to the exact host that set it — never to a sibling under
 *    the zone — and the board router keeps it because of the prefix.
 *
 * Better Auth signs its own cookie, so this is a fourth signing scheme beside
 * the three in `signed-token.ts`; the library brings it. Its key still comes
 * from `tokenKey`, so the one key file stays the root of every secret.
 *
 * Google is a generic OAuth provider with explicit endpoints, so a test points
 * them at a local stub and nothing leaves the machine. Two Google doors stay
 * shut on purpose: an ID token POSTed straight to `/sign-in/social` (every
 * project shares one Google client, so a token issued at one project would
 * verify at another), refused here before Better Auth reads the body; and
 * sign-up, which no route offers — an account is made only for an address a
 * board on this machine is shared with (`mayHaveAccount`).
 */
import type { Database } from 'bun:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { normalizeEmail } from '@claude-workspaces/core';
import type { Auth } from './board-signin-auth.ts';
import {
  type PasswordSignIn,
  createLinkThrottle,
  handlePasswordRoute,
  noticeFor,
  passwordFormsHtml,
} from './board-signin-password.ts';
import { tokenKey } from './signed-token.ts';

/** The key domain this machine's Better Auth secret is derived under. */
export const SIGNIN_KEY_DOMAIN = 'cw-better-auth-v1';

/** Every cookie Better Auth sets here starts with this. */
export const SIGNIN_COOKIE_PREFIX = '__Host-cw-ba';

/** Where Better Auth's routes live. Google's return address is under it. */
export const SIGNIN_BASE_PATH = '/api/auth';

/** The page a browser is sent to when it is not signed in. */
export const SIGNIN_PAGE_PATH = '/auth/sign-in';

/** The form on that page posts here; the answer is a redirect to Google. */
export const SIGNIN_GOOGLE_PATH = '/auth/sign-in/google';

/** Google's published OAuth endpoints. Tests replace them with a local stub. */
export interface GoogleEndpoints {
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
};

/** The one Google client every project shares (plan 3.3). */
export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  /** Code-level override only: no setting can point verification elsewhere. */
  endpoints?: GoogleEndpoints;
}

export interface BoardSignInOptions {
  dataDir: string;
  /** The contents of this machine's cookie key file (`loadCookieKey`). */
  baseKey: string;
  /** The one https origin sign-in lives on, such as `https://workspaces.<zone>`. */
  origin: string;
  google: GoogleClient;
  /**
   * May this address hold an account here? Asked before Better Auth writes a
   * user row. Yes only for the owner and for an address a board on this
   * machine is shared with; `verified` is whether the provider vouched for it.
   */
  mayHaveAccount: (email: string, verified: boolean) => boolean;
  /**
   * Told each session the moment it is created, at the Google callback. The
   * lock-out guard records the owner here: while Access is still in front,
   * every later request carries an Access stamp that admits first, so a
   * session-only request may never come.
   */
  onSessionCreated?: (person: { email: string; emailVerified: boolean }) => void;
  /** Email and password beside Google (`board-signin-password.ts`), or absent. */
  password?: PasswordSignIn;
}

/** Who a request's sign-in cookie names, when it names anyone. */
export interface SignedInPerson {
  email: string;
  /** Google said so, or the person followed a link emailed to the address. */
  emailVerified: boolean;
  /** The Google Workspace domain the account belongs to, when Google said. */
  hd: string | null;
  /** When the session was made, in seconds — what a fresh sign-in counts from. */
  issuedAt: number;
}

export interface BoardSignIn {
  /** `https://host`, no trailing slash. */
  origin: string;
  /** The bare lower-case hostname of `origin`. */
  host: string;
  /**
   * Answer a request on one of the sign-in paths, or null when the path is
   * not one of them. Called before admission, so only paths that must work
   * for a person with no session are claimed.
   */
  handle(req: Request, pathname: string): Promise<Response | null>;
  /** Who this request's cookie signs in, or null. */
  personOf(req: Request): Promise<SignedInPerson | null>;
  close(): void;
}

/** This machine's Better Auth secret. Exported for the isolation test. */
export function signInSecret(baseKey: string): string {
  return tokenKey(baseKey, { keyDomain: SIGNIN_KEY_DOMAIN });
}

/**
 * The Better Auth routes a browser may reach, by exact path. A route the
 * library adds in a later version stays closed until it is named here.
 */
const BETTER_AUTH_PATHS: ReadonlySet<string> = new Set([
  `${SIGNIN_BASE_PATH}/sign-in/social`,
  `${SIGNIN_BASE_PATH}/callback/google`,
  `${SIGNIN_BASE_PATH}/get-session`,
  `${SIGNIN_BASE_PATH}/sign-out`,
]);

/**
 * `<dataDir>/signin.sqlite`, created mode 600 before SQLite opens it. The
 * WAL and its index hold session rows in plain text; SQLite creates them
 * with the main file's mode, and a pair an earlier run left looser is
 * tightened here, before and after the open.
 */
function openUserList(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'signin.sqlite');
  closeSync(openSync(path, 'a', 0o600));
  tighten(path);
  // Loaded here rather than imported: `server.ts` reaches this module, and
  // suites that run on node (scripts/*.test.ts) import `server.ts` without
  // ever turning sign-in on. `bun:sqlite` exists only under Bun.
  const sqlite = createRequire(import.meta.url)('bun:sqlite') as { Database: typeof Database };
  const Sqlite = sqlite.Database;
  const db = new Sqlite(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  tighten(path);
  return db;
}

function tighten(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) chmodSync(file, 0o600);
  }
}

/**
 * Better Auth's rate limits, counted per instance: a fixed window per key
 * (client address and path), keyed as the library keys them. Its stricter
 * built-in rules for the sign-in paths still apply; this only holds the
 * counts.
 */
export function ownRateLimitStore(now: () => number = Date.now) {
  const hits = new Map<string, { count: number; start: number }>();
  const MAX_KEYS = 10_000;
  return {
    async consume(key: string, rule: { window: number; max: number }) {
      const at = now();
      const windowMs = rule.window * 1000;
      if (hits.size > MAX_KEYS) {
        for (const [k, e] of hits) if (at - e.start >= windowMs) hits.delete(k);
      }
      const entry = hits.get(key);
      if (!entry || at - entry.start >= windowMs) {
        hits.set(key, { count: 1, start: at });
        return { allowed: true, retryAfter: null };
      }
      if (entry.count >= rule.max) {
        return { allowed: false, retryAfter: Math.ceil((entry.start + windowMs - at) / 1000) };
      }
      entry.count += 1;
      return { allowed: true, retryAfter: null };
    },
  };
}

/** Build this machine's sign-in. The tables are made on first use. */
export function createBoardSignIn(opts: BoardSignInOptions): BoardSignIn {
  const origin = new URL(opts.origin).origin;
  if (!origin.startsWith('https://')) {
    throw new Error(`sign-in origin must be https (got ${origin})`);
  }
  const host = new URL(origin).hostname;
  const db = openUserList(opts.dataDir);
  const password = opts.password;
  const throttle = createLinkThrottle(password?.linkLimits);
  // Loaded on first use, so a machine on `access` never loads the library.
  const loaded = import('./board-signin-auth.ts').then(async (m) => {
    const auth = m.createAuth(
      {
        origin,
        basePath: SIGNIN_BASE_PATH,
        secret: signInSecret(opts.baseKey),
        cookiePrefix: SIGNIN_COOKIE_PREFIX,
        google: { ...opts.google, endpoints: opts.google.endpoints ?? GOOGLE_ENDPOINTS },
        rateLimitStore: ownRateLimitStore(),
        mayHaveAccount: opts.mayHaveAccount,
        ...(password ? { password: true } : {}),
        ...(opts.onSessionCreated ? { onSessionCreated: opts.onSessionCreated } : {}),
      },
      db,
    );
    await m.migrate(auth);
    return {
      auth,
      accounts: m.createPasswordAccounts(auth, db, { origin, mayHaveAccount: opts.mayHaveAccount }),
    };
  });
  const ready: Promise<Auth> = loaded.then((l) => l.auth);

  /** The request as Better Auth must see it: on the sign-in origin. */
  const onOrigin = (req: Request, pathname: string, init: RequestInit = {}): Request => {
    const search = new URL(req.url).search;
    return new Request(`${origin}${pathname}${search}`, {
      method: req.method,
      headers: req.headers,
      ...init,
    });
  };

  const handle = async (req: Request, pathname: string): Promise<Response | null> => {
    if (pathname === SIGNIN_PAGE_PATH && req.method === 'GET') {
      return signInPage(new URL(req.url).searchParams, password?.turnstile.siteKey ?? null);
    }
    if (password) {
      const answer = await handlePasswordRoute(
        {
          origin,
          host,
          password,
          accounts: async () => (await loaded).accounts,
          throttle,
          safeNext,
          call: async (r, path, body) =>
            (await ready).handler(
              onOrigin(r, `${SIGNIN_BASE_PATH}${path}`, {
                method: 'POST',
                headers: withJson(r.headers),
                body: JSON.stringify(body),
              }),
            ),
        },
        req,
        pathname,
      );
      if (answer) return answer;
    }
    if (pathname === SIGNIN_GOOGLE_PATH && req.method === 'POST') {
      if (req.headers.get('origin') !== origin) return refuse(403, 'cross_site_form');
      const form = await req.formData().catch(() => null);
      const next = safeNext(form?.get('next'));
      const auth = await ready;
      const res = await auth.handler(
        onOrigin(req, `${SIGNIN_BASE_PATH}/sign-in/social`, {
          method: 'POST',
          headers: withJson(req.headers),
          body: JSON.stringify({ provider: 'google', callbackURL: next, disableRedirect: true }),
        }),
      );
      if (!res.ok) return res;
      const { url } = (await res.json()) as { url?: string };
      if (!url) return refuse(502, 'no_authorization_url');
      const out = new Headers({ location: url, 'cache-control': 'no-store' });
      for (const c of res.headers.getSetCookie()) out.append('set-cookie', c);
      return new Response(null, { status: 303, headers: out });
    }
    if (!BETTER_AUTH_PATHS.has(pathname)) return null;
    if (pathname === `${SIGNIN_BASE_PATH}/sign-in/social` && req.method === 'POST') {
      // Read a copy: the original body still goes to Better Auth below.
      const body = (await req
        .clone()
        .json()
        .catch(() => null)) as { idToken?: unknown } | null;
      if (body && body.idToken !== undefined) return refuse(400, 'id_token_sign_in_disabled');
    }
    const auth = await ready;
    return auth.handler(onOrigin(req, pathname, { body: req.body }));
  };

  const personOf = async (req: Request): Promise<SignedInPerson | null> => {
    const cookie = req.headers.get('cookie');
    if (!cookie?.includes(SIGNIN_COOKIE_PREFIX)) return null;
    const auth = await ready;
    const found = await auth.api.getSession({ headers: new Headers({ cookie }) }).catch(() => null);
    if (!found) return null;
    const user = found.user as { email: string; emailVerified: boolean; hd?: string | null };
    return {
      email: normalizeEmail(user.email),
      emailVerified: user.emailVerified === true,
      hd: user.hd ?? null,
      issuedAt: Math.floor(new Date(found.session.createdAt).getTime() / 1000),
    };
  };

  return { origin, host, handle, personOf, close: () => db.close() };
}

function withJson(headers: Headers): Headers {
  const out = new Headers(headers);
  out.set('content-type', 'application/json');
  out.delete('content-length');
  return out;
}

/**
 * A same-site path to come back to, or `/`. Never another origin. Refuses
 * control characters, because a browser strips tab, CR and LF from a URL
 * (`/\t/x` would become `//x`), and encoded slashes, which a later decode
 * could turn into the same thing.
 */
export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2048) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  if (/[\u0000-\u001f\u007f]/.test(raw)) return '/';
  if (/%(2f|5c)/i.test(raw)) return '/';
  return raw;
}

function refuse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The sign-in page: Google's button, and where passwords are on, their forms
 * with Cloudflare's Turnstile widget (the page sends no CSP, so its script
 * needs no exception).
 */
function signInPage(query: URLSearchParams, siteKey: string | null): Response {
  const rawNext = safeNext(query.get('next'));
  const next = escapeAttr(rawNext);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title></head>
<body style="font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 90vh;">
<main style="text-align: center;">
<h1 style="font-size: 1.4rem;">Sign in to Claude Workspaces</h1>
<form method="post" action="${SIGNIN_GOOGLE_PATH}">
<input type="hidden" name="next" value="${next}">
<button type="submit" style="font-size: 1rem; padding: 0.6rem 1.2rem;">Continue with Google</button>
</form>
${siteKey === null ? '' : `${noticeFor(query)}${passwordFormsHtml(rawNext, siteKey)}`}
</main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
