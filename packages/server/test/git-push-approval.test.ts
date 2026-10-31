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
import { registerOwnerIdentity, resetOwnerIdentities } from '../src/actor-identity.ts';
import type { Task } from '../src/tasks.ts';
import { type PushWorld, pushPath, startPushWorld } from './git-push-fixture.ts';
import { type SignedInPerson, signedInPerson } from './signed-in-person.ts';
import { waitFor } from './wait-for.ts';

const REPO = 'Harborlight/approvals';
const LEAD = { id: 'agent-harborlight-lead', name: 'Harborlight Lead', kind: 'agent' };
// A push is several git subprocesses; on a loaded runner they take seconds.
const SETTLE_MS = 20_000;

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
  afterAll(async () => {
    await w.stop();
    resetOwnerIdentities();
  });

  it('refuses without a task to file the approval on', async () => {
    const res = await w.onSocket(pushPath(w.board, REPO, 'feature-no-task'), {
      method: 'POST',
      body: w.leadBundle(REPO, 'feature-no-task'),
    });
    expect(res.status).toBe(400);
    expect(w.upstreamTip(REPO, 'feature-no-task')).toBe('');
  });

  // Before Alice is the board's owner: a signed-in person who is on no
  // board's list. Her Push is a person's, and still approves nothing here.
  it('pushes nothing when a signed-in person who is not on the board chooses Push', async () => {
    const held = await ask('feature-stranger');
    const res = await answer(held, 'o-push', 'person');
    expect(res.status, await res.clone().text()).toBe(200);
    await waitFor(async () => (await statusOf(held.id)).state !== 'awaiting-approval', {
      timeout: SETTLE_MS,
      describe: 'the non-member push is settled',
    });
    const after = (await statusOf(held.id)) as Held & { message: string };
    expect(after.state).toBe('refused');
    expect(after.message).toContain('not a member');
    expect(w.upstreamTip(REPO, 'feature-stranger')).toBe('');
    registerOwnerIdentity(person.user.id);
  });

  it('files a review item and pushes nothing until a person chooses Push', async () => {
    const held = await ask('feature-approved');
    const item = w.h.tasks.listReviewItems(taskId).find((r) => r.id === held.reviewItemId);
    expect(item?.review.step).toBe('push');
    expect(item?.review.options?.map((o) => o.id)).toEqual(['o-push', 'o-no-push']);
    expect(w.upstreamTip(REPO, 'feature-approved')).toBe('');

    const res = await answer(held, 'o-push', 'person');
    expect(res.status, await res.clone().text()).toBe(200);
    await waitFor(async () => (await statusOf(held.id)).state !== 'awaiting-approval', {
      timeout: SETTLE_MS,
      describe: 'the approved push is settled',
    });
    expect(await statusOf(held.id)).toMatchObject({ state: 'pushed' });
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
      timeout: SETTLE_MS,
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
      timeout: SETTLE_MS,
      describe: 'the rejected push is settled',
    });
    expect(w.upstreamTip(REPO, 'feature-rejected')).toBe('');
  });
});

/**
 * A board that reserves pushes for its owner (`requireOwnerFor: ['push']`).
 *
 * The member is a real share member: on the board's audience and admitted by
 * redeeming the board's link, as `/s/<linkId>` does after Access signs them
 * in. Their answer goes over loopback with their own signed session cookie,
 * where the answer route's owner-only gate lets the machine's operator
 * through, so the route records the answer as the member's. The refusal
 * shown here is the pusher's own check. Over the share host the route's
 * owner-only gate refuses the member before that (`board-roles.test.ts`).
 */
describe('a push on a board that reserves pushes for its owner', () => {
  const MEMBER = 'keeper@harborlight.example';
  let w: PushWorld;
  let owner: SignedInPerson;
  let member: SignedInPerson;
  let taskId: string;

  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const statusOf = async (id: string) =>
    (await (await w.onSocket(`/workspaces/${w.board}/git/pushes/${id}`)).json()) as Held & {
      message?: string;
    };
  const answerAs = (who: SignedInPerson, held: Held) =>
    w.overTcp(
      `/workspaces/${w.board}/tasks/${held.taskId}/review-items/${held.reviewItemId}/answer`,
      json({ text: 'o-push', answeredWith: 'o-push', author: who.user }, who.headers),
    );
  async function ask(branch: string): Promise<Held> {
    const res = await w.onSocket(pushPath(w.board, REPO, branch, taskId), {
      method: 'POST',
      body: w.leadBundle(REPO, branch),
    });
    const held = (await res.json()) as Held;
    expect(res.status, JSON.stringify(held)).toBe(202);
    return held;
  }
  async function settled(id: string) {
    await waitFor(async () => (await statusOf(id)).state !== 'awaiting-approval', {
      timeout: SETTLE_MS,
      describe: 'the push is settled',
    });
    return statusOf(id);
  }

  beforeAll(async () => {
    w = await startPushWorld((board) => ({
      boards: { [board]: { repos: [{ repo: REPO, approval: true }] } },
    }));
    owner = signedInPerson(w.h, w.dataDir, w.base, { name: 'Alice' });
    registerOwnerIdentity(owner.user.id);
    member = signedInPerson(w.h, w.dataDir, w.base, { email: MEMBER, name: 'Bob' });
    w.h.shareLinks.addToAudience(w.board, [MEMBER], 'Alice');
    const link = w.h.shareLinks.create({ workspaceId: w.board, createdBy: 'Alice' });
    expect(w.h.shareLinks.redeem(link.linkId, MEMBER)).toMatchObject({ ok: true });
    expect(w.h.shareLinks.roleOf(w.board, MEMBER)).toBe('member');
    expect(w.h.tasks.setRequireOwnerFor(w.board, ['push'])).toMatchObject({ ok: true });
    const res = await w.overTcp(
      `/workspaces/${w.board}/tasks`,
      json({ title: 'Agent can ship the Harborlight owner-only branch', author: LEAD }),
    );
    taskId = ((await res.json()) as { task: Task }).task.id;
  });
  afterAll(async () => {
    await w.stop();
    resetOwnerIdentities();
  });

  it('files the push item owner-only', async () => {
    const held = await ask('feature-owner-only');
    const item = w.h.tasks.listReviewItems(taskId).find((r) => r.id === held.reviewItemId);
    expect(item?.review.ownerOnly).toBe(true);
    expect(item?.review.step).toBe('push');
  });

  it('pushes nothing when a share member chooses Push', async () => {
    const held = await ask('feature-member-approved');
    const res = await answerAs(member, held);
    expect(res.status, await res.clone().text()).toBe(200);
    const item = w.h.tasks.listReviewItems(taskId).find((r) => r.id === held.reviewItemId);
    expect(item?.answer?.answeredBy?.id).toBe(member.user.id);
    const after = await settled(held.id);
    expect(after.state).toBe('refused');
    expect(after.message).toContain('reserves pushes');
    expect(w.upstreamTip(REPO, 'feature-member-approved')).toBe('');
  });

  it('pushes when the owner chooses Push', async () => {
    const held = await ask('feature-owner-approved');
    const res = await answerAs(owner, held);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await settled(held.id)).toMatchObject({ state: 'pushed' });
    expect(w.upstreamTip(REPO, 'feature-owner-approved')).toBe(held.sha);
  });
});
