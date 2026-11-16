import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env.ts';
import { RESEND_SEND_URL, composeMail, mailerFromEnv } from '../src/mail.ts';

const KEY = 're_fixture_harborlight';
const FROM = 'Sign-in <signin@mail.harborlight.test>';
const env = (extra: Partial<Env>): Env => ({ ...({} as Env), ...extra });

function recorder(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response('{}', { status });
  }) as typeof fetch;
  return { calls, fetcher };
}

const mail = composeMail('verify-email', 'alice@example.com', 'https://app.test/verify?t=1');

describe('the mail transport', () => {
  it('sends through Resend when the key and the sender are set', async () => {
    const r = recorder();
    await mailerFromEnv(env({ RESEND_API_KEY: KEY, MAIL_FROM: FROM }), r.fetcher).send(mail);
    expect(r.calls).toHaveLength(1);
    const [call] = r.calls;
    expect(call?.url).toBe(RESEND_SEND_URL);
    expect(new Headers(call?.init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(call?.init.body))).toEqual({
      from: FROM,
      to: ['alice@example.com'],
      subject: 'Verify your email',
      text: 'Verify your email: https://app.test/verify?t=1',
    });
  });

  it("throws on Resend's refusal, naming the status and never the key", async () => {
    const r = recorder(403);
    const send = mailerFromEnv(env({ RESEND_API_KEY: KEY, MAIL_FROM: FROM }), r.fetcher).send(mail);
    await expect(send).rejects.toThrow('HTTP 403');
    await expect(send).rejects.not.toThrow(KEY);
  });

  it('refuses to send with a key but no sender, and calls nobody', async () => {
    const r = recorder();
    await expect(mailerFromEnv(env({ RESEND_API_KEY: KEY }), r.fetcher).send(mail)).rejects.toThrow(
      'No mail transport configured',
    );
    expect(r.calls).toHaveLength(0);
  });

  it('logs instead of sending when MAIL_TRANSPORT is log', async () => {
    const r = recorder();
    const env2 = env({ MAIL_TRANSPORT: 'log', RESEND_API_KEY: KEY, MAIL_FROM: FROM });
    const logged: unknown[] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => void logged.push(a.join(' '));
    try {
      await mailerFromEnv(env2, r.fetcher).send(mail);
    } finally {
      console.log = original;
    }
    expect(r.calls).toHaveLength(0);
    expect(logged).toEqual([
      '[mail:verify-email] to=alice@example.com https://app.test/verify?t=1',
    ]);
  });
});
