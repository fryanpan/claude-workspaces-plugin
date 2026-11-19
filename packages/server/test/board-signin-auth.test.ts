/**
 * The Better Auth instance on its own, over an in-memory user list: its
 * tables are made on first use, and an account is refused for an address
 * `mayHaveAccount` does not admit. The whole sign-in, through Google, is
 * `board-signin.test.ts`.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { createAuth, migrate } from '../src/auth/board-signin-auth.ts';
import { ownRateLimitStore } from '../src/auth/board-signin.ts';

const build = (allowed: string[]) => {
  const db = new Database(':memory:');
  const auth = createAuth(
    {
      origin: 'https://riverbend-workspaces.harborlight.test',
      basePath: '/api/auth',
      secret: 'a-test-secret-of-sufficient-length-for-better-auth',
      cookiePrefix: '__Host-cw-ba',
      google: {
        clientId: 'shared-client',
        clientSecret: 'stub-secret',
        endpoints: {
          authorizationUrl: 'http://127.0.0.1:9/authorize',
          tokenUrl: 'http://127.0.0.1:9/token',
          userInfoUrl: 'http://127.0.0.1:9/userinfo',
        },
      },
      rateLimitStore: ownRateLimitStore(),
      mayHaveAccount: (email, verified) => verified && allowed.includes(email),
    },
    db,
  );
  return { db, auth };
};

const tables = (db: Database) =>
  (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
    .map((r) => r.name)
    .sort();

describe('the Better Auth instance', () => {
  it('makes its tables on first use, and only then', async () => {
    const { db, auth } = build([]);
    expect(tables(db)).toEqual([]);
    await migrate(auth);
    expect(tables(db)).toEqual(expect.arrayContaining(['account', 'session', 'user']));
    db.close();
  });

  it('refuses an account for an address it does not admit', async () => {
    const { db, auth } = build(['alice@harborlight.test']);
    await migrate(auth);
    const ctx = await auth.$context;
    const bob = await ctx.internalAdapter
      .createUser({ email: 'bob@saltmarsh.test', name: 'Bob', emailVerified: true })
      .catch(() => null);
    expect(bob).toBeNull();
    // CONTROL: an admitted, verified address gets one.
    const alice = await ctx.internalAdapter.createUser({
      email: 'alice@harborlight.test',
      name: 'Alice',
      emailVerified: true,
    });
    expect(alice?.email).toBe('alice@harborlight.test');
    db.close();
  });
});
