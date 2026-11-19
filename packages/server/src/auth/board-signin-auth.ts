/**
 * The Better Auth instance behind `board-signin.ts`, in a module of its own
 * so it is loaded only when a machine turns sign-in on: `board-signin.ts`
 * imports it dynamically, and a machine on `CW_SIGNIN=access` never pays
 * for better-auth, kysely and the migration code at boot.
 *
 * Everything it needs is passed in, so nothing here imports
 * `board-signin.ts` back. The reasons behind each setting are written there
 * and beside each line below.
 */
import type { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { normalizeEmail } from '@claude-workspaces/core';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { genericOAuth } from 'better-auth/plugins';

export interface AuthInput {
  /** The https sign-in origin. */
  origin: string;
  basePath: string;
  secret: string;
  cookiePrefix: string;
  google: {
    clientId: string;
    clientSecret: string;
    endpoints: { authorizationUrl: string; tokenUrl: string; userInfoUrl: string };
  };
  rateLimitStore: {
    consume(
      key: string,
      rule: { window: number; max: number },
    ): Promise<{ allowed: boolean; retryAfter: number | null }>;
  };
  mayHaveAccount: (email: string, verified: boolean) => boolean;
  /** Whether passwords are on here (`board-signin-password.ts`). */
  password?: boolean;
  onSessionCreated?: (person: { email: string; emailVerified: boolean }) => void;
}

export function createAuth(opts: AuthInput, db: Database) {
  return betterAuth({
    baseURL: opts.origin,
    basePath: opts.basePath,
    secret: opts.secret,
    trustedOrigins: [opts.origin],
    database: db,
    telemetry: { enabled: false },
    // One process holds every count, so an in-memory limiter is exact. Its
    // own, not the library's `memory` store: that one is a module-level map,
    // which two instances in one process (the test suites) would share.
    rateLimit: { enabled: true, window: 60, max: 20, customStorage: opts.rateLimitStore },
    advanced: {
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      // `__Host-` rather than the library's `__Secure-`: it makes the browser
      // refuse any Domain, so the cookie cannot reach a sibling host. The
      // library's own prefix is switched off and ours written into the name.
      useSecureCookies: false,
      cookiePrefix: opts.cookiePrefix,
      defaultCookieAttributes: { secure: true, path: '/', sameSite: 'lax', httpOnly: true },
    },
    user: {
      additionalFields: {
        // Recorded at every Google sign-in, read by nothing yet: a stricter
        // domain-share rule could require it later (plan 3.4). An input field
        // only because the library drops a non-input field from the provider
        // profile; the one route that takes user input, `/update-user`, is
        // not in `BETTER_AUTH_PATHS`, so a person cannot write it.
        hd: { type: 'string', required: false },
      },
    },
    account: { accountLinking: { enabled: false } },
    // Passwords (`board-signin-password.ts`): kept in this machine's own user
    // list and checked here at sign-in. Better Auth's own sign-up is off: an
    // account with a password is made only by `createPasswordAccounts`, once
    // the address has followed the link mailed to it.
    ...(opts.password
      ? { emailAndPassword: { enabled: true, disableSignUp: true, requireEmailVerification: true } }
      : {}),
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            if (!opts.onSessionCreated) return;
            const row = db
              .query('SELECT email, emailVerified FROM "user" WHERE id = ?')
              .get(String(session.userId)) as { email: string; emailVerified: number } | null;
            if (!row) return;
            opts.onSessionCreated({
              email: normalizeEmail(row.email),
              emailVerified: row.emailVerified === 1,
            });
          },
        },
      },
      user: {
        create: {
          before: async (user) => {
            const email = normalizeEmail(String(user.email ?? ''));
            if (email === '') return false;
            return opts.mayHaveAccount(email, user.emailVerified === true) ? undefined : false;
          },
        },
      },
    },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: 'google',
            clientId: opts.google.clientId,
            clientSecret: opts.google.clientSecret,
            ...opts.google.endpoints,
            scopes: ['openid', 'email', 'profile'],
            pkce: true,
            // The account picker, never the consent screen again (plan 3.3).
            prompt: 'select_account',
            // Google's stable account id. Never the email: an address can
            // change hands, a subject cannot.
            accountSubject: ({ profile }) => String(profile.sub ?? ''),
            mapProfileToUser: (profile) => {
              const emailVerified = profile.email_verified === true;
              // Google proves the address; a row nobody proved must not
              // stand in its way (the lookup by email comes after this).
              if (emailVerified) dropUnproven(db, normalizeEmail(String(profile.email ?? '')));
              return { emailVerified, hd: typeof profile.hd === 'string' ? profile.hd : null };
            },
            // So `emailVerified` and `hd` follow Google at every sign-in.
            overrideUserInfo: true,
          },
        ],
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Make the tables Better Auth needs, where they are missing. */
export async function migrate(auth: Auth): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

/**
 * Remove an account nobody proved: an unverified user whose only sign-ins
 * are passwords. Accounts made since passwords are set only through a link
 * never look like this; an older one, or one left by a stranger, would
 * otherwise answer "account not linked" to the address's own Google
 * sign-in for good.
 */
function dropUnproven(db: Database, email: string): void {
  removeUnverified(db, email, { passwordOnly: true });
}

/**
 * Delete the unverified user for this address, with its sessions and
 * sign-ins, in one transaction. `passwordOnly` keeps one that also signs in
 * some other way.
 */
function removeUnverified(db: Database, email: string, opts: { passwordOnly: boolean }): void {
  if (email === '') return;
  db.transaction(() => {
    const row = db
      .query('SELECT id FROM "user" WHERE email = ? AND emailVerified = 0')
      .get(email) as { id: string } | null;
    if (!row) return;
    const other = db
      .query(`SELECT 1 FROM account WHERE userId = ? AND providerId != 'credential' LIMIT 1`)
      .get(row.id);
    if (opts.passwordOnly && other) return;
    for (const table of ['session', 'account']) {
      db.query(`DELETE FROM ${table} WHERE userId = ?`).run(row.id);
    }
    db.query('DELETE FROM "user" WHERE id = ?').run(row.id);
  })();
}

const LINK_PREFIX = 'cw-set-password:';
const LINK_TTL_MS = 60 * 60 * 1000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
/** Only a hash of the token is stored, so a read of the table opens nothing. */
const linkId = (token: string): string =>
  LINK_PREFIX + createHash('sha256').update(token).digest('base64url');

/**
 * Set-password links (`board-signin-password.ts`). A link is the only way an
 * account with a password comes to exist, so following one is what proves
 * the address: no row and no password exist before it is used.
 */
export function createPasswordAccounts(
  auth: Auth,
  db: Database,
  opts: { origin: string; mayHaveAccount: (email: string, verified: boolean) => boolean },
) {
  // One account change at a time: the user list has no unique email, so two
  // links used at once must not both find no account and both make one.
  let queue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  const save = async (email: string, hash: string): Promise<boolean> => {
    const adapter = (await auth.$context).internalAdapter;
    // The link proved the address: whatever an unproved row carried was
    // never proved, so it goes, and a verified account is made fresh.
    removeUnverified(db, email, { passwordOnly: false });
    const found = await adapter.findUserByEmail(email, { includeAccounts: true });
    let userId: string;
    let accounts: { providerId: string }[] = [];
    if (found?.user.emailVerified) {
      userId = found.user.id;
      accounts = found.accounts;
    } else {
      const user = await adapter.createUser(
        { email, name: '', emailVerified: true },
        { method: 'admin' },
      );
      if (!user) return false;
      userId = user.id;
    }
    if (accounts.some((a) => a.providerId === 'credential')) {
      await adapter.updatePassword(userId, hash);
    } else {
      await adapter.linkAccount({
        userId,
        providerId: 'credential',
        accountId: userId,
        password: hash,
      });
    }
    // A new password ends every session the old one, or a thief, opened.
    await adapter.deleteUserSessions(userId);
    return true;
  };

  return {
    async issueLink(raw: string): Promise<string | null> {
      const email = normalizeEmail(raw);
      if (email === '' || email.length > 254 || !email.includes('@')) return null;
      if (!opts.mayHaveAccount(email, true)) return null;
      const ctx = await auth.$context;
      const token = randomBytes(32).toString('base64url');
      await ctx.internalAdapter.createVerificationValue({
        identifier: linkId(token),
        value: email,
        expiresAt: new Date(Date.now() + LINK_TTL_MS),
      });
      // In the fragment, which no request carries: not to our server, not in
      // a Referer, and the page clears it before any other script loads.
      return `${opts.origin}/auth/set-password#token=${token}`;
    },

    async setPassword(token: string, password: string): Promise<boolean> {
      if (!TOKEN_SHAPE.test(token)) return false;
      try {
        const ctx = await auth.$context;
        // Single-use and atomic; an expired row is consumed and answers null.
        const link = await ctx.internalAdapter.consumeVerificationValue(linkId(token));
        if (!link) return false;
        const email = link.value;
        // Using one link retires every other one mailed to the address.
        db.query(
          `DELETE FROM verification WHERE identifier LIKE '${LINK_PREFIX}%' AND value = ?`,
        ).run(email);
        // Who may hold an account can change within the hour.
        if (!opts.mayHaveAccount(email, true)) return false;
        const hash = await ctx.password.hash(password);
        return await oneAtATime(() => save(email, hash));
      } catch (e) {
        console.error(`[signin] setting a password failed: ${e instanceof Error ? e.message : e}`);
        return false;
      }
    },
  };
}
