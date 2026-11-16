import type { Mail, Mailer } from '@claude-workspaces/app-kit/auth';
import type { Env } from './env.ts';

export type { Mail, MailKind, Mailer } from '@claude-workspaces/app-kit/auth';
export { composeMail } from '@claude-workspaces/app-kit/auth';

/** Resend's send endpoint (resend.com/docs/api-reference/emails/send-email). */
export const RESEND_SEND_URL = 'https://api.resend.com/emails';

/**
 * The mail transport, chosen from the Worker's config:
 *
 * - `MAIL_TRANSPORT=log` prints each mail, link included. Local runs only.
 * - `RESEND_API_KEY` and `MAIL_FROM` both set: sends through Resend. Give the
 *   app a send-only key for its own domain.
 * - Neither: a deployed Worker refuses to send rather than dropping the mail.
 *
 * To use another provider, replace the Resend branch.
 */
export function mailerFromEnv(env: Env, fetcher: typeof fetch = fetch): Mailer {
  if (env.MAIL_TRANSPORT === 'log') {
    return {
      async send(mail) {
        console.log(`[mail:${mail.kind}] to=${mail.to} ${mail.url}`);
      },
    };
  }
  const key = env.RESEND_API_KEY?.trim();
  const from = env.MAIL_FROM?.trim();
  if (key && from) return resendMailer(key, from, fetcher);
  return {
    async send() {
      throw new Error('No mail transport configured: set RESEND_API_KEY and MAIL_FROM');
    },
  };
}

/** Sends each mail as plain text through Resend. A refusal throws, naming the status only. */
export function resendMailer(key: string, from: string, fetcher: typeof fetch = fetch): Mailer {
  return {
    async send(mail: Mail) {
      const res = await fetcher(RESEND_SEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
      });
      if (!res.ok) throw new Error(`Resend refused the ${mail.kind} mail: HTTP ${res.status}`);
    },
  };
}
