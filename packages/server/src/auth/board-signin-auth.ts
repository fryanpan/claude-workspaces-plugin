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
            mapProfileToUser: (profile) => ({
              emailVerified: profile.email_verified === true,
              hd: typeof profile.hd === 'string' ? profile.hd : null,
            }),
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
