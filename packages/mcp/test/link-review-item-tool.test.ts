/**
 * `link_review_item` asks the thread's board to attach an item from any
 * board, and hands back what the server said.
 *
 * Driven through the committed bundle against a recording stub, so what is
 * asserted is the request a session actually sends. The server's half is
 * `packages/server/test/thread-linked-item.test.ts`. All fixtures synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, type Recorded, startBundle } from './harness/mcp-bundle.ts';

const LINKED = {
  workspaceId: 'w-riverbend',
  board: 'Riverbend',
  headline: 'Which Harborlight layout ships?',
  url: '/workspaces/w-riverbend?task=t-1',
  ref: { taskId: 't-1', reviewItemId: 'r-1' },
};

let mcp: BundleHarness;

beforeAll(async () => {
  mcp = await startBundle((req: Recorded) =>
    req.path.endsWith('/linked-items') ? { linkedItem: LINKED, commentId: 'c-9' } : undefined,
  );
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

describe('link_review_item', () => {
  it('is served, and requires the thread and the item', () => {
    expect(mcp.tool('link_review_item')?.inputSchema?.required).toEqual([
      'workspaceId',
      'docId',
      'threadId',
      'item',
    ]);
  });

  it("POSTs the item to the thread's board, as this agent", async () => {
    const item = { workspaceId: 'w-riverbend', taskId: 't-1', reviewItemId: 'r-1' };
    const res = await mcp.call('link_review_item', {
      workspaceId: 'w-harbor',
      docId: 'report',
      threadId: 'th 1',
      item,
      text: 'Alice, this is the ask.',
    });
    expect(res.isError, res.text).toBe(false);
    // The doc tools' auto-watch POSTs too; only the verb's own route counts.
    const posts = res.sent.filter((r) => r.method === 'POST' && r.path.endsWith('/linked-items'));
    expect(posts.map((r) => r.path)).toEqual([
      '/workspaces/w-harbor/docs/report/threads/th%201/linked-items',
    ]);
    expect(posts[0]?.body).toMatchObject({
      item,
      text: 'Alice, this is the ask.',
      author: { name: 'Harness Agent' },
    });
    expect((res.json as { linkedItem: unknown }).linkedItem).toEqual(LINKED);
  });

  it('sends no text when none was given', async () => {
    const res = await mcp.call('link_review_item', {
      workspaceId: 'w-harbor',
      docId: 'report',
      threadId: 'th-2',
      item: { workspaceId: 'w-riverbend', docId: 'tides', threadId: 'th-9' },
    });
    const body = res.sent.find((r) => r.path.endsWith('/linked-items'))?.body as Record<
      string,
      unknown
    >;
    expect('text' in body).toBe(false);
  });
});
