/**
 * A walled lead keeps its board features over its board's own socket
 * (`middleware/lead-scope.ts`):
 *
 * A. The tools a member is refused — the doc list, a whole-doc rewrite, a
 *    folder bind and `post_status` — work for a session opened on
 *    Harborlight's socket, on Harborlight, and each is refused on Riverbend.
 *    A folder bind is held to the folders registered for the board.
 * B. The plugin hooks' notes and prompt marks, posted on the socket with no
 *    token, land on Harborlight and are refused on Riverbend.
 * C. A board closed to outside visitors still admits its own lead, on the
 *    socket and through the session's held token; an operator-minted token
 *    for the same board is still refused (the control).
 * D. The roots list is set over loopback only: the socket cannot set it.
 *
 * The session is driven over the socket as JSON-RPC, the way the node relay
 * sends it. All fixtures synthetic; port 0; a short socket folder.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardSocketPath } from '../src/board-sockets.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const AGENT = 'Harborlight Lead';
const PERSON = { id: 'known-reviewer', name: 'Alice', kind: 'known', color: '#2e7dd7' };

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
let harborTask: string;
let riverTask: string;
/** Inside the folder registered for Harborlight, and outside it. */
let inside: string;
let outside: string;

const json = { 'content-type': 'application/json' };

const tcp = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { ...json, ...(init.headers ?? {}) } });

/** A request on `board`'s own socket. */
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

async function makeDoc(ws: string, alias: string): Promise<string> {
  const path = join(workDir, `${alias}.md`);
  writeFileSync(path, `# ${alias}\n\nBody.\n`);
  const res = await tcp(`/workspaces/${ws}/docs`, {
    method: 'POST',
    body: JSON.stringify({ docId: alias, sourceUrl: path, title: alias }),
  });
  return ((await res.json()) as { docId: string }).docId;
}

async function makeTask(ws: string, title: string): Promise<string> {
  const res = await tcp(`/workspaces/${ws}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ title, assignee: 'human', author: PERSON }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { task: { id: string } }).task.id;
}

/** An MCP session opened on `board`'s socket, as the node relay opens one. */
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
  dataDir = mkdtempSync(join(tmpdir(), 'board-sock-lead-'));
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'board-sock-lead-work-')));
  socketRoot = mkdtempSync(
    process.platform === 'darwin' ? '/private/tmp/bsl-' : join(tmpdir(), 'bsl-'),
  );
  socketDir = join(socketRoot, 'boards');
  h = createServer({ port: 0, dataDir, boardSocketDir: socketDir });
  base = `http://127.0.0.1:${h.port}`;
  harborlight = await board('Harborlight');
  riverbend = await board('Riverbend');
  harborDoc = await makeDoc(harborlight, 'harbor-plan');
  riverDoc = await makeDoc(riverbend, 'river-plan');
  harborTask = await makeTask(harborlight, 'Harborlight task');
  riverTask = await makeTask(riverbend, 'Riverbend task');
  inside = join(workDir, 'harbor-project');
  outside = join(workDir, 'river-project');
  for (const dir of [inside, outside]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# Notes\n');
  }
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

describe('A. the tools a member is refused work for the lead on its own board', () => {
  it('list_docs lists its board, with no paths on this machine, and is refused another', async () => {
    const call = await session(harborlight);
    const own = await call('list_docs', { workspaceId: harborlight });
    expect(own.isError, own.text).toBe(false);
    expect(own.text).toContain(harborDoc);
    expect(own.text).not.toContain(riverDoc);
    expect(own.text).not.toContain(workDir);
    const other = await call('list_docs', { workspaceId: riverbend });
    expect(other.isError).toBe(true);
    expect(other.text).toContain('403');
  }, 30_000);

  it('set_doc_content rewrites its board’s doc, and is refused another board’s', async () => {
    const call = await session(harborlight);
    const own = await call('set_doc_content', {
      workspaceId: harborlight,
      docId: harborDoc,
      markdown: '# harbor-plan\n\nRewritten by the lead.\n',
      confirmOverwriteHumanEdits: true,
    });
    expect(own.isError, own.text).toBe(false);
    const read = await tcp(`/workspaces/${harborlight}/docs/${harborDoc}/content`);
    expect(await read.text()).toContain('Rewritten by the lead.');

    const other = await call('set_doc_content', {
      workspaceId: riverbend,
      docId: riverDoc,
      markdown: '# river-plan\n\nOverwritten.\n',
      confirmOverwriteHumanEdits: true,
    });
    expect(other.isError).toBe(true);
    // Another board's doc spelled under the lead's own board is refused too.
    const crossed = await call('set_doc_content', {
      workspaceId: harborlight,
      docId: riverDoc,
      markdown: '# river-plan\n\nOverwritten.\n',
      confirmOverwriteHumanEdits: true,
    });
    expect(crossed.isError).toBe(true);
    const river = await tcp(`/workspaces/${riverbend}/docs/${riverDoc}/content`);
    expect(await river.text()).not.toContain('Overwritten.');
  }, 30_000);

  it('attach_folder binds a folder inside its roots onto its board, and nowhere else', async () => {
    const call = await session(harborlight);
    const own = await call('attach_folder', {
      workspaceId: harborlight,
      folderPath: inside,
      subscribe: false,
    });
    expect(own.isError, own.text).toBe(false);
    expect(own.text).toContain(harborlight);

    const otherBoard = await call('attach_folder', {
      folderPath: inside,
      workspaceId: riverbend,
      subscribe: false,
    });
    expect(otherBoard.isError).toBe(true);
    expect(otherBoard.text).toContain('own board');

    const notARoot = await call('attach_folder', {
      workspaceId: harborlight,
      folderPath: outside,
      subscribe: false,
    });
    expect(notARoot.isError).toBe(true);
    expect(notARoot.text).toContain('not inside a folder');
    // A link inside the root that leads out of it is judged by where it leads.
    const link = join(inside, 'escape');
    (await import('node:fs')).symlinkSync(outside, link);
    const viaLink = await call('attach_folder', {
      workspaceId: harborlight,
      folderPath: link,
      subscribe: false,
    });
    expect(viaLink.isError).toBe(true);
  }, 30_000);

  it('refuses a board create and a set re-filed by id over the socket', async () => {
    const create = await on(harborlight, '/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Saltmarsh' }),
    });
    expect(create.status).toBe(403);
    const refile = await on(harborlight, '/workspaces', {
      method: 'POST',
      body: JSON.stringify({ folderPath: inside, hubWorkspaceId: harborlight, setId: 'rev-x' }),
    });
    expect(refile.status).toBe(403);
  });

  it('post_status lands on its board’s row, and is refused another board’s', async () => {
    const call = await session(harborlight);
    const own = await call('post_status', {
      workspaceId: harborlight,
      taskId: harborTask,
      text: 'Harborlight status',
    });
    expect(own.isError, own.text).toBe(false);
    const untargeted = await call('post_status', {
      workspaceId: harborlight,
      text: 'Harborlight untargeted',
    });
    expect(untargeted.isError, untargeted.text).toBe(false);
    const other = await call('post_status', {
      workspaceId: riverbend,
      taskId: riverTask,
      text: 'Riverbend status',
    });
    expect(other.isError).toBe(true);
    const otherUntargeted = await call('post_status', {
      workspaceId: riverbend,
      text: 'Riverbend untargeted',
    });
    expect(otherUntargeted.isError).toBe(true);
  }, 30_000);

  it('the control: an operator-minted board token is still a member, refused the doc list', async () => {
    const minted = await tcp('/api/board-tokens', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'agent-harborlight', boardId: harborlight }),
    });
    const { token } = (await minted.json()) as { token: string };
    const res = await tcp(`/workspaces/${harborlight}/docs?limit=5`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('B. the plugin hooks post over the socket', () => {
  const note = { kind: 'turn', text: 'Ended the turn.', at: Date.now() };
  const agentPath = (ws: string, verb: string) =>
    `/workspaces/${ws}/agents/${encodeURIComponent(AGENT)}/${verb}`;

  it('a turn note lands on its own board, and is refused another', async () => {
    const own = await on(harborlight, agentPath(harborlight, 'notes'), {
      method: 'POST',
      body: JSON.stringify(note),
    });
    expect(own.status, await own.clone().text()).toBe(202);
    const other = await on(harborlight, agentPath(riverbend, 'notes'), {
      method: 'POST',
      body: JSON.stringify(note),
    });
    expect(other.status).toBe(403);
  });

  it('a prompt mark lands on its own board, and is refused another', async () => {
    const mark = { typed: true, text: 'hello', at: Date.now() };
    const own = await on(harborlight, agentPath(harborlight, 'prompts'), {
      method: 'POST',
      body: JSON.stringify(mark),
    });
    expect(own.status, await own.clone().text()).toBeLessThan(300);
    const other = await on(harborlight, agentPath(riverbend, 'prompts'), {
      method: 'POST',
      body: JSON.stringify(mark),
    });
    expect(other.status).toBe(403);
  });
});

describe('C. a board closed to outside visitors still admits its own lead', () => {
  it('on the socket and through its session, while an operator token is refused', async () => {
    const minted = await tcp('/api/board-tokens', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'agent-harborlight', boardId: harborlight }),
    });
    const { token } = (await minted.json()) as { token: string };
    const call = await session(harborlight);
    h.sharingGate.setBoardEnabled(harborlight, false);
    try {
      expect((await on(harborlight, `/workspaces/${harborlight}/tasks`)).status).toBe(200);
      const tasks = await call('list_tasks', { workspaceId: harborlight });
      expect(tasks.isError, tasks.text).toBe(false);
      expect(tasks.text).toContain(harborTask);
      // The control: the same board, a token held by somebody outside.
      const outsider = await tcp(`/workspaces/${harborlight}/tasks`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(outsider.status).toBe(403);
    } finally {
      h.sharingGate.setBoardEnabled(harborlight, true);
    }
  }, 30_000);
});

describe('D. the roots list', () => {
  it('cannot be set or read from the board’s own socket', async () => {
    const put = await on(harborlight, `/api/board-sockets/${harborlight}/roots`, {
      method: 'PUT',
      body: JSON.stringify({ roots: [outside] }),
    });
    expect(put.status).toBe(403);
    expect((await on(harborlight, `/api/board-sockets/${harborlight}/roots`)).status).toBe(403);
  });

  it('is kept mode 600 in the data folder, resolved, and refuses / and a missing folder', async () => {
    const file = join(dataDir, 'board-socket-roots.json');
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { boards: Record<string, string[]> };
    expect(stored.boards[harborlight]).toEqual([realpathSync(inside)]);
    const { statSync } = await import('node:fs');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const roots of [['/'], [join(workDir, 'nowhere')], ['relative/path'], 'x'])
      expect(
        (
          await tcp(`/api/board-sockets/${harborlight}/roots`, {
            method: 'PUT',
            body: JSON.stringify({ roots }),
          })
        ).status,
        JSON.stringify(roots),
      ).toBe(400);
  });
});
