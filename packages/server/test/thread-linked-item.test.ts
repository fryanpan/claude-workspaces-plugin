/**
 * An agent on one board attaches a review item from another board to a mock's
 * thread (`POST …/threads/:threadId/linked-items`, MCP `link_review_item`).
 *
 * Driven through the real route table and a real `/y/` socket: a page already
 * holding board A's mock open sees one new comment arrive carrying the
 * snapshot — board B's name, the item's headline, the link its own board
 * opens it at — for a ticket item and for a thread item alike. A missing item,
 * an item named under the wrong board, a malformed body and a share visitor
 * are refused, and none of them writes anything.
 *
 * Fixtures are invented. Port 0, temp data dir.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LinkedReviewItem, listThreadsWithLinks } from '@claude-workspaces/core';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type AccessHarness, accessHarness, mintAccessShare } from './access-share.ts';
import { waitFor } from './wait-for.ts';

const MSG_SYNC = 0;

/** A page holding the doc open: it syncs, and only listens. */
function openPage(url: string, origin: string) {
  const ydoc = new Y.Doc();
  const ws = new WebSocket(url, { headers: { origin } } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  let synced: () => void = () => {};
  const ready = new Promise<void>((r) => {
    synced = r;
  });
  ws.addEventListener('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
  });
  ws.addEventListener('message', (ev) => {
    const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
    if (decoding.readVarUint(dec) !== MSG_SYNC) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const type = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    if (type === syncProtocol.messageYjsSyncStep2) synced();
  });
  return { ydoc, ready, close: () => ws.close() };
}

const AGENT = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
const PERSON = { id: 'person:alice', name: 'Alice', kind: 'person' };
const TICKET_ASK = 'Which Harborlight layout ships?';
const THREAD_ASK = 'Is the Saltmarsh tide chart readable?';

describe('a review item linked onto a thread from another board', () => {
  let handle: ServerHandle;
  let dataDir = '';
  let base = '';
  let boardA = '';
  let boardB = '';
  let taskB = '';
  let itemB = '';
  let threadB = '';
  let threadA = '';
  let tides = '';
  let access: AccessHarness;
  const LOCAL = () => ({ host: `localhost:${handle.port}` });

  const post = (path: string, body: unknown, headers: Record<string, string> = LOCAL()) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const ok = async (path: string, body: unknown) => {
    const res = await post(path, body);
    expect(res.ok, `${path} ${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<Record<string, unknown>>;
  };
  const link = (body: unknown, headers?: Record<string, string>) =>
    post(`/workspaces/${boardA}/docs/report/threads/${threadA}/linked-items`, body, headers);
  const commentsOnA = async () => {
    const res = await fetch(`${base}/workspaces/${boardA}/docs/report/threads/${threadA}`, {
      headers: LOCAL(),
    });
    return ((await res.json()) as { thread: { comments: Array<Record<string, unknown>> } }).thread
      .comments;
  };
  const mock = async (board: string, docId: string) => {
    const file = join(dataDir, `${docId}.html`);
    writeFileSync(file, '<!doctype html><html><body><main><h3>Riverbend</h3></main></body></html>');
    const made = await ok(`/workspaces/${board}/docs`, { docId, type: 'mockup', sourceUrl: file });
    await ok(`/workspaces/${board}/docs:attach`, { docId });
    return String(made.docId);
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-linked-item-'));
    access = await accessHarness();
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://127.0.0.1:${handle.port}`;
    const board = async (name: string) =>
      ((await ok('/workspaces', { name, author: AGENT })) as { workspace: { id: string } })
        .workspace.id;
    boardA = await board('Harborlight');
    boardB = await board('Riverbend');
    await mock(boardA, 'report');
    tides = await mock(boardB, 'tides');
    threadA = (
      (await ok(`/workspaces/${boardA}/docs/report/threads`, {
        author: PERSON,
        text: 'Which question is this mock answering?',
        anchor: { kind: 'subject' },
      })) as { thread: { id: string } }
    ).thread.id;
    taskB = (
      (await ok(`/workspaces/${boardB}/tasks`, {
        title: 'Pick the Harborlight layout',
        body: 'Alice can pick a layout so that the page ships this week.',
        author: AGENT,
      })) as { task: { id: string } }
    ).task.id;
    itemB = (
      (await ok(`/workspaces/${boardB}/tasks/${taskB}/review-items`, {
        author: AGENT,
        review: { shape: 'review', headline: TICKET_ASK },
      })) as { item: { id: string } }
    ).item.id;
    threadB = (
      (await ok(`/workspaces/${boardB}/docs/tides/threads`, {
        author: AGENT,
        text: 'Alice, please look at the chart.',
        anchor: { kind: 'subject' },
        review: { shape: 'review', headline: THREAD_ASK },
      })) as { thread: { id: string } }
    ).thread.id;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a ticket item reaches a page already open, as one comment with its snapshot', async () => {
    const page = openPage(`ws://127.0.0.1:${handle.port}/workspaces/${boardA}/docs/report/y`, base);
    try {
      await page.ready;
      const linkedOnPage = () =>
        listThreadsWithLinks(page.ydoc)
          .find((t) => t.id === threadA)
          ?.comments.find((c) => c.linkedItem?.headline === TICKET_ASK);
      // CONTROL: the open page holds the thread, and no linked item yet.
      expect(listThreadsWithLinks(page.ydoc).some((t) => t.id === threadA)).toBe(true);
      expect(linkedOnPage()).toBeUndefined();
      const before = (await commentsOnA()).length;

      const res = await link({
        author: AGENT,
        item: { workspaceId: boardB, taskId: taskB, reviewItemId: itemB },
      });
      expect(res.status, await res.clone().text()).toBe(200);

      const live = await waitFor(linkedOnPage, { describe: 'the linked comment on the open page' });
      const expected: LinkedReviewItem = {
        workspaceId: boardB,
        board: 'Riverbend',
        headline: TICKET_ASK,
        url: `/workspaces/${boardB}?task=${taskB}`,
        ref: { taskId: taskB, reviewItemId: itemB },
      };
      expect(live.linkedItem).toEqual(expected);
      expect(live.author.id).toBe(AGENT.id);
      // Surfaces that render only words still show what was linked.
      expect(live.text).toContain(TICKET_ASK);
      expect(live.text).toContain(expected.url);
      expect(live.text).toContain('Riverbend');
      // One comment, and it round-trips through the REST read.
      const after = await commentsOnA();
      expect(after.length).toBe(before + 1);
      expect(after.at(-1)?.linkedItem).toEqual(expected);
    } finally {
      page.close();
    }
  });

  it('a thread item links to the mock at that thread, under an optional note', async () => {
    const res = await link({
      author: AGENT,
      item: { workspaceId: boardB, docId: 'tides', threadId: threadB },
      text: 'Alice, this is the ask behind the mock.',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { linkedItem } = (await res.json()) as { linkedItem: LinkedReviewItem };
    expect(linkedItem).toEqual({
      workspaceId: boardB,
      board: 'Riverbend',
      headline: THREAD_ASK,
      // Named by its alias, stored by its own id.
      url: `/workspaces/${boardB}/mockups/${tides}?thread=${threadB}`,
      ref: { docId: tides, threadId: threadB },
    });
    const last = (await commentsOnA()).at(-1);
    expect(last?.linkedItem).toEqual(linkedItem);
    expect(String(last?.text).startsWith('Alice, this is the ask behind the mock.')).toBe(true);
  });

  it('answers 404 for an item that does not exist, or that is named under another board', async () => {
    const before = (await commentsOnA()).length;
    const cases: Array<[string, unknown]> = [
      ['missing ticket item', { workspaceId: boardB, taskId: taskB, reviewItemId: 'r-none' }],
      ['missing task', { workspaceId: boardB, taskId: 't-none', reviewItemId: itemB }],
      ['ticket under the wrong board', { workspaceId: boardA, taskId: taskB, reviewItemId: itemB }],
      ['missing thread', { workspaceId: boardB, docId: 'tides', threadId: 'th-none' }],
      ['thread under the wrong board', { workspaceId: boardA, docId: 'tides', threadId: threadB }],
      ['thread with no item', { workspaceId: boardA, docId: 'report', threadId: threadA }],
      ['missing board', { workspaceId: 'w-none', taskId: taskB, reviewItemId: itemB }],
    ];
    for (const [label, item] of cases) {
      expect((await link({ author: AGENT, item })).status, label).toBe(404);
    }
    expect((await commentsOnA()).length).toBe(before);
  });

  it('answers 400 for a malformed body, and 404 for a missing target thread', async () => {
    const before = (await commentsOnA()).length;
    const cases: Array<[string, unknown]> = [
      ['no item', { author: AGENT }],
      ['no board', { author: AGENT, item: { taskId: taskB, reviewItemId: itemB } }],
      ['half a ticket ref', { author: AGENT, item: { workspaceId: boardB, taskId: taskB } }],
      [
        'both kinds at once',
        {
          author: AGENT,
          item: { workspaceId: boardB, taskId: taskB, reviewItemId: itemB, docId: 'tides' },
        },
      ],
      ['an array', { author: AGENT, item: [boardB, taskB] }],
      [
        'a non-string note',
        {
          author: AGENT,
          item: { workspaceId: boardB, taskId: taskB, reviewItemId: itemB },
          text: 7,
        },
      ],
    ];
    for (const [label, body] of cases) {
      expect((await link(body)).status, label).toBe(400);
    }
    expect((await commentsOnA()).length).toBe(before);
    const gone = await post(`/workspaces/${boardA}/docs/report/threads/th-none/linked-items`, {
      author: AGENT,
      item: { workspaceId: boardB, taskId: taskB, reviewItemId: itemB },
    });
    expect(gone.status).toBe(404);
  });

  it('is refused to a share visitor on the thread’s board, who may still reply there', async () => {
    const before = (await commentsOnA()).length;
    const share = await mintAccessShare(base, access, boardA);
    const res = await link(
      { item: { workspaceId: boardB, taskId: taskB, reviewItemId: itemB } },
      share.headers,
    );
    expect(res.status).toBe(403);
    expect((await commentsOnA()).length).toBe(before);
    // CONTROL: the same visitor reaches this thread's reply route.
    const reply = await post(
      `/workspaces/${boardA}/docs/report/threads/${threadA}/comments`,
      { text: 'Agreed.' },
      share.headers,
    );
    expect(reply.status).toBe(200);
  });
});
