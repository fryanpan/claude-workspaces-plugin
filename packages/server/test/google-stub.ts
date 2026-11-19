/**
 * A local stand-in for Google's OAuth token and userinfo endpoints, so a
 * sign-in test runs the whole Better Auth dance with nothing leaving the
 * machine. Also a cookie jar and the browser half of the dance, shared by the
 * sign-in suites.
 */
import type { GoogleEndpoints } from '../src/auth/board-signin.ts';

export interface GoogleProfile {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  hd?: string;
}

export interface GoogleStub {
  endpoints: GoogleEndpoints;
  /** Registers the profile Google returns for the next code exchange. */
  issueCode(profile: GoogleProfile): string;
  /** Every `client_id` the token endpoint was sent. */
  clientIds: string[];
  stop(): void;
}

export function startGoogleStub(): GoogleStub {
  const codes = new Map<string, GoogleProfile>();
  const tokens = new Map<string, GoogleProfile>();
  const clientIds: string[] = [];
  let next = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await req.text());
        clientIds.push(form.get('client_id') ?? '');
        const profile = codes.get(form.get('code') ?? '');
        if (!profile) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        codes.delete(form.get('code') ?? '');
        const accessToken = `access-${++next}`;
        tokens.set(accessToken, profile);
        return Response.json({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid email profile',
        });
      }
      if (url.pathname === '/userinfo') {
        const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
        const profile = tokens.get(bearer);
        return profile
          ? Response.json(profile)
          : Response.json({ error: 'invalid_token' }, { status: 401 });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    endpoints: {
      authorizationUrl: `${base}/authorize`,
      tokenUrl: `${base}/token`,
      userInfoUrl: `${base}/userinfo`,
    },
    issueCode(profile) {
      const code = `code-${++next}`;
      codes.set(code, profile);
      return code;
    },
    clientIds,
    stop: () => server.stop(true),
  };
}

let browsers = 0;

/** `name=value` pairs a browser would hold, from the responses it saw. */
export class CookieJar {
  readonly cookies = new Map<string, string>();
  /**
   * This browser's own address, as Cloudflare names it (`cf-connecting-ip`),
   * from a documentation range. One per browser, as in life, so one suite's
   * sign-ins do not share a rate-limit bucket.
   */
  readonly ip = `198.51.100.${(browsers++ % 250) + 1}`;
  /** Every raw `Set-Cookie` header seen, in order. */
  readonly seen: string[] = [];

  take(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      this.seen.push(raw);
      const pair = raw.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = /max-age=0\b/i.test(raw) || value === '';
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([n, v]) => `${n}=${v}`).join('; ');
  }
}

/** One request as a browser on `origin` would send it, through `send`. */
export type Send = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Press "Continue with Google" on `origin`'s sign-in page and come back from
 * Google as `profile`. Answers the callback's response; the jar holds every
 * cookie the browser would.
 */
export async function signInWithGoogle(
  send: Send,
  origin: string,
  jar: CookieJar,
  google: GoogleStub,
  profile: GoogleProfile,
  next = '/',
): Promise<{ authorize: URL; callback: Response }> {
  const start = await send('/auth/sign-in/google', {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/x-www-form-urlencoded',
      'cf-connecting-ip': jar.ip,
      cookie: jar.header(),
    },
    body: new URLSearchParams({ next }).toString(),
  });
  if (start.status !== 303) {
    throw new Error(`sign-in start answered ${start.status}: ${await start.text()}`);
  }
  jar.take(start);
  const authorize = new URL(start.headers.get('location') ?? '');
  const back = new URL(authorize.searchParams.get('redirect_uri') ?? '');
  back.searchParams.set('code', google.issueCode(profile));
  back.searchParams.set('state', authorize.searchParams.get('state') ?? '');
  const callback = await send(`${back.pathname}${back.search}`, {
    headers: { cookie: jar.header(), 'cf-connecting-ip': jar.ip },
  });
  jar.take(callback);
  return { authorize, callback };
}
