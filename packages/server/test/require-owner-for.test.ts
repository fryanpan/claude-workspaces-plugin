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
      post({ requireOwnerFor: ['push', 'jira'], author: { id: 'x', name: 'Owner' } }, 'PUT'),
    );
    expect(res.status).toBe(200);
    expect((await settings()).requireOwnerFor).toEqual(['push', 'jira']);

    const reserved = await file('push');
    expect(reserved.review.ownerOnly).toBe(true);
    const open = await file('tag');
    expect(open.review.ownerOnly).toBeUndefined();

    // A member may not answer the reserved one; they may answer the other.
    const answer = (id: string) =>
      s.visitor(
        MEMBER,
        `${s.scope}/tasks/${taskId}/review-items/${id}/answer`,
        post({ text: 'Go ahead', answeredWith: 'o-yes', author: { id: 'x', name: 'Alice' } }),
      );
    expect((await answer(reserved.id)).status).toBe(403);
    expect((await answer(open.id)).status).toBe(200);
  });
});
