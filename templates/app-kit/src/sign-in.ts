import type { Principal } from '@claude-workspaces/app-kit/collab';
/**
 * Sign-in: the one slot the app asks "who sent this request?".
 *
 * Everything else in the app reads a person through `SignIn.principal`, so a
 * real provider replaces `devSignIn` here and nowhere else. The kit ships
 * only the development provider: anyone may type a name and be that person.
 * `server.ts` refuses to start with it when `APP_ENV=production`.
 */
import { Hono } from 'hono';

export interface SignIn {
  /** Who sent this request, or null when nobody is signed in. */
  principal(req: Request): Principal | null | Promise<Principal | null>;
  /** The provider's own pages and callbacks. The app mounts them at `/auth`. */
  routes: Hono;
  /** Where a signed-out page is sent. */
  signInPath: string;
  /** True only for a provider that must never run in production. */
  devOnly: boolean;
}

const COOKIE = 'app_person';
/** A display name: a letter, then letters, spaces, `.`, `'` or `-`, up to 40. */
const NAME = /^[A-Za-z][A-Za-z .'-]{0,39}$/;

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The person a name stands for. Two tabs typing the same name are one person. */
export function principalFromName(name: string): Principal | null {
  const trimmed = name.trim();
  if (!NAME.test(trimmed)) return null;
  return { id: trimmed.toLowerCase().replace(/[^a-z]+/g, '-'), name: trimmed };
}

const FORM = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
<link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/app.css">
<script type="module" src="/assets/main.js"></script>
</head><body><main class="app-page">
<h1>Sign in</h1>
<p class="app-quiet">Development sign-in: type any name.</p>
<form method="post" action="/auth/sign-in" class="app-row">
<input name="name" aria-label="Your name" placeholder="Your name" required autofocus>
<wa-button type="submit" variant="brand">Sign in</wa-button>
</form></main></body></html>`;

/** Name-only sign-in for development and tests. Never for production. */
export function devSignIn(): SignIn {
  const routes = new Hono()
    .get('/sign-in', (c) => c.html(FORM))
    .post('/sign-in', async (c) => {
      const form = await c.req.formData().catch(() => null);
      const who = principalFromName(String(form?.get('name') ?? ''));
      if (!who?.name) return c.text('A name is a letter, then up to 39 letters or spaces.', 400);
      c.header(
        'set-cookie',
        `${COOKIE}=${encodeURIComponent(who.name)}; Path=/; HttpOnly; SameSite=Lax`,
      );
      return c.redirect('/', 303);
    })
    .post('/sign-out', (c) => {
      c.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      return c.redirect('/auth/sign-in', 303);
    });
  return {
    principal: (req) => principalFromName(readCookie(req, COOKIE) ?? ''),
    routes,
    signInPath: '/auth/sign-in',
    devOnly: true,
  };
}
