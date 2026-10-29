/**
 * The ways round "only the owner changes who is in" that the security review
 * of the access door found, each closed (Bryan, 29 Oct).
 *
 * - The older Cloudflare share mint named its own allow list, so an agent
 *   could let a domain in without a card.
 * - A card's proposer was whatever author the caller claimed, so an agent
 *   could file one that read as from a person.
 * - Approving a domain twice said "Approved" and did nothing, without saying so.
 *
 * Every name and address is invented; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { proposingAgent } from '../src/share/access-proposals.ts';
import {
  AGENT,
  type ShareProofServer,
  post,
  readJson,
  startShareProofServer,
} from './share-proof-harness.ts';

const ALICE = 'alice@harborlight.example';

interface Proposal {
  proposed: true;
  taskId: string;
  reviewItemId: string;
}
interface Item {
  id: string;
  access?: unknown;
  createdBy?: string;
  answer?: { text: string };
}

describe('the share door, against the ways round it', () => {
  let s: ShareProofServer;
  let taskId: string;

  const item = async (id: string): Promise<Item | undefined> => {
    const body = await readJson<{ tasks: Array<{ id: string; reviews?: Item[] }> }>(
      await s.local(`${s.scope}/tasks?format=json`),
    );
    return body.tasks.find((t) => t.id === taskId)?.reviews?.find((r) => r.id === id);
  };
  const accessPath = (id: string) => `${s.scope}/tasks/${taskId}/review-items/${id}/access`;
  const approve = async (id: string) =>
    s.owner(accessPath(id), post({ decision: 'approve', access: (await item(id))?.access }));
  const audience = async (): Promise<string[]> =>
    (
      await readJson<{ audience: Array<{ match: string }> }>(await s.local(`${s.scope}/members`))
    ).audience.map((e) => e.match);

  beforeAll(async () => {
    // No share hostname: the one deployment where the older mint still runs.
    s = await startShareProofServer('Harborlight review', { legacyMint: true });
    s.handle.shareLinks.addToAudience(s.board, [ALICE], 'Bryan');
    taskId = (
      await readJson<{ task: { id: string } }>(
        await s.local(
          `${s.scope}/tasks`,
          post({
            title: 'Bring the Riverbend reviewers onto the board',
            body: 'Agent can invite the Riverbend reviewers so that they can read the drafts.',
            author: AGENT,
          }),
        ),
      )
    ).task.id;
  });

  afterAll(async () => {
    await s.stop();
  });

  it('turns an older mint that names somebody new into a card, and mints nothing', async () => {
    const before = s.handle.shares?.list().length ?? 0;
    const noTask = await s.local(
      '/api/share/link',
      post({ workspaceId: s.board, allowDomains: ['@riverbend.example'] }),
    );
    expect(noTask.status).toBe(400);
    expect(((await noTask.json()) as { error: string }).error).toBe('task-required');

    const asked = await s.local(
      '/api/share/link',
      post({
        workspaceId: s.board,
        allowDomains: ['@riverbend.example'],
        taskId,
        why: 'The Riverbend reviewers read the drafts.',
      }),
    );
    expect(asked.status).toBe(202);
    expect(s.handle.shares?.list().length ?? 0).toBe(before);
    expect(await audience()).not.toContain('@riverbend.example');

    // Positive control: once the owner approves, the same mint goes through.
    const { reviewItemId } = (await asked.json()) as Proposal;
    expect((await approve(reviewItemId)).status).toBe(200);
    const minted = await s.local(
      '/api/share/link',
      post({ workspaceId: s.board, allowDomains: ['@riverbend.example'] }),
    );
    expect(minted.status, await minted.clone().text()).toBe(200);
  });

  it("files a card as the agent, whoever the caller's author claims to be", async () => {
    const res = await s.local(
      `${s.scope}/audience`,
      post({
        add: ['ops@saltmarsh.example'],
        taskId,
        why: 'The ops lead reviews the drafts.',
        author: { id: 'known-bryan', name: 'Bryan', kind: 'person' },
      }),
    );
    expect(res.status).toBe(202);
    const filed = await item(((await res.json()) as Proposal).reviewItemId);
    // The card names an agent; the person's id it claimed is the unit test below.
    expect(filed?.createdBy).toBe('Bryan (agent)');
  });

  it('says so when an approved add changed nothing', async () => {
    const ask = async () =>
      (
        (await (
          await s.local(
            `${s.scope}/audience`,
            post({ add: ['@saltmarsh.example'], taskId, why: 'The whole team.', author: AGENT }),
          )
        ).json()) as Proposal
      ).reviewItemId;
    const first = await ask();
    const second = await ask();
    expect((await approve(first)).status).toBe(200);
    expect((await item(first))?.answer?.text).not.toContain('Nothing changed');
    expect((await approve(second)).status).toBe(200);
    expect((await item(second))?.answer?.text).toBe(
      'Approved. Nothing changed: the board already lets them sign in.',
    );
  });
});

describe('who a card says proposed it', () => {
  it('is always an agent id, from a string or an author object', () => {
    expect(proposingAgent('Riverbend Bot').id).toBe('agent-riverbend-bot');
    expect(proposingAgent({ id: 'known-bryan', name: 'Riverbend Bot', kind: 'person' }).id).toBe(
      'agent-riverbend-bot',
    );
    // A person's name is still filed as an agent, and says so.
    expect(proposingAgent({ id: 'known-bryan', name: 'Bryan', kind: 'person' })).toMatchObject({
      id: 'agent-bryan',
      name: 'Bryan (agent)',
    });
    expect(proposingAgent(undefined).id).toBe('known-agent');
    expect(proposingAgent('   ').id).toBe('known-agent');
  });
});
