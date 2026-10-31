/**
 * Line 4: on a repo marked for approval, a lead's push waits for a person's
 * answer on a review item (`git-push/pusher.ts`).
 *
 * The lead asks over its board socket. The push is judged, a decision item
 * is filed on the task the lead named, and upstream is unchanged until a
 * person, proved by a signed session cookie sent same-origin through the
 * real answer route, chooses Push. An agent choosing Push (the lead trying
 * to approve its own push) and a person choosing Don't push both leave
 * upstream unchanged. The positive control is the person's Push.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Task } from '../src/tasks.ts';
import { type PushWorld, pushPath, startPushWorld } from './git-push-fixture.ts';
import { type SignedInPerson, signedInPerson } from './signed-in-person.ts';
import { waitFor } from './wait-for.ts';

const REPO = 'Harborlight/approvals';
const LEAD = { id: 'agent-harborlight-lead', name: 'Harborlight Lead', kind: 'agent' };

interface Held {
  id: string;
  state: string;
  taskId: string;
  reviewItemId: string;
  sha: string;
}

describe('a push to a repo marked for approval', () => {
  let w: PushWorld;
  let person: SignedInPerson;
  let taskId: string;

  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const answer = (held: Held, optionId: string, via: 'person' | 'lead' | 'agent') => {
    const path = `/workspaces/${w.board}/tasks/${held.taskId}/review-items/${held.reviewItemId}/answer`;
    const body = { text: optionId, answeredWith: optionId };
    if (via === 'person')
      return w.overTcp(path, json({ ...body, author: person.user }, person.headers));
    // The lead on its own socket, and an agent on this machine over loopback.
    return via === 'lead'
      ? w.onSocket(path, json({ ...body, author: LEAD }))
      : w.overTcp(path, json({ ...body, author: LEAD }));
  };
  const statusOf = async (id: string) =>
    (await (await w.onSocket(`/workspaces/${w.board}/git/pushes/${id}`)).json()) as Held;

  async function ask(branch: string): Promise<Held> {
    const res = await w.onSocket(pushPath(w.board, REPO, branch, taskId), {
      method: 'POST',
      body: w.leadBundle(REPO, branch),
    });
    const held = (await res.json()) as Held;
    expect(res.status, JSON.stringify(held)).toBe(202);
    expect(held.state).toBe('awaiting-approval');
    return held;
  }

  beforeAll(async () => {
    w = await startPushWorld((board) => ({
      boards: { [board]: { repos: [{ repo: REPO, approval: true }] } },
    }));
    person = signedInPerson(w.h, w.dataDir, w.base, { name: 'Alice' });
    const res = await w.overTcp(
      `/workspaces/${w.board}/tasks`,
      json({ title: 'Agent can ship the Harborlight approvals branch', author: LEAD }),
    );
    taskId = ((await res.json()) as { task: Task }).task.id;
  });
  afterAll(() => w.stop());

  it('refuses without a task to file the approval on', async () => {
    const res = await w.onSocket(pushPath(w.board, REPO, 'feature-no-task'), {
      method: 'POST',
      body: w.leadBundle(REPO, 'feature-no-task'),
    });
    expect(res.status).toBe(400);
    expect(w.upstreamTip(REPO, 'feature-no-task')).toBe('');
  });

  it('files a review item and pushes nothing until a person chooses Push', async () => {
    const held = await ask('feature-approved');
    const item = w.h.tasks.listReviewItems(taskId).find((r) => r.id === held.reviewItemId);
    expect(item?.review.step).toBe('push');
    expect(item?.review.options?.map((o) => o.id)).toEqual(['o-push', 'o-no-push']);
    expect(w.upstreamTip(REPO, 'feature-approved')).toBe('');

    const res = await answer(held, 'o-push', 'person');
    expect(res.status, await res.clone().text()).toBe(200);
    await waitFor(async () => (await statusOf(held.id)).state === 'pushed', {
      timeout: 4000,
      describe: 'the approved push lands',
    });
    expect(w.upstreamTip(REPO, 'feature-approved')).toBe(held.sha);
  });

  it('pushes nothing when the lead itself chooses Push', async () => {
    const held = await ask('feature-self-approved');
    // On its socket the lead cannot answer at all: the item stays open.
    expect((await answer(held, 'o-push', 'lead')).status).toBe(403);
    expect((await statusOf(held.id)).state).toBe('awaiting-approval');
    // An agent's answer over loopback is recorded, as the agent's: no push.
    const res = await answer(held, 'o-push', 'agent');
    expect(res.status, await res.clone().text()).toBe(200);
    await waitFor(async () => (await statusOf(held.id)).state !== 'awaiting-approval', {
      timeout: 4000,
      describe: 'the agent-answered push is settled',
    });
    const after = await statusOf(held.id);
    expect(after.state).toBe('refused');
    expect(w.upstreamTip(REPO, 'feature-self-approved')).toBe('');
  });

  it('pushes nothing when a person chooses Don’t push', async () => {
    const held = await ask('feature-rejected');
    const res = await answer(held, 'o-no-push', 'person');
    expect(res.status, await res.clone().text()).toBe(200);
    await waitFor(async () => (await statusOf(held.id)).state === 'rejected', {
      timeout: 4000,
      describe: 'the rejected push is settled',
    });
    expect(w.upstreamTip(REPO, 'feature-rejected')).toBe('');
  });
});
