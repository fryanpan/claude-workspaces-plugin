/**
 * A push held for approval goes ahead only on the Push of a person who may
 * EDIT the board: its owner, or a member at edit access. A member whose
 * access is comment or view is on the board, can read the item and can
 * answer it, and their Push still sends nothing (`git-push/pusher.ts`).
 *
 * The members are real share members — on the board's audience, admitted by
 * redeeming its link, then narrowed with `setMemberRole` as the owner's
 * "Who has access" panel does. Each answers over loopback with their own
 * signed session cookie, through the real answer route, so the answer is
 * recorded as theirs and the refusal is the pusher's own check. The edit
 * member's Push is the positive control: same route, same board, it pushes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
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
  message?: string;
}

describe('who may approve a held push, by board access', () => {
  const VIEWER = 'viewer@harborlight.example';
  const COMMENTER = 'commenter@harborlight.example';
  const EDITOR = 'editor@harborlight.example';
  let w: PushWorld;
  let viewer: SignedInPerson;
  let commenter: SignedInPerson;
  let editor: SignedInPerson;
  let taskId: string;

  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const statusOf = async (id: string) =>
    (await (await w.onSocket(`/workspaces/${w.board}/git/pushes/${id}`)).json()) as Held;
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
  /** Answer Push as `who`, and confirm the route recorded it as theirs. */
  async function approveAs(who: SignedInPerson, branch: string) {
    const held = await ask(branch);
    const res = await answerAs(who, held);
    expect(res.status, await res.clone().text()).toBe(200);
    const item = w.h.tasks.listReviewItems(taskId).find((r) => r.id === held.reviewItemId);
    expect(item?.answer?.answeredBy?.id).toBe(who.user.id);
    return { held, after: await settled(held.id) };
  }

  beforeAll(async () => {
    w = await startPushWorld((board) => ({
      boards: { [board]: { repos: [{ repo: REPO, approval: true }] } },
    }));
    viewer = signedInPerson(w.h, w.dataDir, w.base, { email: VIEWER, name: 'Alice' });
    commenter = signedInPerson(w.h, w.dataDir, w.base, { email: COMMENTER, name: 'Bob' });
    editor = signedInPerson(w.h, w.dataDir, w.base, { email: EDITOR, name: 'Riverbend' });
    w.h.shareLinks.addToAudience(w.board, [VIEWER, COMMENTER, EDITOR], 'Saltmarsh');
    const link = w.h.shareLinks.create({ workspaceId: w.board, createdBy: 'Saltmarsh' });
    for (const email of [VIEWER, COMMENTER, EDITOR]) {
      expect(w.h.shareLinks.redeem(link.linkId, email)).toMatchObject({ ok: true });
    }
    expect(w.h.shareLinks.setMemberRole(w.board, VIEWER, 'member', 'view')).toBe(true);
    expect(w.h.shareLinks.setMemberRole(w.board, COMMENTER, 'member', 'comment')).toBe(true);
    expect(w.h.shareLinks.accessRoleOf(w.board, VIEWER)).toBe('view');
    expect(w.h.shareLinks.accessRoleOf(w.board, COMMENTER)).toBe('comment');
    expect(w.h.shareLinks.accessRoleOf(w.board, EDITOR)).toBe('edit');
    const res = await w.overTcp(
      `/workspaces/${w.board}/tasks`,
      json({ title: 'Agent can ship the Harborlight access-level branch', author: LEAD }),
    );
    taskId = ((await res.json()) as { task: Task }).task.id;
  });
  afterAll(async () => {
    await w.stop();
    resetOwnerIdentities();
  });

  it('pushes nothing when a view-only member chooses Push', async () => {
    const { after } = await approveAs(viewer, 'feature-viewer-approved');
    expect(after.state).toBe('refused');
    expect(after.message).toContain('cannot approve a push');
    expect(w.upstreamTip(REPO, 'feature-viewer-approved')).toBe('');
  });

  it('pushes nothing when a comment-only member chooses Push', async () => {
    const { after } = await approveAs(commenter, 'feature-commenter-approved');
    expect(after.state).toBe('refused');
    expect(after.message).toContain('cannot approve a push');
    expect(w.upstreamTip(REPO, 'feature-commenter-approved')).toBe('');
  });

  it('pushes when an edit member chooses Push', async () => {
    const { held, after } = await approveAs(editor, 'feature-editor-approved');
    expect(after.state).toBe('pushed');
    expect(w.upstreamTip(REPO, 'feature-editor-approved')).toBe(held.sha);
  });
});
