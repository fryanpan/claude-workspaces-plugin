import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 60_000);
afterAll(() => h.dispose());

describe('magic link', () => {
  it('signs a new person in through the mailed link, with a verified email', async () => {
    const c = h.client();
    const ask = await c.post('/api/auth/sign-in/magic-link', {
      email: 'saltmarsh@example.com',
      callbackURL: '/',
    });
    expect(ask.status).toBe(200);
    expect(await c.userId()).toBeNull();

    const mail = h.mailTo('magic-link', 'saltmarsh@example.com');
    const follow = await c.call(mail.url);
    expect(follow.status).toBe(302);
    expect(await c.userId()).not.toBeNull();

    const session = (await (await c.call('/api/auth/get-session')).json()) as {
      user: { email: string; emailVerified: boolean };
    };
    expect(session.user).toMatchObject({ email: 'saltmarsh@example.com', emailVerified: true });
  });

  it('a link works once', async () => {
    const first = h.client();
    await first.post('/api/auth/sign-in/magic-link', {
      email: 'harborlight@example.com',
      callbackURL: '/',
    });
    const { url } = h.mailTo('magic-link', 'harborlight@example.com');
    await first.call(url);
    expect(await first.userId()).not.toBeNull();

    const replay = h.client();
    await replay.call(url);
    expect(await replay.userId()).toBeNull();
  });
});
