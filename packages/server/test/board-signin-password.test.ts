import { describe, expect, it } from 'bun:test';
import {
  RESEND_SEND_URL,
  TURNSTILE_VERIFY_URL,
  composeMail,
  passwordSignInFromEnv,
  resendMailer,
  turnstileVerifier,
} from '../src/auth/board-signin-password.ts';

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
  it('asks Cloudflare with the secret, the answer and the address, and takes its yes', async () => {
    const { calls, fetcher } = recorder(() => Response.json({ success: true }));
    const check = turnstileVerifier('site', 'stub-secret', fetcher);
    expect(await check.verify('widget-answer', '198.51.100.7')).toBe(true);
    expect(calls[0]?.url).toBe(TURNSTILE_VERIFY_URL);
    const body = calls[0]?.init.body as URLSearchParams;
    expect(body.get('secret')).toBe('stub-secret');
    expect(body.get('response')).toBe('widget-answer');
    expect(body.get('remoteip')).toBe('198.51.100.7');
  });

  it('is a no on a refusal, an error, a non-200 or an empty answer', async () => {
    const no = turnstileVerifier(
      'site',
      's',
      recorder(() => Response.json({ success: false })).fetcher,
    );
    expect(await no.verify('a', null)).toBe(false);
    const down = turnstileVerifier(
      'site',
      's',
      recorder(() => new Response('', { status: 500 })).fetcher,
    );
    expect(await down.verify('a', null)).toBe(false);
    const thrown = turnstileVerifier('site', 's', async () => {
      throw new Error('offline');
    });
    expect(await thrown.verify('a', null)).toBe(false);
    const { calls, fetcher } = recorder(() => Response.json({ success: true }));
    expect(await turnstileVerifier('site', 's', fetcher).verify('', null)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('the Resend mailer', () => {
  it('sends the mail as plain text to the one address', async () => {
    const { calls, fetcher } = recorder(() => Response.json({ id: 'm1' }));
    const mail = composeMail('reset-password', 'alice@riverbend.test', 'https://r.test/x');
    await resendMailer('stub-key', 'sign-in@riverbend.test', fetcher).send(mail);
    expect(calls[0]?.url).toBe(RESEND_SEND_URL);
    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent).toEqual({
      from: 'sign-in@riverbend.test',
      to: ['alice@riverbend.test'],
      subject: 'Reset your password',
      text: 'Reset your password: https://r.test/x',
    });
  });

  it('throws on a refusal, naming the status only', async () => {
    const { fetcher } = recorder(() => new Response('nope', { status: 403 }));
    const mail = composeMail('verify-email', 'alice@riverbend.test', 'https://r.test/v');
    await expect(resendMailer('stub-key', 'f@riverbend.test', fetcher).send(mail)).rejects.toThrow(
      'Resend refused the verify-email mail: HTTP 403',
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
