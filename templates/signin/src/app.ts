import { Hono } from 'hono';
import { mountAdminRoutes } from './admin-routes.ts';
import { type Auth, type AuthDeps, createAuth } from './auth.ts';
import type { Env } from './env.ts';
import type { Mailer } from './mail.ts';
import {
  EMAIL_LIMITED_PATHS,
  EMAIL_RULE,
  IP_RULE,
  normaliseEmail,
  takeRateSlot,
} from './rate-limit.ts';

export const AUTH_BASE = '/api/auth';

export interface AppOptions extends Omit<AuthDeps, 'mailer'> {
  mailer: (env: Env) => Mailer;
  /** Milliseconds since the epoch. Tests pass a clock they can move. */
  now?: () => number;
}

export type AppEnv = { Bindings: Env; Variables: { auth: Auth } };

export function createApp(options: AppOptions) {
  const now = options.now ?? Date.now;
  // One Better Auth instance per bindings object, so an isolate builds it once.
  const instances = new WeakMap<Env, Auth>();
  const authFor = (env: Env): Auth => {
    let auth = instances.get(env);
    if (!auth) {
      auth = createAuth(env, { ...options, mailer: options.mailer(env) });
      instances.set(env, auth);
    }
    return auth;
  };

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', authFor(c.env));
    await next();
  });

  app.get('/health', (c) => c.json({ ok: true }));

  app.post(`${AUTH_BASE}/*`, async (c, next) => {
    // Cloudflare sets CF-Connecting-IP on every request that reaches a Worker.
    // Without it (a local run) every caller shares one bucket.
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const byIp = await takeRateSlot(c.env.DB, IP_RULE, ip, now());
    if (!byIp.allowed) return tooMany(byIp.retryAfterSeconds);
    const path = c.req.path.slice(AUTH_BASE.length);
    if (EMAIL_LIMITED_PATHS.has(path)) {
      const email = normaliseEmail(await emailInBody(c.req.raw));
      if (email) {
        // One bucket per route and address: a sign-up, a reset and a sign-in
        // in the same quarter hour each have their own allowance.
        const byEmail = await takeRateSlot(c.env.DB, EMAIL_RULE, `${path}:${email}`, now());
        if (!byEmail.allowed) return tooMany(byEmail.retryAfterSeconds);
      }
    }
    return next();
  });

  app.on(['GET', 'POST'], `${AUTH_BASE}/*`, (c) => c.var.auth.handler(c.req.raw));

  mountAdminRoutes(app);
  return app;
}

/**
 * Better Auth accepts form posts as well as JSON, so the limiter reads both.
 * Reading only JSON would let a form-encoded attempt skip the email limit.
 */
async function emailInBody(req: Request): Promise<unknown> {
  const type = req.headers.get('content-type') ?? '';
  const copy = req.clone();
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const form = await copy.formData().catch(() => null);
    return form?.get('email');
  }
  const body = (await copy.json().catch(() => null)) as { email?: unknown } | null;
  return body?.email;
}

function tooMany(retryAfterSeconds: number): Response {
  return Response.json(
    { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' },
    { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } },
  );
}
