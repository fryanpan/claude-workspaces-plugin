/**
 * The plan lead's half: a `workspace.new_asks` frame reads as one line per
 * ask, naming the key `rank_review_item` takes, and `rank_review_item` posts
 * the rank as this agent, handing back the server's refusal as an answer.
 *
 * Fixtures are invented; the repo is public.
 */
import { describe, expect, it } from 'vitest';
import { asksLine } from '../src/asks-line.ts';
import { handleWorkspaceTool } from '../src/tools/workspace.ts';

describe('asksLine', () => {
  it('lists each ask with its board, row, headline and key', () => {
    const t = (h: number, m: number) => Date.UTC(2026, 9, 7, h, m);
    const line = asksLine(
      {
        from: t(17, 0),
        to: t(17, 10),
        items: [
          {
            workspaceId: 'w-harbor',
            board: 'Harborlight',
            row: { kind: 'task-review', taskId: 't-1' },
            key: 'w-harbor:task-review:t-1:r-1',
            headline: 'Which tide table?',
            createdAt: t(17, 2),
          },
          {
            workspaceId: 'w-river',
            row: { kind: 'doc-thread', docId: 'd-ferry' },
            key: 'w-river:doc-thread:d-ferry:th-1',
            headline: 'Does this read right?',
            createdAt: t(17, 4),
          },
        ],
        more: 3,
      },
      'UTC',
    );
    expect(line).toBe(
      [
        "[workspace.new_asks 17:00–17:10] 2 new asks on other boards. Rank any that this week's goals put ahead of the plan order, and file each under its goal, with rank_review_item(key, rank, goal):",
        '- 17:02 Harborlight, task t-1: "Which tide table?" (key w-harbor:task-review:t-1:r-1)',
        '- 17:04 w-river, doc d-ferry: "Does this read right?" (key w-river:doc-thread:d-ferry:th-1)',
        '(3 more in this window, not listed.)',
      ].join('\n'),
    );
  });

  it('names the work and the goal a blocking ask stops, and nothing on an ordinary one', () => {
    const line = asksLine(
      {
        from: 0,
        to: 0,
        items: [
          {
            board: 'Harborlight',
            row: { kind: 'task-review', taskId: 't-1' },
            key: 'k-1',
            headline: 'Which tide table?',
            createdAt: 0,
            stops: { what: 'the tide import', goal: 'Ship the Riverbend launch' },
          },
          { board: 'Harborlight', key: 'k-2', headline: 'Does this read right?', createdAt: 0 },
        ],
      },
      'UTC',
    );
    expect(line?.split('\n').slice(1)).toEqual([
      '- 00:00 Harborlight, task t-1: "Which tide table?" (key k-1) Stopped until you answer: the tide import — stops work on Ship the Riverbend launch.',
      '- 00:00 Harborlight, row ?: "Does this read right?" (key k-2)',
    ]);
  });

  it('says nothing for a frame with no readable ask', () => {
    expect(asksLine({ items: [] })).toBeNull();
    expect(asksLine({ items: [{ board: 'Harborlight' }] })).toBeNull();
  });
});

function ctxFor(answer: () => unknown) {
  const calls: Array<[string, string, unknown]> = [];
  const ctx = {
    http: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return answer();
    },
    ok: (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    err: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
    AUTHOR: { id: 'agent-team-lead', name: 'Team Lead' },
  };
  return { calls, ctx: ctx as never };
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? '';
const KEY = 'w-harbor:task-review:t-1:r-1';

describe('rank_review_item', () => {
  it('posts the rank as this agent and answers ranked:true', async () => {
    const { calls, ctx } = ctxFor(() => ({ key: KEY, rank: 2 }));
    const r = await handleWorkspaceTool('rank_review_item', { key: KEY, rank: 2 }, ctx);
    expect(calls).toEqual([
      ['POST', '/api/review-queue/rank', { agentId: 'agent-team-lead', key: KEY, rank: 2 }],
    ]);
    expect(JSON.parse(text(r))).toEqual({ key: KEY, rank: 2, ranked: true });
  });

  it('posts a goal tag alone, leaving the rank out so the server keeps it', async () => {
    const { calls, ctx } = ctxFor(() => ({ key: KEY, goal: 'urgent' }));
    await handleWorkspaceTool('rank_review_item', { key: KEY, goal: 'urgent' }, ctx);
    await handleWorkspaceTool('rank_review_item', { key: KEY, rank: 3, goal: null }, ctx);
    expect(calls).toEqual([
      ['POST', '/api/review-queue/rank', { agentId: 'agent-team-lead', key: KEY, goal: 'urgent' }],
      [
        'POST',
        '/api/review-queue/rank',
        { agentId: 'agent-team-lead', key: KEY, rank: 3, goal: null },
      ],
    ]);
  });

  it('hands back a refusal with its reason, and throws anything else', async () => {
    const refused = ctxFor(() => {
      throw new Error(
        'POST /api/review-queue/rank → 403: {"error":"not-plan-lead","message":"Only the lead of the plan board may rank review items."}',
      );
    });
    const r = await handleWorkspaceTool('rank_review_item', { key: KEY, rank: 1 }, refused.ctx);
    expect(JSON.parse(text(r))).toMatchObject({ ranked: false, reason: 'not-plan-lead' });
    const broken = ctxFor(() => {
      throw new Error('POST /api/review-queue/rank → 500: boom');
    });
    await expect(
      handleWorkspaceTool('rank_review_item', { key: KEY, rank: 1 }, broken.ctx),
    ).rejects.toThrow('500');
  });

  it('refuses a missing key or a rank that is not a number or null', async () => {
    const { calls, ctx } = ctxFor(() => ({}));
    expect(text(await handleWorkspaceTool('rank_review_item', { rank: 1 }, ctx))).toContain('key');
    expect(
      text(await handleWorkspaceTool('rank_review_item', { key: KEY, rank: 'first' }, ctx)),
    ).toContain('rank');
    expect(text(await handleWorkspaceTool('rank_review_item', { key: KEY }, ctx))).toContain(
      'goal',
    );
    expect(
      text(await handleWorkspaceTool('rank_review_item', { key: KEY, goal: 4 }, ctx)),
    ).toContain('goal');
    expect(calls).toEqual([]);
  });
});
