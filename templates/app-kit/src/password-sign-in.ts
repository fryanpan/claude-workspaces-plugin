/**
 * Password sign-in for the app, on Better Auth over bun:sqlite.
 *
 * The rules (password hashing, email verification before a password signs
 * in, what ends a session, the mails) are `passwordAuthOptions` from the app
 * kit package: the same options the sign-in Worker template runs on D1. This
 * file adds only what is this runtime's own: the SQLite file, the secret,
 * the base URL, an in-process rate limit, and the form pages.
 *
 * A session is Better Auth's: a row in `auth.sqlite` and a signed, HttpOnly,
 * SameSite=Lax cookie naming it. Signing out deletes the row.
 */
import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Mailer, passwordAuthOptions } from '@claude-workspaces/app-kit/auth';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { checkEmailPage, signInPage, signUpPage } from './page.ts';
import { type SignIn, sameOrigin } from './sign-in.ts';

export interface PasswordSignInOptions {
  /** The app's data folder: `auth.sqlite` and, if no secret is given, `auth-secret`. */
  dataDir: string;
  /** The app's public origin, such as `https://notes.example.com`. */
  baseURL: string;
  mailer: Mailer;
  /** 32 or more characters. Signs session cookies. Read from `<dataDir>/auth-secret` when absent. */
  secret?: string;
}

/** The secret in `<dataDir>/auth-secret`, made on first start, readable only by this user. */
function secretFile(dataDir: string): string {
  const path = join(dataDir, 'auth-secret');
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
  }
  chmodSync(path, 0o600);
  return readFileSync(path, 'utf8').trim();
}

function createAuth(opts: PasswordSignInOptions, db: Database) {
  return betterAuth({
    baseURL: opts.baseURL,
    basePath: '/auth/api',
    secret: opts.secret ?? secretFile(opts.dataDir),
    trustedOrigins: [opts.baseURL],
    database: db,
    // One process holds every count, so Better Auth's own limiter is exact here.
    rateLimit: { enabled: true, storage: 'memory', window: 60, max: 20 },
    ...passwordAuthOptions(opts.mailer),
  });
}

/** Copy the cookies an auth response set onto a redirect. */
function redirectWithCookies(from: Response, to: string): Response {
  const headers = new Headers({ location: to });
  for (const cookie of from.headers.getSetCookie()) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

async function formFields(req: Request, names: string[]): Promise<Record<string, string> | null> {
  const form = await req.formData().catch(() => null);
  if (!form) return null;
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = form.get(name);
    if (typeof v !== 'string' || v.length === 0 || v.length > 512) return null;
    out[name] = v;
  }
  return out;
}

/** Better Auth's error message, or a fallback a person can act on. */
async function reason(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === 'string' && body.message ? body.message : fallback;
}

/** Password sign-in. Creates its tables in `<dataDir>/auth.sqlite` on start. */
export async function passwordSignIn(opts: PasswordSignInOptions): Promise<SignIn> {
  mkdirSync(opts.dataDir, { recursive: true });
  const db = new Database(join(opts.dataDir, 'auth.sqlite'), { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  const auth = createAuth(opts, db);
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();

  const routes = new Hono()
    // Better Auth's own routes: the verification link, session reads.
    .on(['GET', 'POST'], '/api/*', (c) => auth.handler(c.req.raw))
    .get('/sign-in', (c) => c.html(signInPage()))
    .get('/sign-up', (c) => c.html(signUpPage()))
    .post('/sign-in', async (c) => {
      if (!sameOrigin(c.req.raw)) return c.text('cross-site form', 403);
      const f = await formFields(c.req.raw, ['email', 'password']);
      if (!f?.email || !f.password)
        return c.html(signInPage('Enter an email and a password.'), 400);
      const res = await auth.api.signInEmail({
        body: { email: f.email, password: f.password },
        headers: c.req.raw.headers,
        asResponse: true,
      });
      if (res.ok) return redirectWithCookies(res, '/');
      const message =
        res.status === 403
          ? 'Verify your email first: we sent the link again.'
          : await reason(res, 'That email and password do not match.');
      return c.html(
        signInPage(message, f.email),
        res.status === 403 || res.status === 429 ? res.status : 401,
      );
    })
    .post('/sign-up', async (c) => {
      if (!sameOrigin(c.req.raw)) return c.text('cross-site form', 403);
      const f = await formFields(c.req.raw, ['name', 'email', 'password']);
      if (!f?.name || !f.email || !f.password)
        return c.html(signUpPage('Fill in every field.'), 400);
      const res = await auth.api.signUpEmail({
        body: { name: f.name, email: f.email, password: f.password, callbackURL: '/auth/sign-in' },
        headers: c.req.raw.headers,
        asResponse: true,
      });
      if (!res.ok) {
        const status = res.status as ContentfulStatusCode;
        return c.html(signUpPage(await reason(res, 'That did not work.')), status);
      }
      return c.html(checkEmailPage(f.email));
    })
    .post('/sign-out', async (c) => {
      if (!sameOrigin(c.req.raw)) return c.text('cross-site form', 403);
      const res = await auth.api.signOut({ headers: c.req.raw.headers, asResponse: true });
      return redirectWithCookies(res, '/auth/sign-in');
    });

  // Better Auth's own user table, which it keeps emails lower case in.
  const byEmail = db.query<{ id: string; name: string }, [string]>(
    'SELECT id, name FROM user WHERE email = ?',
  );

  return {
    async principal(req) {
      const session = await auth.api.getSession({ headers: req.headers });
      return session ? { id: session.user.id, name: session.user.name } : null;
    },
    personByEmail(email) {
      const row = byEmail.get(email.trim().toLowerCase());
      return row ? { id: row.id, name: row.name } : null;
    },
    routes,
    signInPath: '/auth/sign-in',
  };
}
