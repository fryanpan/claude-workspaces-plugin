/**
 * The owner's access page: who can reach every board, and the changes agents
 * proposed. Only the owner's own browser reads it, and an open page hears a
 * change made anywhere else — an agent's proposal, an answer, a removal —
 * within the second (Bryan, 2026-10-08: every surface is live).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCESS_CHANGED } from '../src/page-nudges.ts';
import { buildAccessView } from '../src/share/access-view.ts';
import { ShareLinks } from '../src/share/share-links.ts';
import {
  AGENT,
  type ShareProofServer,
  post,
  readJson,
  startShareProofServer,
} from './share-proof-harness.ts';
import { listenFrames } from './sse-frames.ts';
import { waitFor } from './wait-for.ts';

const ALICE = 'alice@harborlight.example';
const STREAM = '/api/access/events:stream';

interface View {
  boards: Array<{
    workspaceId: string;
    name: string;
    audience: Array<{ match: string }>;
    people: Array<{ email: string; entry?: string }>;
  }>;
  proposals: Array<{ reviewItemId: string; line: string; answer?: { approved: boolean } }>;
}

describe('the access page', () => {
  let s: ShareProofServer;
  let taskId: string;
  const view = async (): Promise<View> => readJson<View>(await s.owner('/api/access'));

  beforeAll(async () => {
    s = await startShareProofServer('Riverbend launch');
    s.handle.shareLinks.addToAudience(s.board, ['@harborlight.example'], 'Bryan');
    expect(await s.join(ALICE)).toBe(302);
    taskId = (
      await readJson<{ task: { id: string } }>(
        await s.local(
          `${s.scope}/tasks`,
          post({
            title: 'Bring the Saltmarsh auditor onto the launch board',
            body: 'Agent can invite the auditor so that they can follow the checklist.',
            author: AGENT,
          }),
        ),
      )
    ).task.id;
  });

  afterAll(async () => {
    await s.stop();
  });

  it('is the owner’s alone: an agent, a visitor and another site are refused', async () => {
    expect((await s.local('/api/access')).status).toBe(403);
    expect((await s.local(STREAM)).status).toBe(403);
    expect((await s.visitor(ALICE, '/api/access')).status).toBe(403);
    expect((await s.visitor(ALICE, '/access')).status).toBe(403);
    const elsewhere = await s.owner('/api/access', {}, { 'sec-fetch-site': 'cross-site' });
    expect(elsewhere.status).toBe(403);
    const page = await s.owner('/access');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('settings-root');
  });

  it('lists each board’s entries and files each person under the one that let them in', async () => {
    const board = (await view()).boards.find((b) => b.workspaceId === s.board);
    expect(board?.name).toBe('Riverbend launch');
    expect(board?.audience.map((e) => e.match)).toContain('@harborlight.example');
    expect(board?.people).toEqual([
      expect.objectContaining({ email: ALICE, entry: '@harborlight.example' }),
    ]);
  });

  it('reaches an open page within the second when an agent proposes, the owner answers, or someone is removed', async () => {
    const res = await s.owner(STREAM);
    expect(res.status).toBe(200);
    const page = listenFrames(res);
    const heard = () => page.frames.filter((f) => f.event === ACCESS_CHANGED).length;
    const inside = { timeout: 1000, describe: 'access.changed within 1s' };
    try {
      const proposed = await s.local(
        `${s.scope}/audience`,
        post({ add: ['audit@saltmarsh.example'], taskId, why: 'The auditor.', author: AGENT }),
      );
      expect(proposed.status).toBe(202);
      await waitFor(() => heard() >= 1, inside);
      const { reviewItemId } = (await proposed.json()) as { reviewItemId: string };
      const row = (await view()).proposals.find((p) => p.reviewItemId === reviewItemId);
      expect(row?.line).toBe('Lets audit@saltmarsh.example sign in to this board.');
      expect(row?.answer).toBeUndefined();

      const before = heard();
      const tasks = await readJson<{
        tasks: Array<{ id: string; reviews?: Array<{ id: string; access?: unknown }> }>;
      }>(await s.local(`${s.scope}/tasks?format=json`));
      const access = tasks.tasks
        .find((t) => t.id === taskId)
        ?.reviews?.find((r) => r.id === reviewItemId)?.access;
      const answered = await s.owner(
        `${s.scope}/tasks/${taskId}/review-items/${reviewItemId}/access`,
        post({ decision: 'reject', access }),
      );
      expect(answered.status).toBe(200);
      await waitFor(() => heard() > before, inside);
      expect((await view()).proposals.find((p) => p.reviewItemId === reviewItemId)?.answer).toEqual(
        expect.objectContaining({ approved: false }),
      );

      const beforeRemove = heard();
      const removed = await s.local(`${s.scope}/audience`, post({ remove: [ALICE] }));
      expect(removed.status).toBe(200);
      await waitFor(() => heard() > beforeRemove, inside);
      const board = (await view()).boards.find((b) => b.workspaceId === s.board);
      expect(board?.people).toEqual([]);
    } finally {
      await page.stop();
    }
  });
});

describe('buildAccessView', () => {
  it('lists only live boards someone else can reach or that have a proposal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'access-view-'));
    try {
      const links = new ShareLinks({ dataDir: dir });
      links.addToAudience('w-shared', ['bob@riverbend.example'], 'Bryan');
      links.addToAudience('w-retired', ['@saltmarsh.example'], 'Bryan');
      const out = buildAccessView({
        boards: [
          { id: 'w-shared', name: 'Shared' },
          { id: 'w-private', name: 'Private' },
          { id: 'w-asked', name: 'Asked' },
          { id: 'w-retired', name: 'Retired', retiredAt: 1 },
        ],
        shareLinks: links,
        proposals: (ids) =>
          ids.includes('w-asked')
            ? [
                {
                  workspaceId: 'w-asked',
                  taskId: 't-1',
                  taskTitle: 'Invite',
                  reviewItemId: 'r-1',
                  change: { op: 'add-audience', workspaceId: 'w-asked', entries: ['@x.example'] },
                  line: 'Lets everyone at @x.example sign in to this board.',
                  why: 'Reviewers.',
                  proposedBy: 'Riverbend Bot',
                  proposedAt: 1,
                },
              ]
            : [],
      });
      expect(out.boards.map((b) => b.workspaceId)).toEqual(['w-shared', 'w-asked']);
      expect(out.boards[0]?.people).toEqual([]);
      expect(out.proposals).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
