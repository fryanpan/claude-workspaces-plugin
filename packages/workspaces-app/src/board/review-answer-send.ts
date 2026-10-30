/**
 * The one POST a review card's answer makes, and what a refusal says.
 *
 * An access card's Approve widens who is in, so the server refuses it until
 * the person has signed in within the last ten minutes (`confirm-required`,
 * `server/src/fresh-signin.ts`). Home and the task panel posted it with plain
 * `send`, so on 30 Oct the owner, signed in through Access that morning, read
 * "Posting the reply failed" on their phone and nothing said why. It now goes
 * through the same "Confirm it's you" ask the access page uses
 * (`access-writes.ts`); every other answer goes straight through `send`.
 */
import { approveRequest, sendAccessWrite } from './access-writes.ts';
import { send, showToast } from './board-actions.ts';

export interface AnswerReply {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null;
}

/**
 * Post one answer. `line` names the change an access Approve applies, for the
 * ask. Null when the person backed out of that ask; it has said so already.
 */
export async function postReviewAnswer(
  spec: { path: string; body: Record<string, unknown> },
  author: unknown,
  line: string,
): Promise<AnswerReply | null> {
  const { decision, access } = spec.body;
  if (decision === 'approve' && access !== undefined) {
    return sendAccessWrite(approveRequest(spec.path, access, line), send, showToast);
  }
  return send(spec.path, 'POST', { ...spec.body, author });
}

/** The server's own sentence for a refusal, or `fallback` when it wrote none. */
export function refusalMessage(reply: AnswerReply, fallback: string): string {
  const said = reply.data?.message;
  return typeof said === 'string' && said.trim() !== '' ? said : fallback;
}
