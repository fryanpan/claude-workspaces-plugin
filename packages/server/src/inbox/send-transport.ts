import { fixedHostFetch } from '../outbound-fetch.ts';
/**
 * The one seam between Bryan's Send and the outside world: is this target's
 * credential in place, and send these words to it. The server composes the
 * real one from the Gmail and Slack senders; tests inject a fake, so no test
 * ever reaches Google or Slack.
 */
import type { ReplyTarget } from './reply-target.ts';
import { type FetchLike, type SendOutcome, gmailSender } from './send-gmail.ts';
import { type SendKeychain, systemKeychain } from './send-keychain.ts';
import { slackSender } from './send-slack.ts';

export type { SendOutcome } from './send-gmail.ts';

export interface ReplyTransport {
  ready(target: ReplyTarget): boolean;
  send(target: ReplyTarget, text: string): Promise<SendOutcome>;
}

export function systemTransport(
  deps: { keychain?: SendKeychain; fetch?: FetchLike } = {},
): ReplyTransport {
  const keychain = deps.keychain ?? systemKeychain();
  const fetch = deps.fetch ?? fixedHostFetch;
  const gmail = gmailSender({ keychain, fetch });
  const slack = slackSender({ keychain, fetch });
  return {
    ready: (t) => (t.channel === 'gmail' ? gmail.ready() : slack.ready(t.workspace)),
    send: (t, text) => (t.channel === 'gmail' ? gmail.send(t.threadId, text) : slack.send(t, text)),
  };
}
