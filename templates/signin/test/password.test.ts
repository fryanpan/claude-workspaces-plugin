import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, PASSWORD, signUpVerified, startHarness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 60_000);
afterAll(() => h.dispose());

describe('password sign-in', () => {
  it('refuses sign-in until the email is verified, then signs in', async () => {
    const c = h.client();
    const signUp = await c.post('/api/auth/sign-up/email', {
      email: 'alice@example.com',
      password: PASSWORD,
      name: 'Alice',
    });
    expect(signUp.status).toBe(200);
    expect(await c.userId()).toBeNull();

    const early = await c.post('/api/auth/sign-in/email', {
      email: 'alice@example.com',
      password: PASSWORD,
    });
    expect(early.status).toBe(403);
    expect(await c.userId()).toBeNull();

    await c.call(h.mailTo('verify-email', 'alice@example.com').url);
    const ok = await c.post('/api/auth/sign-in/email', {
      email: 'alice@example.com',
      password: PASSWORD,
    });
    expect(ok.status).toBe(200);
    expect(await c.userId()).not.toBeNull();
  });

  it('refuses a wrong password', async () => {
    await signUpVerified(h, 'bob@example.com', 'Bob');
    const c = h.client();
    const res = await c.post('/api/auth/sign-in/email', {
      email: 'bob@example.com',
      password: 'not-the-password',
    });
    expect(res.status).toBe(401);
    expect(await c.userId()).toBeNull();
  });
});

describe('password reset', () => {
  it('sets a new password through the mailed link and ends the old sessions', async () => {
    const email = 'riverbend@example.com';
    const userId = await signUpVerified(h, email, 'Riverbend');
    const before = h.client();
    expect(
      (await before.post('/api/auth/sign-in/email', { email, password: PASSWORD })).status,
    ).toBe(200);
    expect(await before.userId()).toBe(userId);

    const asker = h.client();
    const ask = await asker.post('/api/auth/request-password-reset', {
      email,
      redirectTo: '/reset',
    });
    expect(ask.status).toBe(200);
    // The mailed link redirects to the app's reset page with the token.
    const link = await asker.call(h.mailTo('reset-password', email).url);
    const token = new URL(link.headers.get('location') ?? '', 'http://x').searchParams.get('token');
    expect(token).toBeTruthy();

    const reset = await asker.post('/api/auth/reset-password', {
      token,
      newPassword: 'a-brand-new-password',
    });
    expect(reset.status).toBe(200);
    expect(await before.userId()).toBeNull();

    h.clock.advance(15 * 60_000); // past the per-email limit window
    const old = h.client();
    expect((await old.post('/api/auth/sign-in/email', { email, password: PASSWORD })).status).toBe(
      401,
    );
    const fresh = h.client();
    const res = await fresh.post('/api/auth/sign-in/email', {
      email,
      password: 'a-brand-new-password',
    });
    expect(res.status).toBe(200);
    expect(await fresh.userId()).toBe(userId);
  });
});
