/**
 * The Better Auth instance on its own, over an in-memory user list: its
 * tables are made on first use, and an account is refused for an address
 * `mayHaveAccount` does not admit. The whole sign-in, through Google, is
 * `board-signin.test.ts`.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { createAuth, createPasswordAccounts, migrate } from '../src/auth/board-signin-auth.ts';
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
      .createUser(
        { email: 'bob@saltmarsh.test', name: 'Bob', emailVerified: true },
        { method: 'admin' },
      )
      .catch(() => null);
    expect(bob).toBeNull();
    // CONTROL: an admitted, verified address gets one.
    const alice = await ctx.internalAdapter.createUser(
      {
        email: 'alice@harborlight.test',
        name: 'Alice',
        emailVerified: true,
      },
      { method: 'admin' },
    );
    expect(alice?.email).toBe('alice@harborlight.test');
    db.close();
  });
});

describe('set-password links', () => {
  const ALICE = 'alice@harborlight.test';
  const ORIGIN = 'https://riverbend-workspaces.harborlight.test';
  const ready = async () => {
    const { db, auth } = build([ALICE]);
    await migrate(auth);
    const accounts = createPasswordAccounts(auth, db, {
      origin: ORIGIN,
      mayHaveAccount: (email) => email === ALICE,
    });
    return { db, auth, accounts };
  };
  const tokenOf = (url: string | null) => new URL(url ?? '').hash.replace('#token=', '');
  const users = (db: Database) =>
    db.query('SELECT id, emailVerified FROM "user" WHERE email = ?').all(ALICE) as {
      id: string;
      emailVerified: number;
    }[];
  const credentials = (db: Database) =>
    db.query(`SELECT userId FROM account WHERE providerId = 'credential'`).all() as {
      userId: string;
    }[];

  it('carries the token in the fragment, never the query', async () => {
    const { db, accounts } = await ready();
    const url = new URL((await accounts.issueLink(ALICE)) ?? '');
    expect(url.search).toBe('');
    expect(url.hash).toMatch(/^#token=[A-Za-z0-9_-]{43}$/);
    db.close();
  });

  it('retires every other link for the address once one is used', async () => {
    const { db, accounts } = await ready();
    const first = tokenOf(await accounts.issueLink(ALICE));
    const second = tokenOf(await accounts.issueLink(ALICE));
    expect(await accounts.setPassword(second, 'alice-pass-one')).toBe(true);
    expect(await accounts.setPassword(first, 'alice-pass-two')).toBe(false);
    db.close();
  });

  it('two first links used at once make one account with one password', async () => {
    const { db, auth, accounts } = await ready();
    const a = tokenOf(await accounts.issueLink(ALICE));
    const b = tokenOf(await accounts.issueLink(ALICE));
    // Hold each account lookup until both passwords are hashed (or one call
    // has already finished), so both look before either has made the account.
    const ctx = await auth.$context;
    const { hash } = ctx.password;
    const find = ctx.internalAdapter.findUserByEmail;
    let hashed = 0;
    let release = () => {};
    const both = new Promise<void>((r) => {
      release = r;
    });
    ctx.password.hash = async (pw: string) => {
      const out = await hash(pw);
      if (++hashed === 2) release();
      return out;
    };
    ctx.internalAdapter.findUserByEmail = (async (...args: Parameters<typeof find>) => {
      await both;
      return find(...args);
    }) as typeof find;
    const calls = [
      accounts.setPassword(a, 'alice-pass-one'),
      accounts.setPassword(b, 'alice-pass-two'),
    ];
    for (const c of calls) void c.finally(release);
    const results = await Promise.all(calls);
    ctx.password.hash = hash;
    ctx.internalAdapter.findUserByEmail = find;
    // At least one sets a password; whichever ran second either found its
    // link retired or set the password on the account the first made.
    expect(results.filter(Boolean).length).toBeGreaterThan(0);
    expect(users(db)).toHaveLength(1);
    expect(credentials(db)).toHaveLength(1);
    db.close();
  });

  it('an unproved row removed mid-way still leaves one verified account with its password', async () => {
    const { db, auth, accounts } = await ready();
    const ctx = await auth.$context;
    // An unproved row, as an earlier version could leave one.
    const at = new Date().toISOString();
    db.query(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)',
    ).run('stale-alice', 'Alice', ALICE, at, at);
    const token = tokenOf(await accounts.issueLink(ALICE));
    // A Google sign-in's `dropUnproven` removes the row right after the
    // lookup has seen it.
    const find = ctx.internalAdapter.findUserByEmail;
    ctx.internalAdapter.findUserByEmail = (async (...args: Parameters<typeof find>) => {
      const found = await find(...args);
      db.query('DELETE FROM "user" WHERE email = ? AND emailVerified = 0').run(ALICE);
      return found;
    }) as typeof find;
    try {
      expect(await accounts.setPassword(token, 'alice-pass-one')).toBe(true);
    } finally {
      ctx.internalAdapter.findUserByEmail = find;
    }
    const [user] = users(db);
    expect(users(db)).toHaveLength(1);
    expect(user?.emailVerified).toBe(1);
    expect(credentials(db).map((c) => c.userId)).toEqual([user?.id ?? '']);
    db.close();
  });
});
