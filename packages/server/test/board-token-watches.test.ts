/**
 * A walled lead's watches are saved on the server, on its own board only.
 *
 * A. The lead, driven over its board's socket as the node relay drives it.
 *    Its REST calls carry the board token the server holds for the session,
 *    so `/api/agents/<id>/watches` is judged by `board-agent-door.ts` and
 *    `routes/agent-identity.ts`'s `boardWatches`. watch_doc, unwatch_doc and
 *    list_watched_docs (and a second session's restore) see the saved set; a
 *    markdown file the lead attaches is in it by its real id; another board's doc is
 *    refused and never saved.
 * B. An operator-minted board token over loopback TCP: its own set on its own
 *    board, no other agent's set, no other board's key.
 *
 * All fixtures synthetic; port 0; a short socket folder.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardSocketPath } from '../src/board-sockets.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { treeFsMode } from '../src/tree-fs.ts';

const CONTAINED = treeFsMode() === 'contained';
const AGENT = 'Harborlight Lead';
const AGENT_ID = 'agent-harborlight-lead';

let h: ServerHandle;
let dataDir: string;
let workDir: string;
let socketRoot: string;
let socketDir: string;
let base: string;
let harborlight: string;
let riverbend: string;
let harborDoc: string;
let riverDoc: string;
let inside: string;

const json = { 'content-type': 'application/json' };

const tcp = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { ...json, host: `localhost:${h.port}`, ...(init.headers ?? {}) },
  });

const on = (board: string, path: string, init: RequestInit = {}) =>
  fetch(`http://board${path}`, {
    ...init,
    unix: boardSocketPath(socketDir, board),
    headers: { ...json, ...(init.headers ?? {}) },
  } as RequestInit);

async function board(name: string): Promise<string> {
  const res = await tcp('/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
  return ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

async function makeDoc(ws: string, alias: string, dir: string): Promise<string> {
  const path = join(dir, `${alias}.md`);
  writeFileSync(path, `# ${alias}\n\nFirst line of the body.\n`);
  const res = await tcp(`/workspaces/${ws}/docs`, {
    method: 'POST',
    body: JSON.stringify({ docId: alias, sourceUrl: path, title: alias }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { docId: string }).docId;
}

/** The keys the server holds for an agent, as its store reads them. */
const saved = (agentId = AGENT_ID) =>
  h.agentWatches.list(agentId, () => true).watches.map((w) => w.key);

/** An MCP session opened on `boardId`'s socket, as the node relay opens one. */
async function session(boardId: string) {
  const headers = {
    ...json,
    accept: 'application/json, text/event-stream',
    'x-cw-agent': AGENT,
    'x-cw-cwd': workDir,
  };
  const init = await on(boardId, '/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    }),
  });
  expect(init.status, await init.clone().text()).toBe(200);
  const sid = init.headers.get('mcp-session-id') ?? '';
  let id = 1;
  return async (name: string, args: Record<string, unknown>) => {
    id += 1;
    const res = await on(boardId, '/mcp', {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sid },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    const text = (body.result?.content ?? []).map((c) => c.text ?? '').join('\n');
    return { isError: body.result?.isError === true, text };
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'board-token-watches-'));
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'board-token-watches-work-')));
  socketRoot = mkdtempSync(
    process.platform === 'darwin' ? '/private/tmp/btw-' : join(tmpdir(), 'btw-'),
  );
  socketDir = join(socketRoot, 'boards');
  h = createServer({ port: 0, dataDir, boardSocketDir: socketDir });
  base = `http://127.0.0.1:${h.port}`;
  harborlight = await board('Harborlight');
  riverbend = await board('Riverbend');
  inside = join(workDir, 'harbor-project');
  const elsewhere = join(workDir, 'river-project');
  for (const dir of [inside, elsewhere]) mkdirSync(dir, { recursive: true });
  harborDoc = await makeDoc(harborlight, 'harbor-plan', inside);
  riverDoc = await makeDoc(riverbend, 'river-plan', elsewhere);
  const roots = await tcp(`/api/board-sockets/${harborlight}/roots`, {
    method: 'PUT',
    body: JSON.stringify({ roots: [inside] }),
  });
  expect(roots.status, await roots.clone().text()).toBe(200);
});

afterAll(async () => {
  await h.stop();
  for (const d of [dataDir, workDir, socketRoot]) rmSync(d, { recursive: true, force: true });
});

describe('A. a walled lead saves its watches on its own board', () => {
  it('watch_doc saves its own doc, a restarted session gets it back, unwatch_doc removes it', async () => {
    const call = await session(harborlight);
    const watched = await call('watch_doc', { workspaceId: harborlight, docId: harborDoc });
    expect(watched.isError, watched.text).toBe(false);
    expect(JSON.parse(watched.text).persisted).toBe(true);
    expect(saved()).toContain(harborDoc);

    // A restart is a new session under the same agent: it restores the set.
    const again = await session(harborlight);
    const listed = await again('list_watched_docs', {});
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.text).toContain(harborDoc);

    const dropped = await again('unwatch_doc', { workspaceId: harborlight, docId: harborDoc });
    expect(dropped.isError, dropped.text).toBe(false);
    expect(JSON.parse(dropped.text).persisted).toBe(true);
    expect(saved()).not.toContain(harborDoc);
  }, 30_000);

  it('refuses to save a watch on another board’s doc', async () => {
    const call = await session(harborlight);
    const other = await call('watch_doc', { workspaceId: riverbend, docId: riverDoc });
    expect(JSON.parse(other.text).persisted).toBe(false);
    expect(saved()).not.toContain(riverDoc);
  }, 30_000);

  it.skipIf(!CONTAINED)(
    'a markdown file it attaches is saved by its real id',
    async () => {
      const call = await session(harborlight);
      const path = join(inside, 'lead-watch.md');
      writeFileSync(path, '# Lead watch\n\nWritten by the lead.\n');
      const made = await call('attach_markdown', {
        workspaceId: harborlight,
        docId: 'lead-watch',
        path,
      });
      expect(made.isError, made.text).toBe(false);
      const docId = (JSON.parse(made.text) as { docId: string }).docId;
      expect(saved()).toContain(docId);
    },
    30_000,
  );
});

describe('B. an operator-minted board token reaches its own set only', () => {
  let token: string;
  beforeAll(async () => {
    const res = await tcp('/api/board-tokens', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'agent-harbor', boardId: harborlight, label: 'test' }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    token = ((await res.json()) as { token: string }).token;
    // Another agent's set, holding a key on this very board.
    h.agentWatches.update('agent-other', { add: [harborDoc] });
  });
  const as = (path: string, init: RequestInit = {}) =>
    tcp(path, { ...init, headers: { authorization: `Bearer ${token}` } });
  const post = (agentId: string, body: unknown) =>
    as(`/api/agents/${agentId}/watches`, { method: 'POST', body: JSON.stringify(body) });

  it('adds, lists and removes its own board’s key', async () => {
    expect((await post('agent-harbor', { add: [harborDoc] })).status).toBe(200);
    expect(saved('agent-harbor')).toContain(harborDoc);
    const listed = await as('/api/agents/agent-harbor/watches');
    expect(listed.status).toBe(200);
    const keys = ((await listed.json()) as { watches: Array<{ key: string }> }).watches;
    expect(keys.map((w) => w.key)).toContain(harborDoc);
    expect((await post('agent-harbor', { remove: [harborDoc] })).status).toBe(200);
    expect(saved('agent-harbor')).not.toContain(harborDoc);
  });

  it('refuses another board’s key, and saves nothing', async () => {
    const res = await post('agent-harbor', { add: [harborDoc, riverDoc] });
    expect(res.status).toBe(403);
    expect(saved('agent-harbor')).not.toContain(riverDoc);
    expect(saved('agent-harbor')).not.toContain(harborDoc);
  });

  it('never reads or changes another agent’s set', async () => {
    expect((await as('/api/agents/agent-other/watches')).status).toBe(403);
    expect((await post('agent-other', { remove: [harborDoc] })).status).toBe(403);
    expect((await post('agent-other', { add: [harborDoc] })).status).toBe(403);
    expect(saved('agent-other')).toEqual([harborDoc]);
  });
});
