/**
 * Who may approve a push that changes `.github/` (`git-push/pusher.ts`,
 * `git-push/policy.ts` `workflowApprovers`).
 *
 * A workflow runs with its repo's Actions secrets once it lands, so on a
 * repo the board's owner owns, only the owner's Push sends one: an editor
 * on the board, however trusted for other pushes, is refused. A repo whose
 * rule says `"workflowApprovers": "editors"` is an outside org's own repo,
 * holding its own secrets, and its editors still approve its workflow
 * changes.
 *
 * Every answer goes through the real answer route over loopback with the
 * answerer's own signed session cookie, so the refusal is the pusher's own
 * check. Each refusal is checked against upstream, which stays unchanged;
 * the owner's Push and the outside repo's editor Push are the positive
 * controls. That an editor still approves a push that leaves `.github/`
 * alone is `git-push-access-level.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { registerOwnerIdentity, resetOwnerIdentities } from '../src/actor-identity.ts';
import type { Task } from '../src/tasks.ts';
import { type PushWorld, pushPath, startPushWorld } from './git-push-fixture.ts';
import { type SignedInPerson, signedInPerson } from './signed-in-person.ts';
import { waitFor } from './wait-for.ts';

/** A repo with no `workflowApprovers` field: the owner's, by default. */
const OWNED = 'Harborlight/notes';
/** An outside org's own repo, whose rule lets its editors approve. */
const OUTSIDE = 'Riverbend/notes';
const LEAD = { id: 'agent-harborlight-lead', name: 'Harborlight Lead', kind: 'agent' };
// A push is several git subprocesses; on a loaded runner they take seconds.
const SETTLE_MS = 20_000;
const WORKFLOW = 'on: push\njobs: {}\n';

interface Held {
  id: string;
  state: string;
  taskId: string;
  reviewItemId: string;
  sha: string;
  message?: string;
}

describe('who may approve a push that changes .github/', () => {
  const EDITOR = 'editor@harborlight.example';
  let w: PushWorld;
  let owner: SignedInPerson;
  let editor: SignedInPerson;
  let taskId: string;

  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const statusOf = async (id: string) =>
    (await (await w.onSocket(`/workspaces/${w.board}/git/pushes/${id}`)).json()) as Held;
  async function askWorkflow(repo: string, branch: string): Promise<Held> {
    const body = w.leadBundle(repo, branch, {
      commits: [{ '.github/workflows/ci.yml': WORKFLOW }],
    });
    const res = await w.onSocket(pushPath(w.board, repo, branch, taskId), {
      method: 'POST',
      body,
    });
    const held = (await res.json()) as Held;
    expect(res.status, JSON.stringify(held)).toBe(202);
    return held;
  }
  /** Answer Push as `who`, confirm the route recorded it as theirs, and wait for the verdict. */
  async function approveAs(who: SignedInPerson, held: Held): Promise<Held> {
    const res = await w.overTcp(
      `/workspaces/${w.board}/tasks/${held.taskId}/review-items/${held.reviewItemId}/answer`,
      json({ text: 'o-push', answeredWith: 'o-push', author: who.user }, who.headers),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const item = w.h.tasks.listReviewItems(taskId).find((r) => r.id === held.reviewItemId);
    expect(item?.answer?.answeredBy?.id).toBe(who.user.id);
    await waitFor(async () => (await statusOf(held.id)).state !== 'awaiting-approval', {
      timeout: SETTLE_MS,
      describe: 'the push is settled',
    });
    return statusOf(held.id);
  }

  beforeAll(async () => {
    w = await startPushWorld((board) => ({
      boards: {
        [board]: {
          repos: [{ repo: OWNED }, { repo: OUTSIDE, workflowApprovers: 'editors' }],
        },
      },
    }));
    owner = signedInPerson(w.h, w.dataDir, w.base, { name: 'Alice' });
    registerOwnerIdentity(owner.user.id);
    editor = signedInPerson(w.h, w.dataDir, w.base, { email: EDITOR, name: 'Bob' });
    w.h.shareLinks.addToAudience(w.board, [EDITOR], 'Alice');
    const link = w.h.shareLinks.create({ workspaceId: w.board, createdBy: 'Alice' });
    expect(w.h.shareLinks.redeem(link.linkId, EDITOR)).toMatchObject({ ok: true });
    expect(w.h.shareLinks.accessRoleOf(w.board, EDITOR)).toBe('edit');
    const res = await w.overTcp(
      `/workspaces/${w.board}/tasks`,
      json({ title: 'Agent can ship Harborlight workflow branches', author: LEAD }),
    );
    taskId = ((await res.json()) as { task: Task }).task.id;
  });
  afterAll(async () => {
    await w.stop();
    resetOwnerIdentities();
  });

  it("files a workflow push to the owner's repo as owner-only", async () => {
    const held = await askWorkflow(OWNED, 'feature-wf-filed');
    const item = w.h.tasks.listReviewItems(taskId).find((r) => r.id === held.reviewItemId);
    expect(item?.review.ownerOnly).toBe(true);
  });

  it("pushes nothing when an editor approves a workflow change to the owner's repo", async () => {
    const after = await approveAs(editor, await askWorkflow(OWNED, 'feature-wf-editor'));
    expect(after.state).toBe('refused');
    expect(after.message).toContain("only the board's owner");
    expect(w.upstreamTip(OWNED, 'feature-wf-editor')).toBe('');
  });

  it("pushes when the owner approves a workflow change to the owner's repo", async () => {
    const held = await askWorkflow(OWNED, 'feature-wf-owner');
    expect(await approveAs(owner, held)).toMatchObject({ state: 'pushed' });
    expect(w.upstreamTip(OWNED, 'feature-wf-owner')).toBe(held.sha);
  });

  it("pushes when an editor approves a workflow change to an outside org's repo that lets editors approve", async () => {
    const held = await askWorkflow(OUTSIDE, 'feature-wf-outside');
    const item = w.h.tasks.listReviewItems(taskId).find((r) => r.id === held.reviewItemId);
    expect(item?.review.ownerOnly).not.toBe(true);
    expect(await approveAs(editor, held)).toMatchObject({ state: 'pushed' });
    expect(w.upstreamTip(OUTSIDE, 'feature-wf-outside')).toBe(held.sha);
  });
});
