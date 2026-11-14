import type { Env } from './env.ts';

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

export function composeMail(kind: MailKind, to: string, url: string): Mail {
  const subject = {
    'verify-email': 'Verify your email',
    'magic-link': 'Your sign-in link',
    'reset-password': 'Reset your password',
  }[kind];
  return { kind, to, subject, url, text: `${subject}: ${url}` };
}
