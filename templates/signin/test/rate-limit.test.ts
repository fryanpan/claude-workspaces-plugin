import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMAIL_RULE, IP_RULE, takeRateSlot } from '../src/rate-limit.ts';
import { type Harness, PASSWORD, signUpVerified, startHarness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 60_000);
afterAll(() => h.dispose());

const MINUTE = 60_000;

describe('per-email limit: 3 per route per 15 minutes, kept in D1', () => {
  it('refuses the 4th attempt for one address, even from different IPs', async () => {
    await signUpVerified(h, 'alice@example.com', 'Alice'); // counts once
    h.clock.advance(15 * MINUTE);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await h
        .client()
        .post('/api/auth/sign-in/email', { email: 'Alice@Example.com', password: PASSWORD });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('refuses one route past its limit, answers Retry-After, and frees a slot when the oldest attempt ages out', async () => {
    const email = 'bob@example.com';
    const c = h.client();
    const ask = () => c.post('/api/auth/sign-in/magic-link', { email, callbackURL: '/' });
    expect((await ask()).status).toBe(200); // t=0
    h.clock.advance(5 * MINUTE);
    expect((await ask()).status).toBe(200); // t=5
    expect((await ask()).status).toBe(200); // t=5
    h.clock.advance(5 * MINUTE);
    const refused = await ask(); // t=10
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe(String(5 * 60));

    // Another route for the same address has its own allowance.
    const reset = await c.post('/api/auth/request-password-reset', { email, redirectTo: '/reset' });
    expect(reset.status).toBe(200);

    h.clock.advance(5 * MINUTE - 1); // one millisecond before t=0 leaves the window
    expect((await ask()).status).toBe(429);
    h.clock.advance(1);
    expect((await ask()).status).toBe(200);
  });

  it('lets a normal sign-up, sign-in, reset and sign-in happen inside 15 minutes', async () => {
    h.clock.advance(15 * MINUTE);
    const email = 'harborlight@example.com';
    const c = h.client();
    const signUp = await c.post('/api/auth/sign-up/email', {
      email,
      password: PASSWORD,
      name: 'Harborlight',
    });
    expect(signUp.status).toBe(200);
    await c.call(h.mailTo('verify-email', email).url);
    h.clock.advance(MINUTE);
    expect((await c.post('/api/auth/sign-in/email', { email, password: PASSWORD })).status).toBe(
      200,
    );
    h.clock.advance(MINUTE);
    expect(
      (await c.post('/api/auth/request-password-reset', { email, redirectTo: '/reset' })).status,
    ).toBe(200);
    const link = await c.call(h.mailTo('reset-password', email).url);
    const token = new URL(link.headers.get('location') ?? '', 'http://x').searchParams.get('token');
    expect(
      (await c.post('/api/auth/reset-password', { token, newPassword: 'a-brand-new-password' }))
        .status,
    ).toBe(200);
    h.clock.advance(MINUTE);
    const signIn = await c.post('/api/auth/sign-in/email', {
      email,
      password: 'a-brand-new-password',
    });
    expect(signIn.status).toBe(200);
    expect(await c.userId()).not.toBeNull();
  });

  it('counts a form-encoded attempt the same as a JSON one', async () => {
    h.clock.advance(15 * MINUTE);
    const c = h.client();
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    const asForm = () =>
      c.call('/api/auth/sign-in/email', {
        method: 'POST',
        headers: form,
        rawBody: `email=alice%40example.com&password=${PASSWORD}`,
      });
    expect((await asForm()).status).toBe(200);
    expect((await asForm()).status).toBe(200);
    expect(
      (await c.post('/api/auth/sign-in/email', { email: 'alice@example.com', password: PASSWORD }))
        .status,
    ).toBe(200);
    expect((await asForm()).status).toBe(429);
  });

  it('does not let a refused attempt extend the lockout', async () => {
    const at = h.clock.now;
    for (let i = 0; i < 3; i++)
      await takeRateSlot(h.env.DB, EMAIL_RULE, 'saltmarsh@example.com', at);
    for (let i = 0; i < 5; i++) {
      const v = await takeRateSlot(
        h.env.DB,
        EMAIL_RULE,
        'saltmarsh@example.com',
        at + (i + 1) * MINUTE,
      );
      expect(v.allowed).toBe(false);
    }
    const later = await takeRateSlot(
      h.env.DB,
      EMAIL_RULE,
      'saltmarsh@example.com',
      at + EMAIL_RULE.windowMs + 1,
    );
    expect(later.allowed).toBe(true);
  });
});

describe('per-IP limit: 20 per minute from CF-Connecting-IP', () => {
  it('refuses the 21st auth request from one IP and still serves another IP', async () => {
    h.clock.advance(15 * MINUTE);
    const c = h.client({ ip: '198.51.100.7' });
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      // A different address each time, so only the IP rule can refuse.
      const res = await c.post('/api/auth/sign-in/email', {
        email: `harborlight${i}@example.com`,
        password: PASSWORD,
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every((s) => s !== 429)).toBe(true);
    expect(statuses[20]).toBe(429);

    const other = h.client({ ip: '198.51.100.8' });
    const res = await other.post('/api/auth/sign-in/email', {
      email: 'riverbend@example.com',
      password: PASSWORD,
    });
    expect(res.status).not.toBe(429);

    h.clock.advance(IP_RULE.windowMs + 1);
    const again = await c.post('/api/auth/sign-in/email', {
      email: 'harborlight99@example.com',
      password: PASSWORD,
    });
    expect(again.status).not.toBe(429);
  });

  it('keeps the count in the database, so a second app instance sees it', async () => {
    h.clock.advance(15 * MINUTE);
    const { createApp } = await import('../src/app.ts');
    const second = createApp({ mailer: () => ({ send: async () => {} }), now: () => h.clock.now });
    const ip = '198.51.100.9';
    for (let i = 0; i < 20; i++) await takeRateSlot(h.env.DB, IP_RULE, ip, h.clock.now);
    const res = await second.fetch(
      new Request('http://localhost:8797/api/auth/sign-in/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': ip,
          origin: 'http://localhost:8797',
        },
        body: JSON.stringify({ email: 'bob@example.com', password: PASSWORD }),
      }),
      h.env,
    );
    expect(res.status).toBe(429);
  });
});
