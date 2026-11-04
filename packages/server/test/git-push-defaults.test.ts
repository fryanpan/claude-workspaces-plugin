/**
 * Which pushes wait for a person without anyone asking for it
 * (`git-push/policy.ts`, `git-push/pusher.ts`).
 *
 * Approval is opt-in: a repo listed with no `approval` flag pushes at once.
 * Whatever the flag, a push that adds, changes or deletes anything under
 * `.github/` waits, because a workflow runs with the repo's Actions secrets
 * the moment it lands on any branch, and GitHub cannot stop a deploy key
 * from writing one on a public repo. Each refusal is checked against
 * upstream, which stays unchanged; the positive controls are a push with no
 * `.github/` change, which lands at once, and a person's Push on a held
 * workflow change.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { registerOwnerIdentity, resetOwnerIdentities } from '../src/actor-identity.ts';
import type { Task } from '../src/tasks.ts';
import { type PushWorld, pushPath, startPushWorld } from './git-push-fixture.ts';
import { type SignedInPerson, signedInPerson } from './signed-in-person.ts';
import { waitFor } from './wait-for.ts';

const OPTED_IN = 'Harborlight/approvals';
const DEFAULTED = 'Harborlight/notes';
const LEAD = { id: 'agent-harborlight-lead', name: 'Harborlight Lead', kind: 'agent' };
const SETTLE_MS = 20_000;
const WORKFLOW = 'on: push\njobs: {}\n';

interface Pushed {
  id: string;
  state: string;
  error?: string;
  sha: string;
  taskId: string;
  reviewItemId: string;
}

describe('which pushes wait for a person when nobody asked', () => {
  let w: PushWorld;
  let person: SignedInPerson;
  let taskId: string;

  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const send = async (repo: string, branch: string, body: ArrayBuffer, task?: string) => {
    const res = await w.onSocket(pushPath(w.board, repo, branch, task), { method: 'POST', body });
    return { status: res.status, body: (await res.json()) as Pushed };
  };
  const statusOf = async (id: string) =>
    (await (await w.onSocket(`/workspaces/${w.board}/git/pushes/${id}`)).json()) as Pushed;

  beforeAll(async () => {
    w = await startPushWorld((board) => ({
      boards: {
        [board]: { repos: [{ repo: OPTED_IN, approval: true }, { repo: DEFAULTED }] },
      },
    }));
    person = signedInPerson(w.h, w.dataDir, w.base, { name: 'Alice' });
    registerOwnerIdentity(person.user.id);
    const res = await w.overTcp(
      `/workspaces/${w.board}/tasks`,
      json({ title: 'Agent can ship Harborlight branches', author: LEAD }),
    );
    taskId = ((await res.json()) as { task: Task }).task.id;
  });
  afterAll(async () => {
    await w.stop();
    resetOwnerIdentities();
  });

  it('pushes a repo listed with no approval flag at once when it leaves .github/ alone', async () => {
    const r = await send(DEFAULTED, 'feature-plain', w.leadBundle(DEFAULTED, 'feature-plain'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.state).toBe('pushed');
    expect(w.upstreamTip(DEFAULTED, 'feature-plain')).toBe(r.body.sha);
  });

  it('holds every push to a repo that asks for approval', async () => {
    const bare = await send(OPTED_IN, 'feature-opted', w.leadBundle(OPTED_IN, 'feature-opted'));
    expect(bare.status, JSON.stringify(bare.body)).toBe(400);
    expect(bare.body.error).toBe('task-required');
    const held = await send(
      OPTED_IN,
      'feature-opted',
      w.leadBundle(OPTED_IN, 'feature-opted'),
      taskId,
    );
    expect(held.status, JSON.stringify(held.body)).toBe(202);
    expect(held.body.state).toBe('awaiting-approval');
    expect(w.upstreamTip(OPTED_IN, 'feature-opted')).toBe('');
  });

  it('refuses a workflow change with no task to ask on', async () => {
    const body = w.leadBundle(DEFAULTED, 'feature-wf-bare', {
      commits: [{ '.github/workflows/ci.yml': WORKFLOW }],
    });
    const r = await send(DEFAULTED, 'feature-wf-bare', body);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error).toBe('task-required');
    expect(w.upstreamTip(DEFAULTED, 'feature-wf-bare')).toBe('');
  });

  it('holds a workflow added and removed again before the tip', async () => {
    const body = w.leadBundle(DEFAULTED, 'feature-wf-gone', {
      commits: [{ '.github/workflows/leak.yml': WORKFLOW }, { '.github/workflows/leak.yml': null }],
    });
    const r = await send(DEFAULTED, 'feature-wf-gone', body, taskId);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(w.upstreamTip(DEFAULTED, 'feature-wf-gone')).toBe('');
  });

  it('holds a workflow change until a person chooses Push', async () => {
    const body = w.leadBundle(DEFAULTED, 'feature-wf', {
      commits: [{ '.github/workflows/ci.yml': WORKFLOW }],
    });
    const r = await send(DEFAULTED, 'feature-wf', body, taskId);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(w.upstreamTip(DEFAULTED, 'feature-wf')).toBe('');
    const item = w.h.tasks.listReviewItems(taskId).find((i) => i.id === r.body.reviewItemId);
    expect(item?.review.detail).toContain('.github/workflows/ci.yml');

    const path = `/workspaces/${w.board}/tasks/${taskId}/review-items/${r.body.reviewItemId}/answer`;
    const answered = await w.overTcp(
      path,
      json({ text: 'o-push', answeredWith: 'o-push', author: person.user }, person.headers),
    );
    expect(answered.status, await answered.clone().text()).toBe(200);
    await waitFor(async () => (await statusOf(r.body.id)).state !== 'awaiting-approval', {
      timeout: SETTLE_MS,
      describe: 'the approved .github/ push is settled',
    });
    expect(await statusOf(r.body.id)).toMatchObject({ state: 'pushed' });
    expect(w.upstreamTip(DEFAULTED, 'feature-wf')).toBe(r.body.sha);
  });
});
