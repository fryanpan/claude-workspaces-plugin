import { describe, expect, it } from 'bun:test';
import {
  type PasswordRouteContext,
  RESEND_SEND_URL,
  type SignInMail,
  TURNSTILE_VERIFY_URL,
  composeMail,
  createLinkThrottle,
  handlePasswordRoute,
  passwordSignInFromEnv,
  resendMailer,
  turnstileVerifier,
} from '../src/auth/board-signin-password.ts';
import { waitFor } from './wait-for.ts';

/** A fetch that records each call and answers `answer`. No network. */
const recorder = (answer: () => Response) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  };
  return { calls, fetcher };
};

describe('the Turnstile verifier', () => {
  const want = { hostname: 'riverbend-workspaces.harborlight.test', action: 'sign-in' as const };
  const yes = { success: true, ...want };

  it('asks Cloudflare with the secret, the answer and the address, and takes its yes', async () => {
    const { calls, fetcher } = recorder(() => Response.json(yes));
    const check = turnstileVerifier('site', 'stub-secret', fetcher);
    expect(await check.verify('widget-answer', '198.51.100.7', want)).toBe(true);
    expect(calls[0]?.url).toBe(TURNSTILE_VERIFY_URL);
    const body = calls[0]?.init.body as URLSearchParams;
    expect(body.get('secret')).toBe('stub-secret');
    expect(body.get('response')).toBe('widget-answer');
    expect(body.get('remoteip')).toBe('198.51.100.7');
  });

  it('is a no on a success that names another hostname or another form', async () => {
    const elsewhere = turnstileVerifier(
      'site',
      's',
      recorder(() => Response.json({ ...yes, hostname: 'saltmarsh.example.test' })).fetcher,
    );
    expect(await elsewhere.verify('a', null, want)).toBe(false);
    const otherForm = turnstileVerifier(
      'site',
      's',
      recorder(() => Response.json({ ...yes, action: 'sign-up' })).fetcher,
    );
    expect(await otherForm.verify('a', null, want)).toBe(false);
    const unnamed = turnstileVerifier(
      'site',
      's',
      recorder(() => Response.json({ success: true })).fetcher,
    );
    expect(await unnamed.verify('a', null, want)).toBe(false);
  });

  it('is a no on a refusal, an error, a non-200 or an empty answer', async () => {
    const no = turnstileVerifier(
      'site',
      's',
      recorder(() => Response.json({ ...yes, success: false })).fetcher,
    );
    expect(await no.verify('a', null, want)).toBe(false);
    const down = turnstileVerifier(
      'site',
      's',
      recorder(() => new Response('', { status: 500 })).fetcher,
    );
    expect(await down.verify('a', null, want)).toBe(false);
    const thrown = turnstileVerifier('site', 's', async () => {
      throw new Error('offline');
    });
    expect(await thrown.verify('a', null, want)).toBe(false);
    const { calls, fetcher } = recorder(() => Response.json(yes));
    expect(await turnstileVerifier('site', 's', fetcher).verify('', null, want)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('the Resend mailer', () => {
  it('sends the mail as plain text to the one address', async () => {
    const { calls, fetcher } = recorder(() => Response.json({ id: 'm1' }));
    const mail = composeMail('set-password', 'alice@riverbend.test', 'https://r.test/x');
    await resendMailer('stub-key', 'sign-in@riverbend.test', fetcher).send(mail);
    expect(calls[0]?.url).toBe(RESEND_SEND_URL);
    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent).toEqual({
      from: 'sign-in@riverbend.test',
      to: ['alice@riverbend.test'],
      subject: 'Set your password',
      text: 'Set your password: https://r.test/x',
    });
  });

  it('throws on a refusal, naming the status only', async () => {
    const { fetcher } = recorder(() => new Response('nope', { status: 403 }));
    const mail = composeMail('set-password', 'alice@riverbend.test', 'https://r.test/v');
    await expect(resendMailer('stub-key', 'f@riverbend.test', fetcher).send(mail)).rejects.toThrow(
      'Resend refused the set-password mail: HTTP 403',
    );
  });
});

describe('password sign-in settings', () => {
  const all = {
    CW_TURNSTILE_SITE_KEY: 'site',
    CW_TURNSTILE_SECRET_KEY: 'secret',
    CW_RESEND_API_KEY: 'key',
    CW_SIGNIN_MAIL_FROM: 'sign-in@riverbend.test',
  };

  it('is off with none, on with all four', () => {
    expect(passwordSignInFromEnv({})).toEqual({ setting: null });
    const on = passwordSignInFromEnv(all);
    if ('error' in on) throw new Error(on.error);
    expect(on.setting?.turnstile.siteKey).toBe('site');
  });

  it('refuses some but not all, so a half-set machine says so', () => {
    const { CW_RESEND_API_KEY: _dropped, ...three } = all;
    expect(passwordSignInFromEnv(three)).toEqual({
      error:
        'password sign-in needs all of CW_TURNSTILE_SITE_KEY, CW_TURNSTILE_SECRET_KEY, CW_RESEND_API_KEY, CW_SIGNIN_MAIL_FROM',
    });
  });
});

describe('the set-password and link routes', () => {
  const ORIGIN = 'https://riverbend-workspaces.harborlight.test';
  const route = (opts: { now?: () => number } = {}) => {
    const mail: SignInMail[] = [];
    const asked: string[] = [];
    const ctx: PasswordRouteContext = {
      origin: ORIGIN,
      host: 'riverbend-workspaces.harborlight.test',
      password: {
        mailer: { send: async (m) => void mail.push(m) },
        turnstile: { siteKey: 'site', verify: async () => true },
      },
      accounts: async () => ({
        issueLink: async (email) => {
          asked.push(email);
          return `${ORIGIN}/auth/set-password#token=t-${asked.length}`;
        },
        setPassword: async () => true,
      }),
      throttle: createLinkThrottle({}, opts.now),
      safeNext: () => '/',
      call: async () => new Response(null, { status: 500 }),
    };
    const ask = (email: string, ip = '198.51.100.7', path = '/auth/sign-up') =>
      handlePasswordRoute(
        ctx,
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: {
            origin: ORIGIN,
            'cf-connecting-ip': ip,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ email, 'cf-turnstile-response': 'ok' }),
        }),
        path,
      );
    return { ctx, mail, asked, ask };
  };
  /** Wait for the mail to `to`; a later request's mail is the control that earlier ones are done. */
  const mailTo = (mail: SignInMail[], to: string) =>
    waitFor(() => mail.find((m) => m.to === to), { describe: `a mail to ${to}` });

  it('serves the page with no token in its URL, and moves one from the query to the fragment', async () => {
    const { ctx } = route();
    const old = await handlePasswordRoute(
      ctx,
      new Request(`${ORIGIN}/auth/set-password?token=abc`),
      '/auth/set-password',
    );
    expect(old?.status).toBe(303);
    expect(old?.headers.get('location')).toBe('/auth/set-password#token=abc');
    const page = await handlePasswordRoute(
      ctx,
      new Request(`${ORIGIN}/auth/set-password`),
      '/auth/set-password',
    );
    expect(page?.status).toBe(200);
    const html = (await page?.text()) ?? '';
    // Run the page's own scripts, in order, against a browser stand-in
    // whose URL carries a link's fragment. Turnstile's script is the one
    // that must never see the token, so record what `location` says when
    // it would load.
    const field = { value: '' };
    const browser = {
      location: { pathname: '/auth/set-password', search: '', hash: '#token=tok-123' },
      history: {
        replaceState: (_s: unknown, _t: string, url: string) => {
          const u = new URL(url, ORIGIN);
          browser.location.search = u.search;
          browser.location.hash = u.hash;
        },
      },
      document: { getElementById: (id: string) => (id === 'set-password-token' ? field : null) },
    };
    let seenByTurnstile: string | null = null;
    for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      if ((m[1] ?? '').includes('challenges.cloudflare.com')) {
        seenByTurnstile = browser.location.search + browser.location.hash;
        continue;
      }
      new Function('location', 'history', 'document', m[2] ?? '')(
        browser.location,
        browser.history,
        browser.document,
      );
    }
    expect(seenByTurnstile).toBe('');
    expect(field.value).toBe('tok-123');
  });

  it('mails the address as normalized, not as typed', async () => {
    const { mail, asked, ask } = route();
    expect((await ask('  Alice@Harborlight.TEST '))?.status).toBe(303);
    const sent = await mailTo(mail, 'alice@harborlight.test');
    expect(sent.to).toBe('alice@harborlight.test');
    expect(asked).toEqual(['alice@harborlight.test']);
  });

  it('mails one address at most three links an hour, and answers the same either way', async () => {
    let now = 1_000_000;
    const { mail, ask } = route({ now: () => now });
    const answers: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      answers.push(
        (await ask('bob@harborlight.test', `198.51.100.${10 + i}`))?.headers.get('location') ??
          null,
      );
    }
    expect(new Set(answers).size).toBe(1);
    // CONTROL: another address, asked after, is mailed; Bob's fourth is not.
    await ask('alice@harborlight.test', '198.51.100.40');
    await mailTo(mail, 'alice@harborlight.test');
    expect(mail.filter((m) => m.to === 'bob@harborlight.test')).toHaveLength(3);
    // An hour on, Bob may ask again.
    now += 60 * 60 * 1000 + 1;
    await ask('bob@harborlight.test', '198.51.100.41');
    await waitFor(
      () => mail.filter((m) => m.to === 'bob@harborlight.test').length === 4 || undefined,
      { describe: "Bob's mail after the hour" },
    );
  });

  it('mails one client address at most ten links an hour', async () => {
    const { mail, ask } = route();
    const ip = '198.51.100.99';
    for (let i = 0; i < 11; i++) await ask(`riverbend${i}@harborlight.test`, ip);
    // CONTROL: the same eleventh address from another client is mailed.
    await ask('riverbend10@harborlight.test', '198.51.100.98');
    await waitFor(
      () => mail.filter((m) => m.to === 'riverbend10@harborlight.test').length === 1 || undefined,
      { describe: 'the control mail' },
    );
    expect(mail).toHaveLength(11);
  });
});
