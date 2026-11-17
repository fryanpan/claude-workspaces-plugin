/**
 * The sign-in test app's smoke test, run by deploy.ts against the live app
 * after every deploy (and runnable alone: `bun infra/signin-test/smoke.ts`
 * with SIGNIN_TEST_ORIGIN, SMOKE_KEY, SIGNIN_TEST_GOOGLE_CLIENT_ID and
 * RESEND_API_KEY set).
 *
 * It checks that the page and the health route answer, that Turnstile is
 * enforced, that the Google start redirect names accounts.google.com with the
 * right client id and redirect URI (it never signs in to Google), and that a
 * password sign-up, its verification mail, a password sign-in and a magic link
 * all work end to end. Its addresses are at Resend's test domain, which
 * accepts mail and delivers it nowhere; it reads each mail's link back
 * through Resend's API. No value it holds is printed.
 */
import { SMOKE_HEADER, TURNSTILE_DUMMY_TOKEN } from './src/smoke-gate.ts';

export interface SmokeConfig {
  origin: string;
  smokeKey: string;
  googleClientId: string;
  /** Makes this run's addresses its own, so the per-address limits never carry over. */
  label: string;
}

/** Reads back the link in the newest mail of `subject` sent to `to`, or null while there is none. */
export interface MailReader {
  linkFor(to: string, subject: string): Promise<string | null>;
}

export interface SmokeIo {
  fetch: (req: Request) => Promise<Response>;
  mail: MailReader;
  sleep: (ms: number) => Promise<void>;
  /** How long to wait for a mail to show up in Resend. */
  mailWaitMs?: number;
}

export const GOOGLE_AUTHORIZE_HOST = 'accounts.google.com';
const SMOKE_PASSWORD = 'smoke-password-not-a-secret';

/** Null when the Google start URL is right, else what is wrong with it. Prints no value. */
export function googleStartProblem(url: string, origin: string, clientId: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'the start URL does not parse';
  }
  if (u.protocol !== 'https:' || u.host !== GOOGLE_AUTHORIZE_HOST) {
    return `the start URL goes to ${u.host}, not ${GOOGLE_AUTHORIZE_HOST}`;
  }
  if (u.searchParams.get('client_id') !== clientId)
    return 'the client id is not the configured one';
  const redirect = u.searchParams.get('redirect_uri');
  if (redirect !== `${origin}/api/auth/callback/google`) {
    return `the redirect URI is not ${origin}/api/auth/callback/google`;
  }
  return null;
}

/** One browser: a cookie jar, and the Origin header Better Auth checks. */
class Browser {
  private readonly cookies = new Map<string, string>();
  constructor(
    private readonly io: SmokeIo,
    private readonly origin: string,
  ) {}

  async call(
    pathOrUrl: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers = new Headers(opts.headers);
    headers.set('origin', this.origin);
    if (this.cookies.size > 0) {
      headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(opts.body);
    }
    const res = await this.io.fetch(
      new Request(new URL(pathOrUrl, this.origin), {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body,
        redirect: 'manual',
      }),
    );
    for (const line of res.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  async email(): Promise<string | null> {
    const res = await this.call('/api/auth/get-session');
    const s = (await res.json().catch(() => null)) as { user?: { email?: string } } | null;
    return s?.user?.email ?? null;
  }
}

class Failed extends Error {}

const expectStatus = async (what: string, res: Response, want: number): Promise<void> => {
  if (res.status !== want) throw new Failed(`${what}: HTTP ${res.status}, wanted ${want}`);
};

/** Runs every check; each result is one line, `ok <check>` or `FAIL <check>: <why>`. */
export async function runSmoke(
  cfg: SmokeConfig,
  io: SmokeIo,
): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  const smokeHeaders = {
    [SMOKE_HEADER]: cfg.smokeKey,
    'x-captcha-response': TURNSTILE_DUMMY_TOKEN,
  };
  const address = (suffix: string) => `delivered+${cfg.label}-${suffix}@resend.dev`;

  const linkOf = async (to: string, subject: string): Promise<string> => {
    const until = (io.mailWaitMs ?? 90_000) / 3_000;
    for (let i = 0; i <= until; i++) {
      const link = await io.mail.linkFor(to, subject);
      if (link) return link;
      if (i < until) await io.sleep(3_000);
    }
    throw new Failed(`no "${subject}" mail reached Resend`);
  };

  const check = async (name: string, body: () => Promise<void>) => {
    try {
      await body();
      lines.push(`ok ${name}`);
    } catch (e) {
      ok = false;
      const why = e instanceof Failed ? e.message : 'the request failed';
      lines.push(`FAIL ${name}: ${why}`);
    }
  };

  await check('health', async () => {
    const res = await new Browser(io, cfg.origin).call('/health');
    await expectStatus('GET /health', res, 200);
  });

  await check('sign-in page', async () => {
    const res = await new Browser(io, cfg.origin).call('/');
    await expectStatus('GET /', res, 200);
    const html = await res.text();
    if (!html.includes('class="cf-turnstile"') || !html.includes('data-sitekey="')) {
      throw new Failed('the page has no Turnstile widget');
    }
  });

  await check('Turnstile is enforced', async () => {
    const res = await new Browser(io, cfg.origin).call('/api/auth/sign-in/email', {
      body: { email: address('no-captcha'), password: SMOKE_PASSWORD },
    });
    await expectStatus('sign-in with no Turnstile token', res, 400);
  });

  await check('Google start redirect', async () => {
    const res = await new Browser(io, cfg.origin).call('/api/auth/sign-in/social', {
      body: { provider: 'google', callbackURL: '/' },
    });
    await expectStatus('POST /api/auth/sign-in/social', res, 200);
    const { url } = (await res.json()) as { url?: string };
    const problem = googleStartProblem(url ?? '', cfg.origin, cfg.googleClientId);
    if (problem) throw new Failed(problem);
  });

  await check('password sign-up, verification and sign-in', async () => {
    const email = address('password');
    const b = new Browser(io, cfg.origin);
    const signUp = await b.call('/api/auth/sign-up/email', {
      body: { email, password: SMOKE_PASSWORD, name: 'Smoke', callbackURL: '/' },
      headers: smokeHeaders,
    });
    await expectStatus('sign-up', signUp, 200);
    const signIn = (password: string) =>
      b.call('/api/auth/sign-in/email', { body: { email, password }, headers: smokeHeaders });
    await expectStatus(
      'sign-in with a wrong password',
      await signIn(`${SMOKE_PASSWORD}-wrong`),
      401,
    );
    await expectStatus('sign-in before verifying', await signIn(SMOKE_PASSWORD), 403);
    const verify = await b.call(await linkOf(email, 'Verify your email'));
    if (verify.status >= 400) throw new Failed(`the verification link: HTTP ${verify.status}`);
    await expectStatus('sign-in after verifying', await signIn(SMOKE_PASSWORD), 200);
    if ((await b.email()) !== email) throw new Failed('no session after the password sign-in');
  });

  await check('magic link', async () => {
    const email = address('link');
    const b = new Browser(io, cfg.origin);
    const ask = await b.call('/api/auth/sign-in/magic-link', {
      body: { email, callbackURL: '/' },
      headers: smokeHeaders,
    });
    await expectStatus('magic-link request', ask, 200);
    const follow = await b.call(await linkOf(email, 'Your sign-in link'));
    if (follow.status >= 400) throw new Failed(`the sign-in link: HTTP ${follow.status}`);
    if ((await b.email()) !== email) throw new Failed('no session after following the link');
  });

  return { ok, lines };
}

/** The real MailReader: Resend's list and retrieve endpoints, with a full-access key. */
export function resendMailReader(key: string, fetcher: typeof fetch = fetch): MailReader {
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetcher(`https://api.resend.com${path}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Failed(`Resend GET ${path.split('?')[0]}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    async linkFor(to, subject) {
      const list = await get<{
        data?: { id: string; to?: string[]; subject?: string; created_at?: string }[];
      }>('/emails?limit=100');
      const newest = (list.data ?? [])
        .filter((m) => m.subject === subject && (m.to ?? []).includes(to))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      if (!newest) return null;
      const mail = await get<{ text?: string | null; html?: string | null }>(
        `/emails/${newest.id}`,
      );
      const found = `${mail.text ?? ''} ${mail.html ?? ''}`.match(/https?:\/\/[^\s"'<>]+/);
      return found ? found[0] : null;
    },
  };
}

if (import.meta.main) {
  const need = (name: string): string => {
    const v = process.env[name]?.trim();
    if (!v) {
      process.stderr.write(`smoke: ${name} is not set\n`);
      process.exit(2);
    }
    return v;
  };
  const cfg: SmokeConfig = {
    origin: need('SIGNIN_TEST_ORIGIN'),
    smokeKey: need('SMOKE_KEY'),
    googleClientId: need('SIGNIN_TEST_GOOGLE_CLIENT_ID'),
    label: `s${Date.now().toString(36)}`,
  };
  runSmoke(cfg, {
    fetch: (req) => fetch(req),
    mail: resendMailReader(need('RESEND_API_KEY')),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }).then(({ ok, lines }) => {
    for (const l of lines) process.stdout.write(`${l}\n`);
    process.exit(ok ? 0 : 1);
  });
}
