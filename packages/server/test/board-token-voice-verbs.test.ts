/**
 * A walled lead answers aloud on its own board, and on no other.
 *
 * The lead is driven over its board's socket as the node relay drives it, so
 * its REST calls carry the board token the server holds for the session and
 * go through `board-agent-door.ts` as a lead. `answer_voice` and
 * `say_in_meeting` reach their routes on Harborlight, and are refused (403)
 * on Riverbend. Before `lead-scope.ts` named them, both answered
 * `out_of_board_token_scope` on the lead's own board too.
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

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'board-token-voice-'));
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'board-token-voice-work-')));
  socketRoot = mkdtempSync(
    process.platform === 'darwin' ? '/private/tmp/btv-' : join(tmpdir(), 'btv-'),
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
      ).json()) as {
        workspace: { id: string };
      }
    ).workspace.id;
  harbor = await board('Harborlight');
  river = await board('Riverbend');
  // The lead is attached to both boards, so a refusal on Riverbend is the
  // board token's scope and not a missing attachment.
  for (const ws of [harbor, river]) {
    const r = await tcp(`/workspaces/${ws}/agents`, {
      method: 'POST',
      body: JSON.stringify({ agentId: AGENT_ID, runtime: 'claude-code-local' }),
    });
    expect(r.status, await r.clone().text()).toBe(200);
  }
});

afterAll(async () => {
  await h.stop();
  for (const d of [dataDir, workDir, socketRoot]) rmSync(d, { recursive: true, force: true });
});

describe('a walled lead’s voice verbs', () => {
  it('answer_voice reaches its own board’s queue, and is refused another', async () => {
    const call = await session(harbor);
    const own = await call('answer_voice', { workspaceId: harbor, queueId: 'lc-1', text: 'Yes.' });
    expect(own.isError, own.text).toBe(false);
    expect(own.text).toContain('"delivered": false');
    const other = await call('answer_voice', { workspaceId: river, queueId: 'lc-1', text: 'Yes.' });
    expect(other.isError, other.text).toBe(true);
    expect(other.text).toContain('403');
  }, 30_000);

  it('say_in_meeting reaches its own board’s meeting, and is refused another', async () => {
    const call = await session(harbor);
    const own = await call('say_in_meeting', { workspaceId: harbor, text: 'Noted.' });
    // No meeting runs: the route's own refusal, answered rather than raised.
    expect(own.isError, own.text).toBe(false);
    expect(own.text).toContain('no-meeting');
    const other = await call('say_in_meeting', { workspaceId: river, text: 'Noted.' });
    expect(other.isError, other.text).toBe(true);
    expect(other.text).toContain('403');
  }, 30_000);
});
