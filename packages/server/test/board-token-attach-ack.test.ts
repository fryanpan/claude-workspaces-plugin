/**
 * A walled lead attaches itself to its own board and sends the receipt for a
 * comment queued for it there, and does neither on another board.
 *
 * The lead is driven over its board's socket as the node relay drives it, so
 * its REST calls carry the board token the server holds for the session and
 * go through `board-agent-door.ts` as a lead. `attach_agent` posts
 * `/workspaces/<id>/agents` and then acks each queued comment row it was
 * handed. Before `lead-scope.ts` named those two paths, both answered
 * `out_of_board_token_scope` on the lead's own board, so every row came back
 * after each grace window.
 *
 * All fixtures synthetic; port 0; a short socket folder.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardSocketPath } from '../src/board-sockets.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const AGENT = 'Harborlight Lead';
/** The id the server derives from that name for the session's board token. */
const AGENT_ID = 'agent-harborlight-lead';
const json = { 'content-type': 'application/json' };
let h: ServerHandle;
let dataDir: string;
let workDir: string;
let socketRoot: string;
let socketDir: string;
let harbor: string;
let river: string;

const tcp = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${h.port}${path}`, {
    ...init,
    headers: { ...json, host: `localhost:${h.port}`, ...(init.headers ?? {}) },
  });
const on = (board: string, path: string, init: RequestInit = {}) =>
  fetch(`http://board${path}`, {
    ...init,
    unix: boardSocketPath(socketDir, board),
    headers: { ...json, ...(init.headers ?? {}) },
  } as RequestInit);

/** An MCP session opened on `boardId`'s socket, as the node relay opens one. */
async function session(boardId: string) {
  const headers = {
    ...json,
    accept: 'application/json, text/event-stream',
    'x-cw-agent': AGENT,
    'x-cw-cwd': workDir,
  };
  const rpc = (id: number, method: string, params: unknown, sid?: string) =>
    on(boardId, '/mcp', {
      method: 'POST',
      headers: sid ? { ...headers, 'mcp-session-id': sid } : headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
  const init = await rpc(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '0' },
  });
  expect(init.status, await init.clone().text()).toBe(200);
  const sid = init.headers.get('mcp-session-id') ?? '';
  let id = 1;
  return async (name: string, args: Record<string, unknown>) => {
    id += 1;
    const res = await rpc(id, 'tools/call', { name, arguments: args }, sid);
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    const text = (body.result?.content ?? []).map((c) => c.text ?? '').join('\n');
    return { isError: body.result?.isError === true, text };
  };
}

const TEXT = 'Tighten the harbour paragraph.';
const OTHER_AGENT = 'agent-riverbend-builder';

const row = (agentId: string) => ({
  agentId,
  docId: 'plan-doc',
  threadId: 'th-1',
  event: 'thread.created',
  author: { id: 'known-reviewer', name: 'Alice' },
  text: TEXT,
  payload: { event: 'thread.created', docId: 'plan-doc', threadId: 'th-1' },
});

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'board-token-ack-'));
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'board-token-ack-work-')));
  socketRoot = mkdtempSync(
    process.platform === 'darwin' ? '/private/tmp/bta-' : join(tmpdir(), 'bta-'),
  );
  socketDir = join(socketRoot, 'boards');
  h = createServer({ port: 0, dataDir, boardSocketDir: socketDir });
  const board = async (name: string) =>
    (
      (await (
        await tcp('/workspaces', {
          method: 'POST',
          body: JSON.stringify({ name, leadAgentId: AGENT_ID }),
        })
      ).json()) as { workspace: { id: string } }
    ).workspace.id;
  harbor = await board('Harborlight');
  river = await board('Riverbend');
});

afterAll(async () => {
  await h.stop();
  for (const d of [dataDir, workDir, socketRoot]) rmSync(d, { recursive: true, force: true });
});

const queued = (ws: string) => h.tasks.listQueuedComments(ws).map((q) => q.agentId);

describe('a walled lead’s attach and comment receipt', () => {
  it('attaches and clears its row on its own board, and is refused another', async () => {
    h.tasks.queueComment(harbor, row(AGENT_ID));
    h.tasks.queueComment(river, row(AGENT_ID));
    const call = await session(harbor);

    const own = await call('attach_agent', { workspaceId: harbor, subscribe: false });
    expect(own.isError, own.text).toBe(false);
    expect(own.text).toContain(TEXT);
    expect(h.tasks.listAttachments(harbor).map((a) => a.agentId)).toContain(AGENT_ID);
    // The receipt reached the queue: the row is gone.
    expect(queued(harbor)).toEqual([]);

    const other = await call('attach_agent', { workspaceId: river, subscribe: false });
    expect(other.isError, other.text).toBe(true);
    expect(other.text).toContain('403');
    expect(h.tasks.listAttachments(river).map((a) => a.agentId)).not.toContain(AGENT_ID);
    expect(queued(river)).toEqual([AGENT_ID]);
  }, 30_000);

  it('an acked row is not offered again', async () => {
    const call = await session(harbor);
    // Its own: a fresh row is handed over and acked, and the next attach
    // hands nothing, because the receipt removed it rather than marking it.
    h.tasks.queueComment(harbor, row(AGENT_ID));
    const first = await call('attach_agent', { workspaceId: harbor, subscribe: false });
    expect(first.text).toContain(TEXT);
    expect(queued(harbor)).toEqual([]);
    const again = await call('attach_agent', { workspaceId: harbor, subscribe: false });
    expect(again.isError, again.text).toBe(false);
    expect(again.text).not.toContain(TEXT);
  }, 30_000);

  it('does not attach another agent on its own board', async () => {
    const call = await session(harbor);
    const r = await call('attach_agent', {
      workspaceId: harbor,
      agentId: OTHER_AGENT,
      subscribe: false,
    });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain('403');
    expect(h.tasks.listAttachments(harbor).map((a) => a.agentId)).not.toContain(OTHER_AGENT);
  }, 30_000);
});
