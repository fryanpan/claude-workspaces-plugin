/**
 * Product feedback reaches the Workspaces lead without anyone watching the doc.
 *
 * Every board's feedback widget writes to one doc, `BOARD_FEEDBACK_DOC_ID`.
 * That doc sat on no board, so a comment on it reached only sessions that had
 * called `watch_doc` on it, and none had: Bryan's comment there went unseen
 * until he asked in chat. The server now names an owning board for that doc
 * (`feedback-owner.ts`) and delivers its comments to that board's lead the way
 * it delivers a comment on any doc filed on the board.
 *
 * Every session here starts with NO watch of any kind. All names are fixtures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOARD_FEEDBACK_DOC_ID } from '../src/doc-ids.ts';
import type { ServerOptions } from '../src/server-options.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type FrameListener, listenFrames } from './sse-frames.ts';
import { waitFor } from './wait-for.ts';

const PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };

interface Rig {
  handle: ServerHandle;
  dataDir: string;
  post: (path: string, body: unknown) => Promise<Response>;
  get: (path: string) => Promise<Response>;
  /** A board with `agentId` attached first, which makes it the lead. */
  board: (name: string, agentId?: string) => Promise<string>;
  /** A board stream: an agent's MCP child with `agentId`, a page without. */
  listen: (workspaceId: string, agentId?: string) => Promise<FrameListener>;
  /** A comment through the route the feedback widget posts to. */
  widgetComment: (onBoard: string, text: string) => Promise<{ threadId: string }>;
  stop: () => Promise<void>;
}

async function rig(opts: Partial<ServerOptions> = {}): Promise<Rig> {
  const dataDir = mkdtempSync(join(tmpdir(), 'feedback-delivery-'));
  const handle = createServer({ port: 0, dataDir, ...opts });
  const base = `http://127.0.0.1:${handle.port}`;
  const headers = { host: `localhost:${handle.port}` };
  const listeners: FrameListener[] = [];
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (path: string) => fetch(`${base}${path}`, { headers });
  return {
    handle,
    dataDir,
    post,
    get,
    async board(name, agentId) {
      const res = await post('/workspaces', { name, goal: 'Ship it.' });
      expect(res.status).toBe(200);
      const { workspace } = (await res.json()) as { workspace: { id: string } };
      if (agentId) {
        const att = await post(`/workspaces/${workspace.id}/agents`, {
          agentId,
          runtime: 'claude-code-local',
        });
        expect(att.status).toBe(200);
        expect(((await att.json()) as { lead?: boolean }).lead).toBe(true);
      }
      return workspace.id;
    },
    async listen(workspaceId, agentId) {
      const who = agentId ? `?agentId=${agentId}` : '';
      const res = await get(`/workspaces/${encodeURIComponent(workspaceId)}/events:stream${who}`);
      expect(res.status).toBe(200);
      // The bus registers the stream inside the response's start(), so it is
      // held by the time the headers arrive.
      const l = listenFrames(res);
      listeners.push(l);
      return l;
    },
    async widgetComment(onBoard, text) {
      const res = await post(
        `/workspaces/${onBoard}/docs/${encodeURIComponent(BOARD_FEEDBACK_DOC_ID)}/threads`,
        { author: PERSON, text, anchor: { kind: 'subject' } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { thread?: { id: string }; id?: string };
      return { threadId: body.thread?.id ?? body.id ?? '' };
    },
    async stop() {
      for (const l of listeners) await l.stop();
      await handle.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const feedbackFrames = (l: FrameListener, event: string) =>
  l.frames.filter((f) => f.event === event && f.data?.docId === BOARD_FEEDBACK_DOC_ID);

/** Post a board frame every page receives and wait for it; once it has
 *  arrived, any earlier frame sent to that page has arrived too. */
async function caughtUp(r: Rig, board: string, page: FrameListener): Promise<void> {
  const seen = page.frames.filter((f) => f.event === 'task.created').length;
  const res = await r.post(`/workspaces/${board}/tasks`, {
    title: 'Chart the tide pools',
    body: 'Agent can chart the tide pools so that the survey has a baseline.',
    author: { id: 'agent-fixture', name: 'Fixture agent', kind: 'agent' },
  });
  expect(res.status).toBe(200);
  await waitFor(() => page.frames.filter((f) => f.event === 'task.created').length > seen, {
    describe: 'a board frame reaching the page',
  });
}

describe('the feedback doc delivers to the Workspaces lead with no watch', () => {
  let r: Rig;
  let product = '';
  let other = '';

  beforeAll(async () => {
    r = await rig();
    product = await r.board('Workspaces', 'agent-workspaces-lead');
    // The board the person was standing on when they used the widget. It has
    // a lead too, who is not the owner of product feedback.
    other = await r.board('Harborlight', 'agent-harborlight-lead');
  });

  afterAll(async () => {
    await r.stop();
  });

  it('a widget comment reaches the lead as a channel event and is queued for it', async () => {
    const lead = await r.listen(product, 'agent-workspaces-lead');
    const page = await r.listen(product);
    // No subscription of any kind: not on the doc, not on the board.
    expect(r.handle.agentWatches.list('agent-workspaces-lead', () => true).watches).toEqual([]);

    await r.widgetComment(other, 'The Home tab hides my review items.');

    const frame = await waitFor(() => feedbackFrames(lead, 'thread.created')[0], {
      describe: 'thread.created on lf-hub-feedback reaching the Workspaces lead',
    });
    // A new thread carries its opening comment inside `thread.comments`.
    type Said = { text?: string; author?: { id?: string } };
    const comment = (frame.data?.thread as { comments?: Said[] } | undefined)?.comments?.at(-1);
    expect(comment?.text).toBe('The Home tab hides my review items.');
    // The actor the MCP child reads to drop a session's own words.
    expect(comment?.author?.id).toBe(PERSON.id);

    const rows = r.handle.tasks
      .listQueuedComments(product)
      .filter((q) => q.docId === BOARD_FEEDBACK_DOC_ID);
    expect(rows.map((q) => q.agentId)).toEqual(['agent-workspaces-lead']);
    expect(frame.data?.commentQueueId).toBe(rows[0]?.id);
    // The doc is not on the board, so a page (or share visitor) holding the
    // board's channel is not sent it. Checked only once the page has had a
    // later board frame, so a leaked copy would already be in hand.
    await pageCaughtUp(page);
    expect(page.frames.filter((f) => f.data?.docId === BOARD_FEEDBACK_DOC_ID)).toEqual([]);
  });

  const pageCaughtUp = (page: FrameListener) => caughtUp(r, product, page);

  it('the lead is not owed a row for its own reply', async () => {
    const { threadId } = await r.widgetComment(other, 'Search misses archived tasks.');
    const leadRows = () =>
      r.handle.tasks
        .listQueuedComments(product)
        .filter((q) => q.agentId === 'agent-workspaces-lead');
    const reply = (author: { id: string; name: string }, text: string) =>
      r.post(
        `/workspaces/${product}/docs/${encodeURIComponent(BOARD_FEEDBACK_DOC_ID)}/threads/${threadId}/comments`,
        { author, text },
      );
    // POSITIVE CONTROL: the same reply route, from the person, does queue a
    // row for the lead. So the silence below is the author exclusion.
    const before = leadRows().length;
    expect((await reply(PERSON, 'Also on mobile.')).status).toBe(200);
    expect(leadRows().length).toBe(before + 1);
    expect(leadRows().some((q) => q.text === 'Also on mobile.')).toBe(true);

    expect(
      (await reply({ id: 'agent-workspaces-lead', name: 'Workspaces lead' }, 'Filed it.')).status,
    ).toBe(200);
    expect(leadRows().length).toBe(before + 1);
    expect(leadRows().some((q) => q.text === 'Filed it.')).toBe(false);
  });

  it("the owner board's other watchers are not sent product feedback", async () => {
    // A durable board watch is "everything on this board"; this doc is not on it.
    r.handle.agentWatches.update('agent-board-watcher', { add: [`ws:${product}`] });
    await r.widgetComment(other, 'Riverbend filter resets on reload.');
    const rows = r.handle.tasks
      .listQueuedComments(product)
      .filter((q) => q.text === 'Riverbend filter resets on reload.');
    // The lead is the control: the same comment did queue, just not for the watcher.
    expect(rows.map((q) => q.agentId)).toEqual(['agent-workspaces-lead']);
  });

  it('the board the person stood on does not become the owner', () => {
    const rows = r.handle.tasks
      .listQueuedComments(other)
      .filter((q) => q.docId === BOARD_FEEDBACK_DOC_ID);
    expect(rows).toEqual([]);
  });
});

describe('a lead that was away', () => {
  let r: Rig;
  let product = '';
  let other = '';

  beforeAll(async () => {
    r = await rig();
    product = await r.board('Workspaces', 'agent-away-lead');
    other = await r.board('Harborlight');
  });

  afterAll(async () => {
    await r.stop();
  });

  it('a lead that was away gets it on its next heartbeat, and the page is not told', async () => {
    // No stream open: the comment is queued for a lead that is not live.
    await r.widgetComment(other, 'Export drops the last column.');
    const row = r.handle.tasks
      .listQueuedComments(product)
      .find((q) => q.text === 'Export drops the last column.');
    expect(row?.agentId).toBe('agent-away-lead');

    const lead = await r.listen(product, 'agent-away-lead');
    const page = await r.listen(product);
    const beat = await r.post(`/workspaces/${product}/agents/agent-away-lead/heartbeat`, {});
    expect(beat.status).toBe(200);
    await waitFor(() => lead.frames.find((f) => f.data?.commentQueueId === row?.id), {
      describe: 'the queued feedback comment redelivered on the heartbeat',
    });
    await caughtUp(r, product, page);
    expect(page.frames.filter((f) => f.data?.docId === BOARD_FEEDBACK_DOC_ID)).toEqual([]);
  });
});

describe('the owning board is configuration', () => {
  let r: Rig;

  beforeAll(async () => {
    r = await rig({ feedbackBoard: 'Riverbend' });
  });

  afterAll(async () => {
    await r.stop();
  });

  it('a configured board name takes the feedback instead of the default', async () => {
    const named = await r.board('Workspaces', 'agent-default-name');
    const configured = await r.board('Riverbend', 'agent-riverbend-lead');
    const lead = await r.listen(configured, 'agent-riverbend-lead');

    await r.widgetComment(named, 'Saltmarsh view is slow.');

    await waitFor(() => feedbackFrames(lead, 'thread.created')[0], {
      describe: 'thread.created reaching the configured board lead',
    });
    expect(r.handle.tasks.listQueuedComments(configured).map((q) => [q.agentId, q.docId])).toEqual([
      ['agent-riverbend-lead', BOARD_FEEDBACK_DOC_ID],
    ]);
    expect(
      r.handle.tasks.listQueuedComments(named).filter((q) => q.docId === BOARD_FEEDBACK_DOC_ID),
    ).toEqual([]);
  });
});
