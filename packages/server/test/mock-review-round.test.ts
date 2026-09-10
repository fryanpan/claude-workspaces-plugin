/**
 * A round of review on a MOCKUP, end to end on the server side.
 *
 * The ask belongs where the thing is. Two halves are asserted here, both of
 * them contracts the widget's dock depends on:
 *
 *  - **one item, several rounds.** Round 2 revises the standing item rather
 *    than raising a second thread, and round 1's wording stays readable on
 *    it. Two threads about one question is exactly the duplication the
 *    reader's queue exists to remove, and it also loses the reading that the
 *    earlier rounds are the same ask at an earlier moment.
 *  - **the round's re-ask is ONE call, and it names the same item.** The
 *    write that raises an item hands back `reviewItemId`, so the next round
 *    is `revise_review_item(workspaceId, reviewItemId)` and the agent never
 *    has to reconstruct a doc-thread item's identity out of three ids.
 *
 * And the row that reaches the reader carries the doc's KIND, which is what
 * lets the Home queue send them to the mock rather than to the editor
 * rendering of its HTML.
 *
 * Everything is read back through a second request rather than trusted from
 * the response of the call that made it.
 *
 * All fixtures are synthetic — invented ids and generic personas. The repo is
 * public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseThreadReviewItemId } from '@claude-workspaces/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };

const ROUND_1 =
  'Day one opens at a dollar a cup. On a warm morning that is the most expensive stand on the street.';
const ROUND_2 =
  'At fifty cents it sells out before noon and the whole afternoon is a stand with nothing to sell.';

const MOCK_HTML = '<!doctype html><html><body><main id="price">Price per cup</main></body></html>';

interface ThreadPayload {
  id: string;
  comments: Array<{ id: string; review?: Record<string, unknown> }>;
}
interface QueueRow {
  kind: string;
  docId?: string;
  docType?: string;
  threadId?: string;
  reviewItemId?: string;
  ask?: string;
}

describe('a review item raised on a mockup', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws: string;
  let docId: string;

  const post = (path: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mock-review-round-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    ws = await seedBoard(base);
    const file = join(dataDir, 'lemonade.html');
    writeFileSync(file, MOCK_HTML);
    const created = await jj<{ docId: string }>(
      await post(`/workspaces/${ws}/docs`, {
        docId: 'lemonade-mock',
        type: 'mockup',
        sourceUrl: file,
      }),
    );
    docId = created.docId;
    await jj(await post(`/workspaces/${ws}/docs:attach`, { docId }));
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Round 1: the ask, as an agent raises it on the mock. */
  async function raise(): Promise<{
    threadId: string;
    commentId: string;
    reviewItemId?: string;
  }> {
    const res = await jj<{ thread: ThreadPayload; reviewItemId?: string }>(
      await post(`/workspaces/${ws}/docs/${docId}/threads`, {
        author: LEAD,
        text: 'Priced day one.',
        anchor: { kind: 'subject' },
        review: {
          shape: 'decision',
          headline: 'Which price does day one ship with?',
          detail: ROUND_1,
          options: [
            { id: 'o-75', label: 'Ship at 75c' },
            { id: 'o-50', label: 'Keep 50c' },
          ],
        },
      }),
    );
    const comment = res.thread.comments[0];
    expect(comment, 'the raised item comes back with its comment').toBeTruthy();
    return {
      threadId: res.thread.id,
      commentId: (comment as { id: string }).id,
      ...(res.reviewItemId !== undefined ? { reviewItemId: res.reviewItemId } : {}),
    };
  }

  const queue = async (): Promise<QueueRow[]> => {
    const out = await jj<{ items: QueueRow[] }>(
      await fetch(`${base}/workspaces/${ws}/review-items`),
    );
    return out.items;
  };

  const storedReview = async (threadId: string): Promise<Record<string, unknown> | undefined> => {
    const listed = await jj<{ threads: ThreadPayload[] }>(
      await fetch(`${base}/workspaces/${ws}/docs/${docId}/threads`),
    );
    return listed.threads.find((t) => t.id === threadId)?.comments[0]?.review;
  };

  it('hands back the item id that the next round re-asks under', async () => {
    const { threadId, commentId, reviewItemId } = await raise();
    expect(reviewItemId, 'raising an item should name it').toBeTruthy();
    // The id is an ADDRESS, not an opaque token: it decodes to the very
    // (doc, thread, comment) the item was raised at, which is what lets a
    // bare id reach a doc-thread item with nothing else carried along.
    expect(parseThreadReviewItemId(reviewItemId as string)).toEqual({
      docId,
      threadId,
      commentId,
    });
  });

  it('CONTROL: a comment with no review declares no item and gets no id', async () => {
    // Without this the assertion above would pass on a route that stamped an
    // id onto every comment it wrote.
    const res = await jj<{ reviewItemId?: string }>(
      await post(`/workspaces/${ws}/docs/${docId}/threads`, {
        author: LEAD,
        text: 'Just a note about the copy.',
        anchor: { kind: 'subject' },
      }),
    );
    expect(res.reviewItemId).toBeUndefined();
  });

  it('round 2 revises the standing item and leaves round 1 readable on it', async () => {
    const { threadId, commentId } = await raise();
    await jj(
      await post(`/workspaces/${ws}/docs/${docId}/threads/${threadId}/revise`, {
        author: LEAD,
        commentId,
        detail: ROUND_2,
      }),
    );

    const stored = await storedReview(threadId);
    expect(stored?.detail).toBe(ROUND_2);
    const rounds = stored?.revisions as Array<Record<string, unknown>>;
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.detail).toBe(ROUND_1);

    // And ONE row on the reader's queue, not two: the second round is the
    // same ask, not a new one.
    const rows = (await queue()).filter((r) => r.docId === docId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.threadId).toBe(threadId);
  });

  it('CONTROL: raising a SECOND item on its own thread does make a second row', async () => {
    // The one-row assertion above is only meaningful if this queue can count
    // to two at all.
    await raise();
    await jj(
      await post(`/workspaces/${ws}/docs/${docId}/threads`, {
        author: LEAD,
        text: 'And the cup size.',
        anchor: { kind: 'subject' },
        review: {
          shape: 'review',
          headline: 'Is the cup size worth showing on day one?',
          detail: 'Two sizes doubles the arithmetic before anything has been sold.',
        },
      }),
    );
    expect((await queue()).filter((r) => r.docId === docId)).toHaveLength(2);
  });

  it("the reader's row names the doc's kind, so it can open the mock", async () => {
    const { threadId } = await raise();
    const row = (await queue()).find((r) => r.threadId === threadId);
    expect(row?.kind).toBe('doc-thread');
    expect(row?.docType).toBe('mockup');
  });

  it('the item is answerable at the thread, and the answer is stored on it', async () => {
    const { threadId, commentId } = await raise();
    await jj(
      await post(`/workspaces/${ws}/docs/${docId}/threads/${threadId}/answer`, {
        author: PERSON,
        commentId,
        text: 'Ship at 75c — let the weather be the twist.',
        optionId: 'o-75',
      }),
    );
    const stored = await storedReview(threadId);
    expect(stored?.answerText).toBe('Ship at 75c — let the weather be the twist.');
    expect(stored?.answeredWith).toBe('o-75');
    expect(stored?.answeredBy).toBe('Jordan');
    // Answered is off the queue — the reader is not still being asked.
    expect((await queue()).filter((r) => r.threadId === threadId)).toHaveLength(0);
  });
});
