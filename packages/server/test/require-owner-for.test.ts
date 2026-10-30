/**
 * A board names the steps only its owner may approve, and an item naming one
 * is filed owner-only whatever its filer sent (Bryan, 29 Oct).
 *
 * Only the owner's own browser changes the list: an agent that could drop
 * `push` from it could then ask any member to approve a push.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  AGENT,
  SHARE_HOST,
  type ShareProofServer,
  post,
  readJson,
  startShareProofServer,
} from './share-proof-harness.ts';

const MEMBER = 'alice@harborlight.example';

describe('requireOwnerFor', () => {
  let s: ShareProofServer;
  let taskId: string;

  const settings = async (): Promise<{ requireOwnerFor: string[] }> =>
    readJson(await s.local(`${s.scope}/settings`));

  const file = async (step: string): Promise<{ id: string; review: { ownerOnly?: true } }> =>
    (
      await readJson<{ item: { id: string; review: { ownerOnly?: true } } }>(
        await s.local(
          `${s.scope}/tasks/${taskId}/review-items`,
          post({
            review: {
              shape: 'decision',
              headline: `May I ${step} the rebuilt Harborlight branch?`,
              detail: 'The branch is rebuilt and its tests pass. The tag moves with it.',
              options: [
                { id: 'o-yes', label: 'Go ahead' },
                { id: 'o-no', label: 'Wait' },
              ],
              step,
            },
            author: AGENT,
          }),
        ),
      )
    ).item;

  beforeAll(async () => {
    s = await startShareProofServer('Harborlight release');
    s.handle.shareLinks.addToAudience(s.board, [MEMBER], 'Bryan');
    expect(await s.join(MEMBER)).toBe(302);
    taskId = (
      await readJson<{ task: { id: string } }>(
        await s.local(
          `${s.scope}/tasks`,
          post({
            title: 'Retag the Harborlight release branch',
            body: 'Agent can push the rebuilt branch so that the release tag points at it.',
            author: AGENT,
          }),
        ),
      )
    ).task.id;
  });

  afterAll(async () => {
    await s.stop();
  });

  it("refuses an agent's change to the list, and the list does not move", async () => {
    const res = await s.local(
      `${s.scope}/settings`,
      post({ requireOwnerFor: ['push'], author: AGENT }, 'PUT'),
    );
    expect(res.status).toBe(403);
    expect((await settings()).requireOwnerFor).toEqual([]);
  });

  it("takes the owner's list from their own page, and files a named step owner-only", async () => {
    const res = await s.owner(
      `${s.scope}/settings`,
      post({ requireOwnerFor: ['push', 'jira'], author: { id: 'x', name: 'Alice' } }, 'PUT'),
    );
    expect(res.status).toBe(200);
    expect((await settings()).requireOwnerFor).toEqual(['push', 'jira']);

    const reserved = await file('push');
    expect(reserved.review.ownerOnly).toBe(true);
    const open = await file('tag');
    expect(open.review.ownerOnly).toBeUndefined();

    // A member may not answer the reserved one; they may answer the other.
    // Both from the share page itself, as her browser sends a press; the
    // visitor carries no x-forwarded-proto, so the server reads it as http.
    const answer = (id: string) => {
      const init = post({
        text: 'Go ahead',
        answeredWith: 'o-yes',
        author: { id: 'x', name: 'Alice' },
      });
      return s.visitor(MEMBER, `${s.scope}/tasks/${taskId}/review-items/${id}/answer`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          origin: `http://${SHARE_HOST}`,
          'sec-fetch-site': 'same-origin',
        },
      });
    };
    const refused = await answer(reserved.id);
    expect(refused.status).toBe(403);
    // Refused for the step being the owner's, not for a missing proof.
    expect(((await refused.json()) as { error: string }).error).not.toBe('person-proof-required');
    expect((await answer(open.id)).status).toBe(200);
  });
});
