/**
 * Password sign-in, as every app on the shared stack runs it: the Better Auth
 * options for accounts, password hashing, email verification and sessions,
 * and the mails those flows send.
 *
 * Two places spread these into `betterAuth({...})`: the sign-in Worker
 * (`templates/signin/src/auth.ts`, on D1) and an app made by `new-app`
 * (`templates/app-kit/src/password-sign-in.ts`, on bun:sqlite). So a change
 * to how a password is checked, when a person must verify, or what ends a
 * session is made once and holds for both.
 *
 * Better Auth does the hashing (scrypt) and keeps sessions in the app's
 * database behind a signed cookie; nothing here re-implements either. This
 * file imports nothing, so the Worker and a Bun app can both take it.
 */

export type MailKind = 'verify-email' | 'magic-link' | 'reset-password';

export interface Mail {
  kind: MailKind;
  to: string;
  subject: string;
  text: string;
  /** The link the mail carries. Tests follow it. */
  url: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export function composeMail(kind: MailKind, to: string, url: string): Mail {
  const subject = {
    'verify-email': 'Verify your email',
    'magic-link': 'Your sign-in link',
    'reset-password': 'Reset your password',
  }[kind];
  return { kind, to, subject, url, text: `${subject}: ${url}` };
}

interface MailedUser {
  user: { email: string };
  url: string;
}

/**
 * The options both runtimes share. Spread into `betterAuth({...})` beside the
 * runtime's own database, base URL, secret, rate limiting and plugins.
 */
export function passwordAuthOptions(mailer: Mailer) {
  const send = (kind: MailKind, to: string, url: string) => mailer.send(composeMail(kind, to, url));
  return {
    emailAndPassword: {
      enabled: true,
      // A person proves the address before a password signs them in.
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }: MailedUser) => send('reset-password', user.email, url),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: ({ user, url }: MailedUser) => send('verify-email', user.email, url),
    },
    account: {
      accountLinking: {
        enabled: true,
        // No provider is trusted by name: a second sign-in method joins an
        // existing person only when the provider says the email is verified
        // AND the person's own email is already verified.
        trustedProviders: [] as string[],
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
      },
    },
    telemetry: { enabled: false },
  };
}
