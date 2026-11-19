/**
 * Email and password sign-in beside Google (`board-signin.ts`, plan step 8).
 *
 * Each machine keeps its own passwords, in the same `signin.sqlite` as its
 * sessions, so a password set at one machine signs in nowhere else. Better
 * Auth hashes them (scrypt) and checks them at sign-in; this module holds
 * what is ours.
 *
 * **No account and no password exist until the address is proved.** Asking
 * to sign up, or saying a password is forgotten, only mails a single-use
 * link (an hour). The account and its password are made when the person who
 * followed that link sets a password on our own form, and following it is
 * what verifies the address (`createPasswordAccounts` in
 * `board-signin-auth.ts`). So a stranger who asks in somebody's name leaves
 * nothing behind: no row that could block their Google sign-in, and no
 * password the real owner might later verify. Better Auth's own sign-up is
 * switched off, and its JSON routes for these flows stay off its allowlist.
 *
 * - **Five form routes** under `/auth/` are the only way in. Each refuses a
 *   form posted from another site and passes the Turnstile check, which must
 *   name this host and that form's action.
 * - **The mail** goes through an injected mailer: Resend in production
 *   (`resendMailer`), an array in tests. It is sent after the answer, so the
 *   time an answer takes says nothing about the address.
 * - **Turnstile** is checked through an injected verifier: Cloudflare's
 *   siteverify in production (`turnstileVerifier`), a stub in tests.
 *
 * Nothing says whether an address holds an account: asking for a link
 * answers the same page whatever happened, and a failed sign-in says only
 * that it failed.
 */
import { fixedHostFetch } from '../outbound-fetch.ts';

export type MailKind = 'set-password';

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

/** What a Turnstile pass must name: this host and the form it was for. */
export interface TurnstileWant {
  hostname: string;
  action: FormAction;
}

export interface TurnstileCheck {
  /** Public: the page's widget names it. */
  siteKey: string;
  /** Whether Cloudflare vouches for this widget answer. Never throws. */
  verify(token: string, ip: string | null, want: TurnstileWant): Promise<boolean>;
}

export interface PasswordSignIn {
  mailer: SignInMailer;
  turnstile: TurnstileCheck;
}

/**
 * The accounts half, built on Better Auth (`board-signin-auth.ts`). A link
 * is issued only for an address that may hold an account here; using one
 * consumes it.
 */
export interface PasswordAccounts {
  /** The set-password link for this address, or null when it may not have one. */
  issueLink(email: string): Promise<string | null>;
  /** Set the password the link's clicker typed. False for a used, expired or unknown link. */
  setPassword(token: string, password: string): Promise<boolean>;
}

/** The form routes, all POST, plus the set-password page's GET. */
export const PASSWORD_PATHS = {
  signIn: '/auth/sign-in/email',
  signUp: '/auth/sign-up',
  forgot: '/auth/forgot',
  setPassword: '/auth/set-password',
} as const;

/** Each form's Turnstile action, which the widget sends and the check matches. */
const ACTIONS = {
  [PASSWORD_PATHS.signIn]: 'sign-in',
  [PASSWORD_PATHS.signUp]: 'sign-up',
  [PASSWORD_PATHS.forgot]: 'forgot',
  [PASSWORD_PATHS.setPassword]: 'set-password',
} as const;
export type FormAction = (typeof ACTIONS)[keyof typeof ACTIONS];

/** Better Auth's own bounds on a password. */
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

export function composeMail(kind: MailKind, to: string, url: string): SignInMail {
  const subject = 'Set your password';
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
    async verify(token, ip, want) {
      if (token === '' || token.length > 2048) return false;
      const body = new URLSearchParams({ secret, response: token });
      if (ip) body.set('remoteip', ip);
      try {
        const res = await fetcher(TURNSTILE_VERIFY_URL, { method: 'POST', body });
        if (!res.ok) return false;
        const answer = (await res.json()) as {
          success?: unknown;
          hostname?: unknown;
          action?: unknown;
        };
        // A pass for another site's widget, or for another of our forms, is
        // not a pass for this one.
        return (
          answer.success === true &&
          answer.hostname === want.hostname &&
          answer.action === want.action
        );
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
  /** The bare hostname of `origin`, which a Turnstile pass must name. */
  host: string;
  password: PasswordSignIn;
  accounts: () => Promise<PasswordAccounts>;
  /** A same-site path to come back to (`board-signin.ts` `safeNext`). */
  safeNext(raw: unknown): string;
  /** POST a JSON body to a Better Auth route, as this request's browser. */
  call(req: Request, path: string, body: Record<string, unknown>): Promise<Response>;
}

/** Back to the sign-in page, with a word for it to show. */
const toPage = (query: Record<string, string>): Response =>
  new Response(null, {
    status: 303,
    headers: {
      location: `/auth/sign-in?${new URLSearchParams(query).toString()}`,
      'cache-control': 'no-store',
    },
  });

const isAction = (path: string): path is keyof typeof ACTIONS => path in ACTIONS;

/** A form route's answer, or null when the path is not one of them. */
export async function handlePasswordRoute(
  ctx: PasswordRouteContext,
  req: Request,
  pathname: string,
): Promise<Response | null> {
  if (pathname === PASSWORD_PATHS.setPassword && req.method === 'GET') {
    return setPasswordPage(
      new URL(req.url).searchParams.get('token'),
      ctx.password.turnstile.siteKey,
    );
  }
  if (!isAction(pathname) || req.method !== 'POST') return null;
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
  const ip = req.headers.get('cf-connecting-ip');
  const want = { hostname: ctx.host, action: ACTIONS[pathname] };
  if (!(await ctx.password.turnstile.verify(field('cf-turnstile-response'), ip, want))) {
    return toPage({ next, error: 'turnstile' });
  }
  if (pathname === PASSWORD_PATHS.setPassword) {
    const password = field('password');
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      return toPage({ error: 'password_rules' });
    }
    const accounts = await ctx.accounts();
    const ok = await accounts.setPassword(field('token'), password);
    return toPage(ok ? { sent: 'password-set' } : { error: 'link_failed' });
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
  // Sign-up and forgot are one act: mail a link to set a password. Answered
  // first, the same page whatever happens, and the link and the mail made
  // after, so neither the answer nor its timing says whether an account
  // exists or the address may hold one.
  void mailLink(ctx, email);
  return toPage({ next, sent: 'link' });
}

async function mailLink(ctx: PasswordRouteContext, email: string): Promise<void> {
  try {
    const url = await (await ctx.accounts()).issueLink(email);
    if (url) await ctx.password.mailer.send(composeMail('set-password', email, url));
  } catch (e) {
    console.error(`[signin] a set-password mail failed: ${e instanceof Error ? e.message : e}`);
  }
}

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const NOTICES: Record<string, string> = {
  link: 'If that address may have an account here, a link to set your password is on its way.',
  'password-set': 'Your password is set. Sign in with it.',
  turnstile: 'The check that you are a person did not pass. Try again.',
  signin_failed: 'That email and password did not sign you in.',
  link_failed: 'That link has expired or was already used. Ask for a new one.',
  password_rules: 'A password is 8 to 128 characters. Open the link again to choose another.',
};

/** The line the page shows for `?sent=` or `?error=`, or ''. */
export function noticeFor(query: URLSearchParams): string {
  const key = query.get('error') ?? query.get('sent') ?? '';
  const text = NOTICES[key];
  return text ? `<p role="status">${text}</p>` : '';
}

const TURNSTILE_SCRIPT =
  '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>';

const widget = (siteKey: string, action: FormAction) =>
  `<div class="cf-turnstile" data-sitekey="${escapeAttr(siteKey)}" data-action="${action}"></div>`;

const field = (name: string, type: string, label: string, auto: string) =>
  `<label>${label} <input name="${name}" type="${type}" autocomplete="${auto}" required></label>`;

/** The sign-in page's password forms, each with its own Turnstile widget. */
export function passwordFormsHtml(next: string, siteKey: string): string {
  const n = escapeAttr(next);
  const form = (path: keyof typeof ACTIONS, inner: string, button: string) =>
    `<form method="post" action="${path}" style="display: grid; gap: 0.5rem; margin-top: 1rem;">
<input type="hidden" name="next" value="${n}">
${inner}
${widget(siteKey, ACTIONS[path])}<button type="submit">${button}</button></form>`;
  return `${TURNSTILE_SCRIPT}
${form(
  PASSWORD_PATHS.signIn,
  `${field('email', 'email', 'Email', 'username')}
${field('password', 'password', 'Password', 'current-password')}`,
  'Sign in',
)}
<details style="margin-top: 1rem;"><summary>New here, or forgot your password?</summary>
${form(PASSWORD_PATHS.signUp, field('email', 'email', 'Email', 'username'), 'Email me a link to set a password')}
</details>`;
}

function setPasswordPage(token: string | null, siteKey: string): Response {
  const body = token
    ? `${TURNSTILE_SCRIPT}
<form method="post" action="${PASSWORD_PATHS.setPassword}" style="display: grid; gap: 0.5rem;">
<input type="hidden" name="token" value="${escapeAttr(token)}">
<label>New password <input name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" maxlength="${MAX_PASSWORD}" required></label>
${widget(siteKey, 'set-password')}<button type="submit">Set password</button></form>`
    : `<p role="status">${NOTICES.link_failed}</p><p><a href="/auth/sign-in">Back to sign in</a></p>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set your password</title></head>
<body style="font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 90vh;">
<main><h1 style="font-size: 1.4rem;">Set your password</h1>
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
