import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { admin, captcha, genericOAuth, magicLink } from 'better-auth/plugins';
import type { Env } from './env.ts';
import { type Mailer, composeMail } from './mail.ts';

/** Google's published OAuth endpoints. Tests replace them with a local stub. */
export interface GoogleEndpoints {
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
};

/** The routes Turnstile guards. Each needs an `x-captcha-response` header. */
export const TURNSTILE_PATHS = [
  '/sign-up/email',
  '/sign-in/email',
  '/sign-in/magic-link',
  '/request-password-reset',
];

/** The permission an agent's API key needs to register a user. */
export const REGISTER_USERS = { users: ['create'] };

export interface AuthDeps {
  mailer: Mailer;
  /** Code-level overrides only: no env var can point verification elsewhere. */
  googleEndpoints?: GoogleEndpoints;
  turnstileVerifyUrl?: string;
}

export function createAuth(env: Env, deps: AuthDeps) {
  const send = (kind: Parameters<typeof composeMail>[0], to: string, url: string) =>
    deps.mailer.send(composeMail(kind, to, url));
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.BETTER_AUTH_URL],
    // Better Auth recognises a D1 binding and uses its own Kysely D1 dialect.
    // That dialect refuses interactive transactions; see rate-limit.ts.
    database: env.DB,
    telemetry: { enabled: false },
    // Its built-in limiter keeps counts per isolate in memory. The D1 limiter
    // in app.ts replaces it, so every isolate sees the same counts.
    rateLimit: { enabled: false },
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }) => send('reset-password', user.email, url),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: ({ user, url }) => send('verify-email', user.email, url),
    },
    account: {
      accountLinking: {
        enabled: true,
        // No provider is trusted by name: a second sign-in method joins an
        // existing person only when the provider says the email is verified
        // AND the person's own email is already verified.
        trustedProviders: [],
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
      },
    },
    plugins: [
      magicLink({ sendMagicLink: ({ email, url }) => send('magic-link', email, url) }),
      genericOAuth({
        config: [
          {
            providerId: 'google',
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            ...(deps.googleEndpoints ?? GOOGLE_ENDPOINTS),
            scopes: ['openid', 'email', 'profile'],
            pkce: true,
          },
        ],
      }),
      captcha({
        provider: 'cloudflare-turnstile',
        secretKey: env.TURNSTILE_SECRET_KEY,
        endpoints: TURNSTILE_PATHS,
        ...(deps.turnstileVerifyUrl ? { siteVerifyURLOverride: deps.turnstileVerifyUrl } : {}),
      }),
      admin(),
      apiKey(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
