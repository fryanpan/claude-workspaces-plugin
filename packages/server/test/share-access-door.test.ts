/**
 * Only the owner changes who is in (Bryan, 29 Oct), end to end through the
 * real admission gate.
 *
 * An agent's call that would let somebody new in — an address or domain the
 * board does not name, a promotion, a link that makes Owners — files an
 * access card and changes nothing. The owner's own Approve in the browser
 * applies exactly the change the card showed. A removal or a demotion applies
 * at once, from an agent too, because taking access away never waits.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  AGENT,
  type ShareProofServer,
  post,
  readJson,
  startShareProofServer,
} from './share-proof-harness.ts';

const ALICE = 'alice@harborlight.example';
const BOB = 'bob@riverbend.example';
const NEWCOMER = 'ops@saltmarsh.example';

interface Proposal {
  proposed: true;
  taskId: string;
  reviewItemId: string;
  message: string;
}

describe('access changes an agent proposes and the owner approves', () => {
  let s: ShareProofServer;
  let taskId: string;

  const audience = async (): Promise<string[]> =>
    (
      await readJson<{ audience: Array<{ match: string }> }>(await s.local(`${s.scope}/members`))
    ).audience.map((e) => e.match);
  const roster = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      (
        await readJson<{ members: Array<{ email: string; role: string }> }>(
          await s.local(`${s.scope}/members`),
        )
      ).members.map((m) => [m.email, m.role]),
    );
  const item = async (id: string) => {
    const body = await readJson<{
      tasks: Array<{
        id: string;
        reviews?: Array<{
          id: string;
          access?: unknown;
          review: { ownerOnly?: true; headline: string };
          answer?: { text: string; answeredBy?: { email?: string } };
        }>;
      }>;
    }>(await s.local(`${s.scope}/tasks?format=json`));
    return body.tasks.find((t) => t.id === taskId)?.reviews?.find((r) => r.id === id);
  };
  const accessPath = (id: string) => `${s.scope}/tasks/${taskId}/review-items/${id}/access`;

  beforeAll(async () => {
    s = await startShareProofServer('Harborlight release');
    s.handle.shareLinks.addToAudience(s.board, [ALICE, BOB], 'Bryan');
    expect(await s.join(ALICE)).toBe(302);
    expect(await s.join(BOB)).toBe(302);
    taskId = (
      await readJson<{ task: { id: string } }>(
        await s.local(
          `${s.scope}/tasks`,
          post({
            title: 'Bring the Saltmarsh ops team onto the release board',
            body: 'Agent can invite the ops team so that they can review the release notes.',
            author: AGENT,
          }),
        ),
      )
    ).task.id;
  });

  afterAll(async () => {
    await s.stop();
  });

  it('files a proposal for an agent add without proof, and changes nothing', async () => {
    const before = await audience();
    const noTask = await s.local(`${s.scope}/audience`, post({ add: [NEWCOMER], author: AGENT }));
    expect(noTask.status).toBe(400);
    expect(((await noTask.json()) as { error: string }).error).toBe('task-required');

    const res = await s.local(
      `${s.scope}/audience`,
      post({ add: [NEWCOMER], taskId, why: 'They review the release notes.', author: AGENT }),
    );
    expect(res.status).toBe(202);
    const proposal = (await res.json()) as Proposal;
    expect(proposal.proposed).toBe(true);
    expect(await audience()).toEqual(before);
    const filed = await item(proposal.reviewItemId);
    expect(filed?.review.ownerOnly).toBe(true);
    expect(filed?.review.headline).toBe(`Lets ${NEWCOMER} sign in to this board.`);
    expect(filed?.access).toEqual({
      op: 'add-audience',
      workspaceId: s.board,
      entries: [NEWCOMER],
    });
    // The newcomer still cannot get in through a link.
    expect(await s.join(NEWCOMER)).not.toBe(302);
  });

  it('refuses the card to an agent, a member, words, a reworded echo and another page', async () => {
    const res = await s.local(
      `${s.scope}/audience`,
      post({ add: ['@saltmarsh.example'], taskId, why: 'The whole team.', author: AGENT }),
    );
    const { reviewItemId } = (await res.json()) as Proposal;
    const change = (await item(reviewItemId))?.access;
    const approve = { decision: 'approve', access: change };

    expect((await s.local(accessPath(reviewItemId), post(approve))).status).toBe(403);
    expect((await s.visitor(ALICE, accessPath(reviewItemId), post(approve))).status).toBe(403);
    const typed = await s.local(
      `${s.scope}/tasks/${taskId}/review-items/${reviewItemId}/answer`,
      post({ text: 'Approve', answeredWith: 'o-approve', author: AGENT }),
    );
    expect(typed.status).toBe(400);
    const otherPage = await s.owner(accessPath(reviewItemId), post(approve), {
      'sec-fetch-site': 'same-site',
      origin: 'http://localhost:5173',
    });
    expect(otherPage.status).toBe(403);
    const reworded = await s.owner(
      accessPath(reviewItemId),
      post({ decision: 'approve', access: { ...(change as object), entries: ['@evil.example'] } }),
    );
    expect(reworded.status).toBe(409);
    expect(await audience()).not.toContain('@saltmarsh.example');
    expect((await item(reviewItemId))?.answer).toBeUndefined();
  });

  it("applies exactly the shown change on the owner's Approve, and records the owner as approver", async () => {
    const res = await s.local(
      `${s.scope}/audience`,
      post({ add: [NEWCOMER], taskId, why: 'They review the notes.', author: AGENT }),
    );
    const { reviewItemId } = (await res.json()) as Proposal;
    const change = (await item(reviewItemId))?.access;
    const approved = await s.owner(
      accessPath(reviewItemId),
      post({ decision: 'approve', access: change }),
    );
    expect(approved.status).toBe(200);
    expect(await audience()).toContain(NEWCOMER);
    const answered = await item(reviewItemId);
    expect(answered?.answer?.text).toContain('Approved');
    expect(answered?.answer?.answeredBy?.email).toBe('owner@harborlight.test');
    expect(await s.join(NEWCOMER)).toBe(302);
    // Approving twice applies nothing twice.
    const again = await s.owner(
      accessPath(reviewItemId),
      post({ decision: 'approve', access: change }),
    );
    expect(again.status).toBe(409);
  });

  it('records a Reject and changes nothing', async () => {
    const res = await s.local(
      `${s.scope}/audience`,
      post({ add: ['carol@riverbend.example'], taskId, why: 'Copy editor.', author: AGENT }),
    );
    const { reviewItemId } = (await res.json()) as Proposal;
    const change = (await item(reviewItemId))?.access;
    const rejected = await s.owner(
      accessPath(reviewItemId),
      post({ decision: 'reject', access: change }),
    );
    expect(rejected.status).toBe(200);
    expect(await audience()).not.toContain('carol@riverbend.example');
    expect((await item(reviewItemId))?.answer?.text).toContain('Rejected');
  });

  it("turns an agent's promotion into a proposal, and its demotion and removal apply at once", async () => {
    const promote = await s.local(
      `${s.scope}/members/${encodeURIComponent(BOB)}/role`,
      post({ role: 'owner', taskId, why: 'Bob signs off releases.', author: AGENT }),
    );
    expect(promote.status).toBe(202);
    expect((await roster())[BOB]).toBe('member');
    const { reviewItemId } = (await promote.json()) as Proposal;
    const change = (await item(reviewItemId))?.access;
    expect(change).toEqual({
      op: 'set-role',
      workspaceId: s.board,
      email: BOB,
      role: 'owner',
      before: 'member',
    });
    expect(
      (await s.owner(accessPath(reviewItemId), post({ decision: 'approve', access: change })))
        .status,
    ).toBe(200);
    expect((await roster())[BOB]).toBe('owner');

    const demote = await s.local(
      `${s.scope}/members/${encodeURIComponent(BOB)}/role`,
      post({ role: 'member', author: AGENT }),
    );
    expect(demote.status).toBe(200);
    expect((await roster())[BOB]).toBe('member');

    const removed = await s.local(`${s.scope}/members/${encodeURIComponent(BOB)}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    expect((await roster())[BOB]).toBeUndefined();
    expect((await s.visitor(BOB, `${s.scope}/members`)).status).not.toBe(200);
  });

  it("refuses an invited Owner's change to who is in", async () => {
    // Promote Alice straight in the store, the way a pre-upgrade registry had her.
    s.handle.shareLinks.setMemberRole(s.board, ALICE, 'owner');
    const evict = await s.visitor(ALICE, `${s.scope}/members/${encodeURIComponent(NEWCOMER)}`, {
      method: 'DELETE',
    });
    expect(evict.status).toBe(403);
    const widen = await s.visitor(ALICE, `${s.scope}/audience`, post({ add: ['@evil.example'] }));
    expect(widen.status).toBe(403);
    s.handle.shareLinks.setMemberRole(s.board, ALICE, 'member');
  });

  it('mints a link for people the board names at once, and proposes one that names somebody new', async () => {
    const named = await s.local(
      '/api/share/workspace',
      post({ workspaceId: s.board, allowDomains: [ALICE] }),
    );
    expect(named.status).toBe(200);
    expect(((await named.json()) as { url: string }).url).toContain('/s/');

    const linksBefore = s.handle.shareLinks.list().length;
    const wider = await s.local(
      '/api/share/workspace',
      post({
        workspaceId: s.board,
        allowDomains: ['@riverbend.example'],
        taskId,
        why: 'The Riverbend reviewers.',
        createdBy: 'Riverbend Bot',
      }),
    );
    expect(wider.status).toBe(202);
    expect(s.handle.shareLinks.list().length).toBe(linksBefore);
    const owners = await s.local(
      '/api/share/workspace',
      post({ workspaceId: s.board, role: 'owner', taskId, why: 'Co-owners.' }),
    );
    expect(owners.status).toBe(202);
    expect(s.handle.shareLinks.list().length).toBe(linksBefore);

    const { reviewItemId } = (await wider.json()) as Proposal;
    const change = (await item(reviewItemId))?.access;
    const approved = await s.owner(
      accessPath(reviewItemId),
      post({ decision: 'approve', access: change }),
    );
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as { url?: string }).url).toContain('/s/');
    expect(await audience()).toContain('@riverbend.example');
  });

  it('removes an address at once, and a domain keeps out the one it was asked to', async () => {
    const res = await s.local(
      `${s.scope}/audience`,
      post({ remove: ['ops@riverbend.example'], author: AGENT }),
    );
    expect(res.status).toBe(200);
    expect(await s.join('ops@riverbend.example')).not.toBe(302);
    expect(await s.join('dee@riverbend.example')).toBe(302);
  });
});
