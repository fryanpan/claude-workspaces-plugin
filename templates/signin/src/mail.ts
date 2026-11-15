import type { Mailer } from '@claude-workspaces/app-kit/auth';
import type { Env } from './env.ts';

export type { Mail, MailKind, Mailer } from '@claude-workspaces/app-kit/auth';
export { composeMail } from '@claude-workspaces/app-kit/auth';

/**
 * The template ships no mail provider. Wire yours here (Resend, Postmark,
 * Cloudflare Email Routing). Until then a deployed Worker refuses to send
 * rather than dropping the mail, and `MAIL_TRANSPORT=log` prints it for local
 * development.
 */
export function mailerFromEnv(env: Env): Mailer {
  if (env.MAIL_TRANSPORT === 'log') {
    return {
      async send(mail) {
        console.log(`[mail:${mail.kind}] to=${mail.to} ${mail.url}`);
      },
    };
  }
  return {
    async send() {
      throw new Error('No mail transport configured: wire a provider in src/mail.ts');
    },
  };
}
