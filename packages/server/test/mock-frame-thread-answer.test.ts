/**
 * A thread's review item answered from inside a mock frame lands exactly as
 * one answered on Home does.
 *
 * Inside a served mock the widget cannot reach the board itself: the page
 * holding the frame relays the call and stamps it `x-cw-via: mock-frame`
 * (`mockup-frame.ts`). The stamp exists to make some writes from the frame
 * weaker — a relayed edit reaches only what the frame wrote — so the risk is
 * that it quietly makes an ANSWER weaker too: stored, but left on Home's
 * queue, or without the board row the MCP child wakes the filing agent from.
 *
 * Two arms on one server, each its own mock doc: the relayed call, and the
 * same answer without the stamp, the shape Home sends. Both are read back
 * through second requests, and the relayed arm must match the plain one on
 * every observable: the item off the queue, the answer stored, the
 * `thread.replied` frame a watching agent is woken by on the doc's stream,
 * and the `review_item.answered` row on the board's log.
 *
 * Fixtures are invented: Harborlight and Riverbend, Alice and Bob.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { threadReviewItemId } from '@claude-workspaces/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { eventsLogPath } from '../src/tasks.ts';
import { signedInPerson } from './signed-in-person.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const AGENT = { id: 'agent-riverbend', name: 'Riverbend', kind: 'agent' };
/** Signed in on the board page in `beforeAll`: a person's answer is recorded
 *  only from that person's own proven request. */
let ALICE = { id: 'known-alice', name: 'Alice', kind: 'person' };

const MOCK_HTML = '<!doctype html><html><body><main id="price">75c a cup</main></body></html>';

interface Row {
  event: string;
  reviewItemId?: string;
  actorId?: string;
}
interface Stored {
  id: string;
  comments: Array<{ id: string; text: string; review?: Record<string, unknown> }>;
}

describe('a thread review item answered through the mock frame relay', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws: string;
  let aliceHeaders: Record<string, string> = {};

  /** Alice's requests carry Alice's sign-in, relayed or not. */
  const send = (path: string, body: unknown, relayed: boolean): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...((body as { author?: { id?: string } } | null)?.author?.id === ALICE.id
          ? aliceHeaders
          : {}),
        ...(relayed ? { 'x-cw-via': 'mock-frame' } : {}),
      },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  const queue = async (): Promise<Array<{ threadId?: string }>> =>
    (
      await jj<{ items: Array<{ threadId?: string }> }>(
        await fetch(`${base}/workspaces/${ws}/review-items`),
      )
    ).items;
  const answeredRows = (): Row[] => {
    const path = eventsLogPath(dataDir, ws);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Row)
      .filter((r) => r.event === 'review_item.answered');
  };

  /** Hold a doc's event stream the way a watching agent does; `text()` is
   *  every byte it has carried so far. */
  async function watchDoc(docs: string): Promise<{ text: () => string; close: () => void }> {
    const controller = new AbortController();
    const res = await fetch(`${base}${docs}/events:stream`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    });
    expect(res.ok).toBe(true);
    let seen = '';
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        while (reader) {
          const { done, value } = await reader.read();
          if (done) return;
          seen += decoder.decode(value, { stream: true });
        }
      } catch {}
    })();
    return { text: () => seen, close: () => controller.abort() };
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mock-frame-answer-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base);
    const alice = signedInPerson(handle, dataDir, base, {
      email: 'alice@harborlight.example',
      name: 'Alice',
    });
    ALICE = alice.user;
    aliceHeaders = alice.headers;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A mock doc with Alice's comment, answered by the agent with a decision. */
  async function askOnMock(name: string) {
    const file = join(dataDir, `${name}.html`);
    writeFileSync(file, MOCK_HTML);
    const { docId } = await jj<{ docId: string }>(
      await send(`/workspaces/${ws}/docs`, { docId: name, type: 'mockup', sourceUrl: file }, false),
    );
    await jj(await send(`/workspaces/${ws}/docs:attach`, { docId }, false));
    const docs = `/workspaces/${ws}/docs/${docId}`;
    const opened = await jj<{ thread: Stored }>(
      await send(
        `${docs}/threads`,
        { author: ALICE, text: 'Is 75c too much?', anchor: { kind: 'subject' } },
        true,
      ),
    );
    const threadId = opened.thread.id;
    await jj(
      await send(
        `${docs}/threads/${threadId}/comments`,
        {
          author: AGENT,
          text: 'Priced it two ways.',
          review: {
            shape: 'decision',
            headline: 'Which price does the Harborlight stand open with?',
            detail: 'At 75c it is the dearest on the street; at 50c it sells out by noon.',
            options: [
              { id: 'o-75', label: 'Open at 75c' },
              { id: 'o-50', label: 'Keep 50c' },
            ],
          },
        },
        false,
      ),
    );
    const listed = await jj<{ threads: Stored[] }>(await fetch(`${base}${docs}/threads`));
    const ask = listed.threads.find((t) => t.id === threadId)?.comments.find((c) => c.review);
    if (!ask) throw new Error('the agent reply carries no review item');
    return { docId, docs, threadId, commentId: ask.id };
  }

  async function answer(relayed: boolean) {
    const at = await askOnMock(relayed ? 'harborlight-relayed' : 'harborlight-home');
    expect(
      (await queue()).some((r) => r.threadId === at.threadId),
      'on the queue first',
    ).toBe(true);
    const stream = await watchDoc(at.docs);
    await jj(
      await send(
        `${at.docs}/threads/${at.threadId}/answer`,
        { author: ALICE, commentId: at.commentId, text: 'Open at 75c', optionId: 'o-75' },
        relayed,
      ),
    );
    // The frame the agent is woken by: the thread, replied to, its item answered.
    const frame = await waitFor(
      () =>
        stream
          .text()
          .split('\n\n')
          .find((f) => f.includes('thread.replied') && f.includes('"answeredWith":"o-75"')),
      { describe: 'a thread.replied frame carrying the answer' },
    );
    stream.close();
    const itemId = threadReviewItemId(at.docId, at.threadId, at.commentId);
    const row = await waitFor(() => answeredRows().find((r) => r.reviewItemId === itemId), {
      describe: `review_item.answered for ${itemId}`,
    });
    const listed = await jj<{ threads: Stored[] }>(await fetch(`${base}${at.docs}/threads`));
    const review = listed.threads
      .find((t) => t.id === at.threadId)
      ?.comments.find((c) => c.id === at.commentId)?.review;
    const onQueue = (await queue()).some((r) => r.threadId === at.threadId);
    return { row, review, onQueue, frame };
  }

  it('leaves the queue, stores the answer and writes the wake row, as Home’s answer does', async () => {
    const home = await answer(false);
    const relayed = await answer(true);

    // The plain arm is the control: what Home's answer does on this server.
    expect(home.onQueue).toBe(false);
    expect(home.review?.answeredWith).toBe('o-75');
    expect(home.row.actorId).toBe(ALICE.id);

    expect(relayed.onQueue, 'the relayed answer takes the item off Home’s queue').toBe(false);
    expect(relayed.review?.answeredWith).toBe('o-75');
    expect(relayed.review?.answerText).toBe('Open at 75c');
    expect(relayed.review?.answeredBy).toBe('Alice');
    expect(relayed.row.actorId).toBe(home.row.actorId);
    // The same event name on both streams: the relay changes nothing an
    // agent watching the doc hears.
    const name = (f: string) => /^event: (.+)$/m.exec(f)?.[1];
    expect(name(relayed.frame)).toBe('thread.replied');
    expect(name(relayed.frame)).toBe(name(home.frame));
  });
});
