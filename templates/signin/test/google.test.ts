import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, type Harness, PASSWORD, startHarness } from './harness.ts';
import type { GoogleProfile } from './stubs.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 60_000);
afterAll(() => h.dispose());

/** Runs the browser half of the OAuth dance against the local Google stub. */
async function signInWithGoogle(c: Client, profile: GoogleProfile): Promise<Response> {
  const start = await c.post('/api/auth/sign-in/social', { provider: 'google', callbackURL: '/' });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorize = new URL(url);
  expect(authorize.pathname).toBe('/google/authorize');
  const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '');
  callback.searchParams.set('code', h.stubs.issueGoogleCode(profile));
  callback.searchParams.set('state', authorize.searchParams.get('state') ?? '');
  return c.call(callback.pathname + callback.search);
}

async function accountsOf(userId: string): Promise<string[]> {
  const rows = await h.env.DB.prepare(
    'SELECT providerId FROM account WHERE userId = ?1 ORDER BY providerId',
  )
    .bind(userId)
    .all<{ providerId: string }>();
  return rows.results.map((r) => r.providerId);
}

const profile = (email: string, verified: boolean, sub: string): GoogleProfile => ({
  sub,
  email,
  email_verified: verified,
  name: 'Alice',
});

describe('Google sign-in (stubbed provider)', () => {
  it('signs a new person in', async () => {
    const c = h.client();
    const res = await signInWithGoogle(c, profile('alice@example.com', true, 'g-alice'));
    expect(res.status).toBe(302);
    const userId = await c.userId();
    expect(userId).not.toBeNull();
    expect(await accountsOf(userId ?? '')).toEqual(['google']);
  });
});

describe('linking a second sign-in method to one person', () => {
  async function passwordPerson(email: string, verify: boolean): Promise<string> {
    const c = h.client();
    const res = await c.post('/api/auth/sign-up/email', { email, password: PASSWORD, name: 'Bob' });
    const { user } = (await res.json()) as { user: { id: string } };
    if (verify) await c.call(h.mailTo('verify-email', email).url);
    return user.id;
  }

  it('links Google to a password account when both emails are verified', async () => {
    const userId = await passwordPerson('bob@example.com', true);
    const c = h.client();
    await signInWithGoogle(c, profile('bob@example.com', true, 'g-bob'));
    expect(await c.userId()).toBe(userId);
    expect(await accountsOf(userId)).toEqual(['credential', 'google']);
  });

  it('refuses when Google does not vouch for the email', async () => {
    const userId = await passwordPerson('riverbend@example.com', true);
    const c = h.client();
    const res = await signInWithGoogle(c, profile('riverbend@example.com', false, 'g-riverbend'));
    expect(res.headers.get('location')).toContain('error=account_not_linked');
    expect(await c.userId()).toBeNull();
    expect(await accountsOf(userId)).toEqual(['credential']);
  });

  it('refuses when the existing account never verified its email', async () => {
    // Someone signed up with this address and never proved the inbox. Linking
    // would hand the real owner's Google sign-in to whoever chose that password.
    const userId = await passwordPerson('saltmarsh@example.com', false);
    const c = h.client();
    const res = await signInWithGoogle(c, profile('saltmarsh@example.com', true, 'g-saltmarsh'));
    expect(res.headers.get('location')).toContain('error=account_not_linked');
    expect(await c.userId()).toBeNull();
    expect(await accountsOf(userId)).toEqual(['credential']);
  });
});
