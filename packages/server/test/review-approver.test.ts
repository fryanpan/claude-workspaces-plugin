/**
 * A person's answer records WHO approved, and the agent is handed the line
 * to quote.
 *
 * Bryan, 29 Oct: any member's answer approves, so the record names the
 * member. The address comes from the request's own proof — the Access email
 * on the share hostname here — never from the body, and an agent's answer
 * records no approver at all. Driven through the real route table, so the
 * proof is the one the admission gate resolved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { TaskStoreEvent } from '../src/tasks.ts';
import {
  AGENT,
  SHARE_HOST,
  type ShareProofServer,
  post,
  readJson,
  startShareProofServer,
} from './share-proof-harness.ts';

const MEMBER = 'alice@harborlight.example';

interface Answer {
  text: string;
  by: string;
  answeredBy?: { id: string; email?: string };
}

describe('the approver record on a review-item answer', () => {
  let s: ShareProofServer;
  let taskId: string;
  const events: TaskStoreEvent[] = [];

  const fileItem = async (headline: string): Promise<string> =>
    (
      await readJson<{ item: { id: string } }>(
        await s.local(
          `${s.scope}/tasks/${taskId}/review-items`,
          post({
            review: {
              shape: 'decision',
              headline,
              detail: 'The nightly pass reads the index once. A smaller cache reads it twice.',
              options: [
                { id: 'o-yes', label: 'Go ahead' },
                { id: 'o-no', label: 'Leave it' },
              ],
            },
            author: AGENT,
          }),
        ),
      )
    ).item.id;

  const answerOf = async (itemId: string): Promise<Answer | undefined> => {
    const body = await readJson<{
      tasks: Array<{ id: string; reviews?: Array<{ id: string; answer?: Answer }> }>;
    }>(await s.local(`${s.scope}/tasks?format=json`));
    return body.tasks.find((t) => t.id === taskId)?.reviews?.find((r) => r.id === itemId)?.answer;
  };

  beforeAll(async () => {
    s = await startShareProofServer('Harborlight relay');
    s.handle.shareLinks.addToAudience(s.board, [MEMBER], 'Bryan');
    expect(await s.join(MEMBER)).toBe(302);
    taskId = (
      await readJson<{ task: { id: string } }>(
        await s.local(
          `${s.scope}/tasks`,
          post({
            title: 'Rebuild the Harborlight index nightly',
            body: 'Agent can rebuild the index so that search stays fresh.',
            author: AGENT,
          }),
        ),
      )
    ).task.id;
    s.handle.tasks.onEvent((e) => events.push(e));
  });

  afterAll(async () => {
    await s.stop();
  });

  it("records a member's proven address as the approver, and hands the agent the line", async () => {
    const itemId = await fileItem('Halve the nightly cache?');
    const press = post({
      text: 'Go ahead',
      answeredWith: 'o-yes',
      // A body may claim any address; the record must not read it.
      author: { id: 'someone-else', name: 'Alice', email: 'bob@saltmarsh.example' },
    });
    const res = await s.visitor(
      MEMBER,
      `${s.scope}/tasks/${taskId}/review-items/${itemId}/answer`,
      {
        ...press,
        // Pressed on the share page itself, through the tunnel, as a browser
        // marks it: a person's answer counts only from that person's own page.
        headers: {
          ...(press.headers as Record<string, string>),
          'x-forwarded-proto': 'https',
          origin: `https://${SHARE_HOST}`,
          'sec-fetch-site': 'same-origin',
        },
      },
    );
    expect(res.status).toBe(200);
    const answer = await answerOf(itemId);
    expect(answer?.answeredBy?.email).toBe(MEMBER);
    expect(answer?.answeredBy?.id).toMatch(/^user-/);
    const answered = events.find(
      (e) => e.type === 'decision.answered' && e.reviewItemId === itemId,
    );
    expect(answered?.type === 'decision.answered' && answered.approvalLine).toContain(
      `(${MEMBER}) on the board`,
    );
  });

  it("records no approver for an agent's answer, and gives no line", async () => {
    const itemId = await fileItem('Move the nightly run an hour earlier?');
    const res = await s.local(
      `${s.scope}/tasks/${taskId}/review-items/${itemId}/answer`,
      post({ text: 'Go ahead', answeredWith: 'o-yes', author: AGENT }),
    );
    expect(res.status).toBe(200);
    expect((await answerOf(itemId))?.answeredBy).toBeUndefined();
    const answered = events.find(
      (e) => e.type === 'decision.answered' && e.reviewItemId === itemId,
    );
    expect(answered).toBeDefined();
    expect(answered?.type === 'decision.answered' && answered.approvalLine).toBeFalsy();
  });
});
