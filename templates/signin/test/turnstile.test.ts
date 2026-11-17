import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, PASSWORD, signUpVerified, startHarness } from './harness.ts';
import { TURNSTILE_FAIL_SECRET } from './stubs.ts';

const GUARDED: Array<[string, (email: string) => Record<string, string>]> = [
  ['/api/auth/sign-up/email', (email) => ({ email, password: PASSWORD, name: 'Alice' })],
  ['/api/auth/sign-in/magic-link', (email) => ({ email, callbackURL: '/' })],
  ['/api/auth/sign-in/email', (email) => ({ email, password: PASSWORD })],
];

describe('Turnstile with the always-pass test secret', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  }, 60_000);
  afterAll(() => h.dispose());

  it('lets a request with a token through on each guarded route', async () => {
    await signUpVerified(h, 'bob@example.com', 'Bob');
    const before = h.stubs.turnstileCalls;
    expect((await h.client().post(...route(0, 'alice@example.com'))).status).toBe(200);
    expect((await h.client().post(...route(1, 'riverbend@example.com'))).status).toBe(200);
    expect((await h.client().post(...route(2, 'bob@example.com'))).status).toBe(200);
    expect(h.stubs.turnstileCalls - before).toBe(3);
  });

  it('refuses a request with no token at all', async () => {
    for (let i = 0; i < GUARDED.length; i++) {
      const res = await h.client().post(...route(i, 'saltmarsh@example.com'), { turnstile: false });
      expect(res.status).toBe(400);
    }
  });
});

describe('Turnstile with the always-fail test secret', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ turnstileSecret: TURNSTILE_FAIL_SECRET });
  }, 60_000);
  afterAll(() => h.dispose());

  it('refuses every guarded route, and nothing is created or mailed', async () => {
    for (let i = 0; i < GUARDED.length; i++) {
      const res = await h.client().post(...route(i, 'harborlight@example.com'));
      expect(res.status).toBe(403);
    }
    expect(h.mails).toEqual([]);
    const users = await h.env.DB.prepare('SELECT COUNT(*) AS n FROM user').first<{ n: number }>();
    expect(users?.n).toBe(0);
  });
});

function route(i: number, email: string): [string, Record<string, string>] {
  const [path, body] = GUARDED[i] ?? GUARDED[0]!;
  return [path, body(email)];
}
