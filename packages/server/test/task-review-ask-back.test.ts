/**
 * The ask-back pair on a review item, driven directly with the smallest
 * context that reaches each branch. The routes through a real server are
 * covered by `review-item-question-answer.test.ts` and
 * `task-review-item-routes.test.ts`; this file pins the module's own
 * decisions, each case paired with a control that differs in one field.
 *
 * Placeholders throughout; the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import type { TaskReviewItem, User } from '@claude-workspaces/core';
import { askBackFromAnswer, handleTaskReviewMoreInfo } from '../src/routes/task-review-ask-back.ts';
import type { TaskRouteRequest, TaskRoutesContext } from '../src/routes/task-routes-context.ts';

const PERSON: User = { id: 'known-alice', name: 'Alice', kind: 'known', color: '#336699' };
const AGENT: User = { id: 'agent-riverbend', name: 'Riverbend', kind: 'known', color: '#888888' };
const BOARD = 'w-harbor';
const TASK = 't-saltmarsh';
const ITEM = 'r-one';

interface Calls {
  askBack: number;
  moreInfo: number;
}

function harness(item: Partial<TaskReviewItem> = {}) {
  const calls: Calls = { askBack: 0, moreInfo: 0 };
  const task = { id: TASK, workspaceId: BOARD };
  const row = { id: ITEM, createdAt: 1, createdBy: AGENT, ...item } as unknown as TaskReviewItem;
  const ctx = {
    taskStore: {
      getTask: () => task,
      listReviewItems: () => [row],
      requestMoreInfoOnReview: () => {
        calls.moreInfo++;
        return { ok: true, task, item: row };
      },
    },
    taskProjection: { refreshTask: () => undefined },
    askBackOnItem: async () => {
      calls.askBack++;
      return Response.json({ askedBack: true });
    },
    j: (status: number, body: unknown) => Response.json(body, { status }),
    safeJson: async (req: Request) => (await req.json()) as Record<string, unknown>,
  } as unknown as TaskRoutesContext;
  const rq = (opts: { rest?: string; body?: unknown; owner?: boolean } = {}) =>
    ({
      req: new Request('http://127.0.0.1/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opts.body ?? {}),
      }),
      scope: {
        workspaceId: BOARD,
        rest: opts.rest ?? `tasks/${TASK}/review-items/${ITEM}/more-info`,
        board: {},
      },
      visitor: null,
      authorFor: (claimed: unknown) => (claimed === 'agent' ? AGENT : claimed ? PERSON : undefined),
      requireOwner: () =>
        opts.owner === false ? Response.json({ error: 'owner' }, { status: 403 }) : null,
    }) as unknown as TaskRouteRequest;
  return { ctx, rq, calls };
}

const input = (over: Partial<Parameters<typeof askBackFromAnswer>[2]> = {}) => ({
  taskId: TASK,
  reviewItemId: ITEM,
  text: 'Why is this important?',
  author: PERSON,
  answeredWith: undefined,
  ...over,
});

describe('askBackFromAnswer', () => {
  it("turns a person's typed question into a thread on the item", async () => {
    const { ctx, rq, calls } = harness();
    const res = await askBackFromAnswer(ctx, rq(), input());
    expect(res?.status).toBe(200);
    expect(calls.askBack).toBe(1);
  });

  it('records a statement as an answer (control: no question mark)', async () => {
    const { ctx, rq, calls } = harness();
    expect(await askBackFromAnswer(ctx, rq(), input({ text: 'Ship it.' }))).toBeUndefined();
    expect(calls.askBack).toBe(0);
  });

  it('records a tapped option as an answer whatever its label ends in', async () => {
    const { ctx, rq, calls } = harness();
    const res = await askBackFromAnswer(ctx, rq(), input({ answeredWith: 'o-why' }));
    expect(res).toBeUndefined();
    expect(calls.askBack).toBe(0);
  });

  it("never converts an agent's words", async () => {
    const { ctx, rq, calls } = harness();
    expect(await askBackFromAnswer(ctx, rq(), input({ author: AGENT }))).toBeUndefined();
    expect(calls.askBack).toBe(0);
  });

  it('refuses a question on an answered item rather than displacing the answer', async () => {
    const answered = { text: 'Yes', at: 2, by: PERSON } as unknown as TaskReviewItem['answer'];
    const { ctx, rq, calls } = harness({ answer: answered });
    const res = await askBackFromAnswer(ctx, rq(), input());
    expect(res?.status).toBe(409);
    expect(calls.askBack).toBe(0);
  });
});

describe('handleTaskReviewMoreInfo', () => {
  it('records the question and answers 200', async () => {
    const { ctx, rq, calls } = harness();
    const res = await handleTaskReviewMoreInfo(
      ctx,
      rq({ body: { question: ' Which one? ', author: 'agent' } }),
    );
    expect(res?.status).toBe(200);
    expect(calls.moreInfo).toBe(1);
  });

  it('refuses a non-owner on an owner-only item before any write', async () => {
    const { ctx, rq, calls } = harness({ review: { ownerOnly: true } } as Partial<TaskReviewItem>);
    const res = await handleTaskReviewMoreInfo(
      ctx,
      rq({ owner: false, body: { question: 'Which one?', author: 'agent' } }),
    );
    expect(res?.status).toBe(403);
    expect(calls.moreInfo).toBe(0);
  });

  it('refuses an empty question', async () => {
    const { ctx, rq, calls } = harness();
    const res = await handleTaskReviewMoreInfo(
      ctx,
      rq({ body: { question: '  ', author: 'agent' } }),
    );
    expect(res?.status).toBe(400);
    expect(calls.moreInfo).toBe(0);
  });

  it('declines a path it does not own', async () => {
    const { ctx, rq } = harness();
    const res = await handleTaskReviewMoreInfo(
      ctx,
      rq({ rest: `tasks/${TASK}/review-items/${ITEM}/revise` }),
    );
    expect(res).toBeUndefined();
  });
});
