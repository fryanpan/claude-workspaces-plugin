/**
 * Email and password sign-in beside Google (`board-signin.ts`, plan step 8).
 *
 * Each machine keeps its own passwords, in the same `signin.sqlite` as its
 * sessions, so a password set at one machine signs in nowhere else. Better
 * Auth hashes them (scrypt) and holds the reset and verification tokens; this
 * module holds what is ours:
 *
 * - **Four form routes** under `/auth/`, the only way in. Better Auth's own
 *   JSON routes for these flows stay off its allowlist, so every request that
 *   could make an account, try a password or send a mail passes the
 *   Turnstile check first, and a form posted from another site is refused.
 * - **The mails.** Sent through an injected mailer: Resend in production
 *   (`resendMailer`), an array in tests.
 * - **Turnstile.** Checked through an injected verifier: Cloudflare's
 *   siteverify in production (`turnstileVerifier`), a stub in tests.
 *
 * Nothing says whether an address holds an account: sign-up and a reset
 * request answer the same page whatever happened, and a failed sign-in says
 * only that it failed. A person can do nothing with a password account until
 * they follow the link mailed to the address — Better Auth refuses its
 * sign-in until then, and the door refuses an unverified session.
 */
import { fixedHostFetch } from '../outbound-fetch.ts';

export type MailKind = 'verify-email' | 'reset-password';

export interface SignInMail {
  kind: MailKind;
  to: string;
  subject: string;
  text: string;
  /** The link the mail carries. Tests follow it. */
  url: string;
}

export interface SignInMailer {
  send(mail: SignInMail): Promise<void>;
}

export interface TurnstileCheck {
  /** Public: the page's widget names it. */
  siteKey: string;
  /** Whether Cloudflare vouches for this widget answer. Never throws. */
  verify(token: string, ip: string | null): Promise<boolean>;
}

export interface PasswordSignIn {
  mailer: SignInMailer;
  turnstile: TurnstileCheck;
}

/** The form routes, all POST, plus the reset page's GET. */
export const PASSWORD_PATHS = {
  signIn: '/auth/sign-in/email',
  signUp: '/auth/sign-up',
  forgot: '/auth/forgot',
  reset: '/auth/reset',
} as const;

export function composeMail(kind: MailKind, to: string, url: string): SignInMail {
  const subject = kind === 'verify-email' ? 'Verify your email' : 'Reset your password';
  return { kind, to, subject, url, text: `${subject}: ${url}` };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
/** Both hosts are fixed vendors (`VENDOR_HOSTS`). */
const vendorFetch: FetchLike = (url, init) => fixedHostFetch(url, init);

/** Resend's send endpoint (resend.com/docs/api-reference/emails/send-email). */
export const RESEND_SEND_URL = 'https://api.resend.com/emails';

/** Sends each mail as plain text through Resend. A refusal throws, naming the status only. */
export function resendMailer(key: string, from: string, fetcher = vendorFetch): SignInMailer {
  return {
    async send(mail) {
      const res = await fetcher(RESEND_SEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
      });
      if (!res.ok) throw new Error(`Resend refused the ${mail.kind} mail: HTTP ${res.status}`);
    },
  };
}

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Cloudflare's own check of a widget answer. Any failure is a no. */
export function turnstileVerifier(
  siteKey: string,
  secret: string,
  fetcher = vendorFetch,
): TurnstileCheck {
  return {
    siteKey,
    async verify(token, ip) {
      if (token === '' || token.length > 2048) return false;
      const body = new URLSearchParams({ secret, response: token });
      if (ip) body.set('remoteip', ip);
      try {
        const res = await fetcher(TURNSTILE_VERIFY_URL, { method: 'POST', body });
        if (!res.ok) return false;
        return ((await res.json()) as { success?: unknown }).success === true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * `CW_TURNSTILE_SITE_KEY`, `CW_TURNSTILE_SECRET_KEY`, `CW_RESEND_API_KEY` and
 * `CW_SIGNIN_MAIL_FROM`: all four turn password sign-in on, none leaves it
 * off, and some but not all is an error, so a half-set machine says so.
 */
export function passwordSignInFromEnv(
  env: Record<string, string | undefined>,
): { setting: PasswordSignIn | null } | { error: string } {
  const names = [
    'CW_TURNSTILE_SITE_KEY',
    'CW_TURNSTILE_SECRET_KEY',
    'CW_RESEND_API_KEY',
    'CW_SIGNIN_MAIL_FROM',
  ] as const;
  const [siteKey, secret, resendKey, from] = names.map((n) => (env[n] ?? '').trim());
  const set = [siteKey, secret, resendKey, from].filter((v) => v !== '').length;
  if (set === 0) return { setting: null };
  if (set < names.length || !siteKey || !secret || !resendKey || !from) {
    return { error: `password sign-in needs all of ${names.join(', ')}` };
  }
  return {
    setting: {
      mailer: resendMailer(resendKey, from),
      turnstile: turnstileVerifier(siteKey, secret),
    },
  };
}

/** What a form route needs of `board-signin.ts`. */
export interface PasswordRouteContext {
  origin: string;
  password: PasswordSignIn;
  /** A same-site path to come back to (`board-signin.ts` `safeNext`). */
  safeNext(raw: unknown): string;
  /** POST a JSON body to a Better Auth route, as this request's browser. */
  call(req: Request, path: string, body: Record<string, unknown>): Promise<Response>;
}

/** Back to the sign-in page, with a word for it to show. */
const toPage = (query: Record<string, string>, cookies: string[] = []): Response => {
  const headers = new Headers({
    location: `/auth/sign-in?${new URLSearchParams(query).toString()}`,
    'cache-control': 'no-store',
  });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 303, headers });
};

/** A form route's answer, or null when the path is not one of them. */
export async function handlePasswordRoute(
  ctx: PasswordRouteContext,
  req: Request,
  pathname: string,
): Promise<Response | null> {
  if (pathname === PASSWORD_PATHS.reset && req.method === 'GET') {
    const url = new URL(req.url);
    return resetPage(url.searchParams.get('token'), url.searchParams.get('error'));
  }
  const paths: readonly string[] = Object.values(PASSWORD_PATHS);
  if (!paths.includes(pathname) || req.method !== 'POST') return null;
  if (req.headers.get('origin') !== ctx.origin) {
    return new Response(JSON.stringify({ error: 'cross_site_form' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
  const form = await req.formData().catch(() => null);
  const field = (name: string): string => {
    const v = form?.get(name);
    return typeof v === 'string' ? v : '';
  };
  const next = ctx.safeNext(field('next'));
  if (pathname === PASSWORD_PATHS.reset) {
    // The mailed token is the proof here; no widget stands on that page.
    const res = await ctx.call(req, '/reset-password', {
      token: field('token'),
      newPassword: field('password'),
    });
    return toPage(res.ok ? { sent: 'reset-done' } : { error: 'reset_failed' });
  }
  const ip = req.headers.get('cf-connecting-ip');
  if (!(await ctx.password.turnstile.verify(field('cf-turnstile-response'), ip))) {
    return toPage({ next, error: 'turnstile' });
  }
  const email = field('email').trim();
  if (pathname === PASSWORD_PATHS.signIn) {
    const res = await ctx.call(req, '/sign-in/email', {
      email,
      password: field('password'),
      callbackURL: next,
      rememberMe: true,
    });
    if (!res.ok) return toPage({ next, error: 'signin_failed' });
    const headers = new Headers({ location: next, 'cache-control': 'no-store' });
    for (const c of res.headers.getSetCookie()) headers.append('set-cookie', c);
    return new Response(null, { status: 303, headers });
  }
  if (pathname === PASSWORD_PATHS.signUp) {
    // The same answer whether or not an account was made.
    await ctx.call(req, '/sign-up/email', {
      email,
      password: field('password'),
      name: email.split('@')[0] ?? email,
      callbackURL: `/auth/sign-in?${new URLSearchParams({ next, sent: 'verified' })}`,
    });
    return toPage({ next, sent: 'verify' });
  }
  await ctx.call(req, '/request-password-reset', { email, redirectTo: PASSWORD_PATHS.reset });
  return toPage({ next, sent: 'reset' });
}

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const NOTICES: Record<string, string> = {
  verify: 'If that address may have an account here, a link to verify it is on its way.',
  verified: 'Your address is verified. Sign in with your password.',
  reset: 'If that address has an account here, a reset link is on its way.',
  'reset-done': 'Your password is changed. Sign in with the new one.',
  turnstile: 'The check that you are a person did not pass. Try again.',
  signin_failed: 'That email and password did not sign you in.',
  reset_failed: 'That reset link has expired or was already used. Ask for a new one.',
};

/** The line the page shows for `?sent=` or `?error=`, or ''. */
export function noticeFor(query: URLSearchParams): string {
  const key = query.get('error') ?? query.get('sent') ?? '';
  const text = NOTICES[key];
  return text ? `<p role="status">${text}</p>` : '';
}

/** The page's password forms, each with its own Turnstile widget. */
export function passwordFormsHtml(next: string, siteKey: string): string {
  const n = escapeAttr(next);
  const widget = `<div class="cf-turnstile" data-sitekey="${escapeAttr(siteKey)}"></div>`;
  const field = (name: string, type: string, label: string, auto: string) =>
    `<label>${label} <input name="${name}" type="${type}" autocomplete="${auto}" required></label>`;
  return `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<form method="post" action="${PASSWORD_PATHS.signIn}" style="display: grid; gap: 0.5rem; margin-top: 1.5rem;">
<input type="hidden" name="next" value="${n}">
${field('email', 'email', 'Email', 'username')}
${field('password', 'password', 'Password', 'current-password')}
${widget}<button type="submit">Sign in</button></form>
<details style="margin-top: 1rem;"><summary>New here, or forgot your password?</summary>
<form method="post" action="${PASSWORD_PATHS.signUp}" style="display: grid; gap: 0.5rem; margin-top: 0.5rem;">
<input type="hidden" name="next" value="${n}">
${field('email', 'email', 'Email', 'username')}
${field('password', 'password', 'New password', 'new-password')}
${widget}<button type="submit">Create account</button></form>
<form method="post" action="${PASSWORD_PATHS.forgot}" style="display: grid; gap: 0.5rem; margin-top: 1rem;">
<input type="hidden" name="next" value="${n}">
${field('email', 'email', 'Email', 'username')}
${widget}<button type="submit">Email me a reset link</button></form></details>`;
}

function resetPage(token: string | null, error: string | null): Response {
  const body =
    token && !error
      ? `<form method="post" action="${PASSWORD_PATHS.reset}" style="display: grid; gap: 0.5rem;">
<input type="hidden" name="token" value="${escapeAttr(token)}">
<label>New password <input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
<button type="submit">Set password</button></form>`
      : `<p role="status">${NOTICES.reset_failed}</p><p><a href="/auth/sign-in">Back to sign in</a></p>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reset your password</title></head>
<body style="font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 90vh;">
<main><h1 style="font-size: 1.4rem;">Reset your password</h1>
${body}
</main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // The token rides in this page's URL: keep it out of any Referer.
      'referrer-policy': 'no-referrer',
    },
  });
}
