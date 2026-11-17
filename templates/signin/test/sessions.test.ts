import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, signUpVerified, signedIn, startHarness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 60_000);
afterAll(() => h.dispose());

describe('signing out everywhere', () => {
  it('ends every session of that person and no one else', async () => {
    const aliceId = await signUpVerified(h, 'alice@example.com', 'Alice');
    const bobId = await signUpVerified(h, 'bob@example.com', 'Bob');
    const laptop = await signedIn(h, 'alice@example.com');
    const phone = await signedIn(h, 'alice@example.com');
    h.clock.advance(15 * 60_000);
    const tablet = await signedIn(h, 'alice@example.com');
    const bob = await signedIn(h, 'bob@example.com');
    for (const c of [laptop, phone, tablet]) expect(await c.userId()).toBe(aliceId);

    const res = await phone.post('/api/auth/revoke-sessions', {});
    expect(res.status).toBe(200);

    for (const c of [laptop, phone, tablet]) expect(await c.userId()).toBeNull();
    expect(await bob.userId()).toBe(bobId);
    const left = await h.env.DB.prepare('SELECT COUNT(*) AS n FROM session WHERE userId = ?1')
      .bind(aliceId)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
