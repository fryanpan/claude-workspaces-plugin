import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, PASSWORD, startHarness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 60_000);
afterAll(() => h.dispose());

async function credentialCount(email: string): Promise<number> {
  const row = await h.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM account a JOIN user u ON u.id = a.userId
     WHERE u.email = ?1 AND a.providerId = 'credential'`,
  )
    .bind(email)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('a magic link and a password on one address', () => {
  it('a password set before the address was proved stops working once a magic link proves it', async () => {
    // Somebody signs up with an address they do not own and never verifies it.
    const email = 'riverbend@example.com';
    const squatter = h.client();
    const signUp = await squatter.post('/api/auth/sign-up/email', {
      email,
      password: PASSWORD,
      name: 'Riverbend',
    });
    expect(signUp.status).toBe(200);
    expect(await credentialCount(email)).toBe(1);

    // The real owner signs in by magic link, proving the inbox.
    const owner = h.client();
    expect(
      (await owner.post('/api/auth/sign-in/magic-link', { email, callbackURL: '/' })).status,
    ).toBe(200);
    await owner.call(h.mailTo('magic-link', email).url);
    expect(await owner.userId()).not.toBeNull();

    // The squatter's password must not now open the owner's account.
    const attempt = await h.client().post('/api/auth/sign-in/email', { email, password: PASSWORD });
    expect(attempt.status).not.toBe(200);
    expect(await credentialCount(email)).toBe(0);
  });

  it('a password the owner verified keeps working beside a magic link', async () => {
    const email = 'harborlight@example.com';
    const c = h.client();
    await c.post('/api/auth/sign-up/email', { email, password: PASSWORD, name: 'Harborlight' });
    await c.call(h.mailTo('verify-email', email).url);

    const link = h.client();
    await link.post('/api/auth/sign-in/magic-link', { email, callbackURL: '/' });
    await link.call(h.mailTo('magic-link', email).url);
    const viaLink = await link.userId();
    expect(viaLink).not.toBeNull();

    const pw = h.client();
    expect((await pw.post('/api/auth/sign-in/email', { email, password: PASSWORD })).status).toBe(
      200,
    );
    expect(await pw.userId()).toBe(viaLink);
    expect(await credentialCount(email)).toBe(1);
  });
});
