/**
 * Where the app's mail goes: the verification link a new account needs, and
 * a password-reset link. The kit ships no mail provider. Until one is wired
 * here (Resend, Postmark, SES), each mail is printed to the terminal, and
 * `server.ts` refuses to start with that under APP_ENV=production.
 */
import type { Mailer } from '@claude-workspaces/app-kit/auth';

/** Prints each mail as one line: `[mail:<kind>] to=<address> <link>`. */
export const logMailer: Mailer = {
  async send(mail) {
    console.log(`[mail:${mail.kind}] to=${mail.to} ${mail.url}`);
  },
};

export function mailerFromEnv(): { mailer: Mailer; real: boolean } {
  return { mailer: logMailer, real: false };
}
