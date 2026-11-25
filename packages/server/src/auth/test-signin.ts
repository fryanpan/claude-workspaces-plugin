/**
 * The local test sign-in: `CW_TEST_SIGNIN=1` (or `bun run staging
 * --test-signin`) lets an agent sign Alice and Bob into a staging server, so
 * flows that need two people can be run end to end with no Google account
 * and no secret.
 *
 * It is the real Better Auth sign-in (`board-signin.ts`) with one thing
 * swapped: Google. A fake Google runs in the same process on a loopback
 * port of its own, and its authorize page is a chooser — "Alice" or "Bob" —
 * instead of a Google account. Everything after the callback (the session
 * cookie, the owner allowlist, board membership) is the code prod runs.
 *
 * - Sign-in lives on `http://signin.localhost:<port>`. A browser resolves
 *   every `*.localhost` name to loopback by itself, and the name is not a
 *   loopback name to the host guard, so a request there is a signed-in
 *   person rather than the box. `127.0.0.1:<port>` stays the box, as before.
 * - Alice is the owner. Bob may hold an account but reaches only what is
 *   shared with him, exactly as a share member does.
 *
 * Refused, at boot, on prod's port (or any port another fleet service owns),
 * on a bind wider than loopback, with a real Google client configured, and
 * beside another `CW_SIGNIN` mode. Refused per request on anything carrying
 * `cf-ray`: a request that came through Cloudflare is never a test.
 */
import { reservedPortError } from '../reserved-ports.ts';
import type { GoogleEndpoints } from './board-signin.ts';

/** The sign-in address's hostname. The port is the server's own. */
export const TEST_SIGNIN_HOST = 'signin.localhost';

/** The two people the chooser offers. Fixture addresses only. */
export const TEST_SIGNIN_PEOPLE = {
  alice: { email: 'alice@harborlight.test', name: 'Alice' },
  bob: { email: 'bob@harborlight.test', name: 'Bob' },
} as const;

export const TEST_SIGNIN_OWNER = TEST_SIGNIN_PEOPLE.alice.email;

/** Not a secret: the fake Google accepts nothing else, and no real one knows it. */
const CLIENT = 'cw-test-signin';

const LOOPBACK_BINDS = new Set(['127.0.0.1', 'localhost', '::1']);

export interface TestSignInSetting {
  /** `http://signin.localhost:<port>`. */
  origin: string;
  owner: string;
}

/** `CW_TEST_SIGNIN`, given the port and the bind address the server will use. */
export function testSignInFromEnv(
  env: NodeJS.ProcessEnv,
  where: { port: number; bindHost: string | undefined },
): { setting: TestSignInSetting | null } | { error: string } {
  const raw = (env.CW_TEST_SIGNIN ?? '').trim();
  if (raw === '' || raw === '0') return { setting: null };
  if (raw !== '1') return { error: `CW_TEST_SIGNIN must be 1 (got ${raw})` };
  const portError = reservedPortError(where.port);
  if (portError) return { error: `CW_TEST_SIGNIN refused: ${portError}` };
  if (!Number.isInteger(where.port) || where.port <= 0) {
    return { error: 'CW_TEST_SIGNIN needs a fixed port, so the sign-in address can name it' };
  }
  if ((env.CW_GOOGLE_CLIENT_ID ?? '').trim() || (env.CW_GOOGLE_CLIENT_SECRET ?? '').trim()) {
    return {
      error: 'CW_TEST_SIGNIN refused: CW_GOOGLE_CLIENT_ID is set, so this is a real sign-in',
    };
  }
  const mode = (env.CW_SIGNIN ?? '').trim().toLowerCase();
  if (mode !== '' && mode !== 'access') {
    return { error: `CW_TEST_SIGNIN refused: CW_SIGNIN=${mode} is set; use one or the other` };
  }
  if (!where.bindHost || !LOOPBACK_BINDS.has(where.bindHost)) {
    return {
      error: `CW_TEST_SIGNIN refused: the server must bind loopback (--host 127.0.0.1), got ${where.bindHost ?? 'every interface'}`,
    };
  }
  return {
    setting: { origin: `http://${TEST_SIGNIN_HOST}:${where.port}`, owner: TEST_SIGNIN_OWNER },
  };
}

/** The `createServer` options the setting stands for, once the fake Google is up. */
export function testSignInOptions(setting: TestSignInSetting, endpoints: GoogleEndpoints) {
  return {
    proxiedTrustedHosts: [TEST_SIGNIN_HOST],
    proxiedTrustedEmails: [setting.owner],
    signIn: {
      mode: 'better-auth' as const,
      origin: setting.origin,
      google: { clientId: CLIENT, clientSecret: CLIENT, endpoints },
      localOnly: true,
      extraAccounts: Object.values(TEST_SIGNIN_PEOPLE).map((p) => p.email),
    },
  };
}

export interface TestGoogle {
  endpoints: GoogleEndpoints;
  stop(): void;
}

type PersonKey = keyof typeof TEST_SIGNIN_PEOPLE;
const isPerson = (k: unknown): k is PersonKey =>
  typeof k === 'string' && Object.hasOwn(TEST_SIGNIN_PEOPLE, k);

/**
 * The fake Google: an authorize page that offers Alice and Bob, and the
 * token and userinfo endpoints Better Auth calls server to server. Loopback
 * only, and it sends a browser back only to this server's own callback.
 */
export function startTestGoogle(setting: TestSignInSetting): TestGoogle {
  const callback = `${setting.origin}/api/auth/callback/google`;
  const codes = new Map<string, PersonKey>();
  const tokens = new Map<string, PersonKey>();
  const nonce = () => crypto.randomUUID();
  const refuse = (status: number, error: string) => Response.json({ error }, { status });

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (req.headers.has('cf-ray')) return refuse(403, 'test_signin_local_only');
      const url = new URL(req.url);
      if (url.pathname === '/authorize' && req.method === 'GET') {
        const q = url.searchParams;
        if (q.get('client_id') !== CLIENT) return refuse(400, 'unknown_client');
        if (q.get('redirect_uri') !== callback) return refuse(400, 'redirect_uri_mismatch');
        return chooserPage(q.get('state') ?? '', callback);
      }
      if (url.pathname === '/choose' && req.method === 'POST') {
        const form = await req.formData().catch(() => null);
        const person = form?.get('person');
        if (!isPerson(person)) return refuse(400, 'unknown_person');
        if (form?.get('redirect_uri') !== callback) return refuse(400, 'redirect_uri_mismatch');
        const code = nonce();
        codes.set(code, person);
        const back = new URL(callback);
        back.searchParams.set('code', code);
        back.searchParams.set('state', String(form?.get('state') ?? ''));
        return new Response(null, { status: 303, headers: { location: back.toString() } });
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await req.text());
        if (form.get('client_id') !== CLIENT) return refuse(401, 'invalid_client');
        const person = codes.get(form.get('code') ?? '');
        if (!person) return refuse(400, 'invalid_grant');
        codes.delete(form.get('code') ?? '');
        const accessToken = nonce();
        tokens.set(accessToken, person);
        return Response.json({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid email profile',
        });
      }
      if (url.pathname === '/userinfo') {
        const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
        const person = tokens.get(bearer);
        if (!person) return refuse(401, 'invalid_token');
        const { email, name } = TEST_SIGNIN_PEOPLE[person];
        return Response.json({ sub: `test-${person}`, email, email_verified: true, name });
      }
      return refuse(404, 'not_found');
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    endpoints: {
      authorizationUrl: `${base}/authorize`,
      tokenUrl: `${base}/token`,
      userInfoUrl: `${base}/userinfo`,
    },
    stop: () => server.stop(true),
  };
}

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function chooserPage(state: string, callback: string): Response {
  const buttons = Object.entries(TEST_SIGNIN_PEOPLE)
    .map(
      ([key, p]) => `<form method="post" action="/choose">
<input type="hidden" name="person" value="${key}">
<input type="hidden" name="state" value="${escapeAttr(state)}">
<input type="hidden" name="redirect_uri" value="${escapeAttr(callback)}">
<button type="submit" id="as-${key}">${p.name} (${p.email})</button>
</form>`,
    )
    .join('\n');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Test sign-in</title></head>
<body style="font-family: system-ui, sans-serif;">
<h1 style="font-size: 1.2rem;">Test sign-in: choose who you are</h1>
${buttons}
</body></html>`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
