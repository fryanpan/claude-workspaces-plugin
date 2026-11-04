/**
 * A board token works its own board's docs, and no other board's
 * (`middleware/board-doc-edit-scope.ts`, `middleware/lead-scope.ts`).
 *
 * A. A walled lead, driven over its board's socket as the node relay drives
 *    it. Its REST calls carry the board token the server holds for the
 *    session, so they go through `board-agent-door.ts` as a lead. Each of
 *    read_doc_outline, find_and_replace, apply_block_edits, attach_markdown,
 *    create_thread and post_reply succeeds on a Harborlight doc and is
 *    refused on a Riverbend doc.
 * B. An operator-minted token for Harborlight, presented over loopback TCP,
 *    which is not a lead. The same doc reads and edits succeed on its own
 *    board and answer 403 on Riverbend; a file bind, which a member cannot
 *    make either, stays refused.
 *
 * The bind needs the contained file calls (`tree-fs.ts`, macOS on arm64), so
 * it skips elsewhere. All fixtures synthetic; port 0; a short socket folder.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardSocketPath } from '../src/board-sockets.ts';
import { boardDocEditAllows } from '../src/middleware/board-doc-edit-scope.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { treeFsMode } from '../src/tree-fs.ts';
import { waitFor, waitForFile } from './wait-for.ts';

const CONTAINED = treeFsMode() === 'contained';
const AGENT = 'Harborlight Lead';

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
let riverThread: string;
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

async function openThread(ws: string, docId: string): Promise<string> {
  const res = await tcp(`/workspaces/${ws}/docs/${docId}/threads`, {
    method: 'POST',
    body: JSON.stringify({
      author: { id: 'known-reviewer', name: 'Alice', kind: 'known', color: '#2e7dd7' },
      text: 'A question on the plan.',
      anchor: { kind: 'subject' },
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { thread: { id: string } }).thread.id;
}

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
  dataDir = mkdtempSync(join(tmpdir(), 'board-token-docs-'));
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'board-token-docs-work-')));
  socketRoot = mkdtempSync(
    process.platform === 'darwin' ? '/private/tmp/btd-' : join(tmpdir(), 'btd-'),
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
  riverThread = await openThread(riverbend, riverDoc);
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

const content = async (ws: string, docId: string) =>
  (await (await tcp(`/workspaces/${ws}/docs/${docId}/content`)).text()) as string;

describe('A. a walled lead works its own board’s docs over its socket', () => {
  it('reads the outline of its own doc, and is refused another board’s', async () => {
    const call = await session(harborlight);
    const own = await call('read_doc_outline', { workspaceId: harborlight, docId: harborDoc });
    expect(own.isError, own.text).toBe(false);
    expect(own.text).toContain('harbor-plan');
    const other = await call('read_doc_outline', { workspaceId: riverbend, docId: riverDoc });
    expect(other.isError).toBe(true);
    expect(other.text).toContain('403');
  }, 30_000);

  it('find_and_replace edits its own doc, and is refused another board’s', async () => {
    const call = await session(harborlight);
    const own = await call('find_and_replace', {
      workspaceId: harborlight,
      docId: harborDoc,
      find: 'First line',
      replace: 'Edited line',
    });
    expect(own.isError, own.text).toBe(false);
    expect(await content(harborlight, harborDoc)).toContain('Edited line');
    const other = await call('find_and_replace', {
      workspaceId: riverbend,
      docId: riverDoc,
      find: 'First line',
      replace: 'Overwritten',
    });
    expect(other.isError).toBe(true);
    expect(other.text).toContain('403');
    expect(await content(riverbend, riverDoc)).not.toContain('Overwritten');
  }, 30_000);

  it('apply_block_edits appends to its own doc, and is refused another board’s', async () => {
    const call = await session(harborlight);
    const edits = [{ op: 'insert_at_end', markdown: 'Appended by the lead.' }];
    const own = await call('apply_block_edits', {
      workspaceId: harborlight,
      docId: harborDoc,
      edits,
    });
    expect(own.isError, own.text).toBe(false);
    expect(await content(harborlight, harborDoc)).toContain('Appended by the lead.');
    const other = await call('apply_block_edits', {
      workspaceId: riverbend,
      docId: riverDoc,
      edits,
    });
    expect(other.isError).toBe(true);
    expect(other.text).toContain('403');
    expect(await content(riverbend, riverDoc)).not.toContain('Appended by the lead.');
  }, 30_000);

  it('create_thread and post_reply comment on its own doc, and are refused another board’s', async () => {
    const call = await session(harborlight);
    const opened = await call('create_thread', {
      workspaceId: harborlight,
      docId: harborDoc,
      text: 'A note from the lead.',
    });
    expect(opened.isError, opened.text).toBe(false);
    const threadId = (JSON.parse(opened.text) as { thread: { id: string } }).thread.id;
    const reply = await call('post_reply', {
      workspaceId: harborlight,
      docId: harborDoc,
      threadId,
      text: 'And a reply.',
    });
    expect(reply.isError, reply.text).toBe(false);

    const otherOpen = await call('create_thread', {
      workspaceId: riverbend,
      docId: riverDoc,
      text: 'Not my board.',
    });
    expect(otherOpen.isError).toBe(true);
    expect(otherOpen.text).toContain('403');
    const otherReply = await call('post_reply', {
      workspaceId: riverbend,
      docId: riverDoc,
      threadId: riverThread,
      text: 'Not my board.',
    });
    expect(otherReply.isError).toBe(true);
    expect(otherReply.text).toContain('403');
  }, 30_000);

  it.skipIf(!CONTAINED)(
    'attach_markdown binds a file under its folders onto its own board only',
    async () => {
      const call = await session(harborlight);
      const path = join(inside, 'lead-notes.md');
      writeFileSync(path, '# Lead notes\n\nWritten by the lead.\n');
      const own = await call('attach_markdown', {
        workspaceId: harborlight,
        docId: 'lead-notes',
        path,
      });
      expect(own.isError, own.text).toBe(false);
      const boundId = (JSON.parse(own.text) as { docId: string }).docId;
      expect(await content(harborlight, boundId)).toContain('Written by the lead.');

      const otherBoard = await call('attach_markdown', {
        workspaceId: riverbend,
        docId: 'lead-notes-river',
        path,
      });
      expect(otherBoard.isError).toBe(true);
      expect(otherBoard.text).toContain('403');

      // A file outside every folder registered for its board.
      const outsidePath = join(workDir, 'river-project', 'private.md');
      writeFileSync(outsidePath, '# Private\n\nNot the lead’s.\n');
      const outside = await call('attach_markdown', {
        workspaceId: harborlight,
        docId: 'not-the-leads',
        path: outsidePath,
      });
      expect(outside.isError).toBe(true);
      expect(outside.text).toContain('403');
      expect(outside.text).not.toContain('Not the lead’s.');
    },
    30_000,
  );

  // On prod a walled lead's get_doc on its own bound doc parked it for good:
  // the doc was out of memory, the hydrate read the file off the main thread,
  // and the bind that followed refused the read's bytes for a guarded path.
  it.skipIf(treeFsMode() === 'refuse')(
    'a doc hydrated by get_doc binds again, and its edit reaches the file',
    async () => {
      const path = join(inside, 'reload-plan.md');
      const docId = await makeDoc(harborlight, 'reload-plan', inside);
      await waitFor(() => h.docStore.boundPathOf(docId) !== undefined, {
        describe: 'the new doc to bind',
      });
      expect(h.docStore.evictDoc(docId)).toBe(true);

      const call = await session(harborlight);
      const got = await call('get_doc', { workspaceId: harborlight, docId });
      expect(got.isError, got.text).toBe(false);
      await waitFor(() => h.docStore.boundPathOf(docId) !== undefined, {
        describe: 'the hydrated doc to bind again by itself',
      });
      expect(h.docStore.getDocStatus(docId)?.sourceParked).toBeUndefined();

      const edit = await call('find_and_replace', {
        workspaceId: harborlight,
        docId,
        find: 'First line',
        replace: 'Rebound line',
      });
      expect(edit.isError, edit.text).toBe(false);
      expect(edit.text).not.toContain('still being read');
      await waitForFile(path, (text) => text.includes('Rebound line of the body.'));
    },
    30_000,
  );
});

describe('B. an operator-minted board token, not a lead', () => {
  let token: string;
  beforeAll(async () => {
    const res = await tcp('/api/board-tokens', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'agent-harbor', boardId: harborlight, label: 'test' }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    token = ((await res.json()) as { token: string }).token;
  });
  const as = (path: string, init: RequestInit = {}) =>
    tcp(path, { ...init, headers: { authorization: `Bearer ${token}` } });
  const post = (path: string, body: unknown) =>
    as(path, { method: 'POST', body: JSON.stringify(body) });
  const author = { id: 'agent-harbor', name: 'Harbor agent', kind: 'agent', color: '#888888' };

  it('reads and edits its own board’s doc, and is refused the same calls on another board', async () => {
    const calls: Array<(ws: string, doc: string) => Promise<Response>> = [
      (ws, doc) => as(`/workspaces/${ws}/docs/${doc}/outline`),
      (ws, doc) =>
        post(`/workspaces/${ws}/docs/${doc}/find_and_replace`, {
          find: 'body',
          replace: 'body, again',
        }),
      (ws, doc) =>
        post(`/workspaces/${ws}/docs/${doc}/block_edits`, {
          edits: [{ op: 'insert_at_end', markdown: 'From a minted token.' }],
          author,
        }),
      (ws, doc) =>
        post(`/workspaces/${ws}/docs/${doc}/threads`, {
          author,
          text: 'From a minted token.',
          anchor: { kind: 'subject' },
        }),
    ];
    for (const [i, call] of calls.entries()) {
      const own = await call(harborlight, harborDoc);
      expect(own.status, `call ${i}: ${await own.clone().text()}`).toBe(200);
      const other = await call(riverbend, riverDoc);
      expect(other.status, `call ${i}`).toBe(403);
      // Another board's doc, spelled under its own board's id.
      const spelled = await call(harborlight, riverDoc);
      expect([403, 404], `call ${i}`).toContain(spelled.status);
    }
    expect(await content(riverbend, riverDoc)).not.toContain('From a minted token.');
  });

  it('still cannot bind a file — a member cannot either', async () => {
    const path = join(inside, 'minted.md');
    writeFileSync(path, '# Minted\n');
    const res = await post(`/workspaces/${harborlight}/docs`, {
      docId: 'minted',
      type: 'markdown',
      sourceUrl: path,
    });
    expect(res.status).toBe(403);
  });
});

describe('C. the scope rule itself', () => {
  const owners: Record<string, string[]> = { 'd-harbor': ['w-harbor'], 'd-river': ['w-river'] };
  const of = (id: string) => owners[id] ?? [];
  const allows = (path: string, method: string) => boardDocEditAllows(path, method, 'w-harbor', of);

  it('admits each named verb on its board’s doc, with its one method', () => {
    for (const [verb, method] of [
      ['outline', 'GET'],
      ['find_and_replace', 'POST'],
      ['block_edits', 'POST'],
      ['delete_block_at_anchor', 'POST'],
      ['delete_blocks_in_range', 'POST'],
      ['delete_section', 'POST'],
      ['agent_anchors', 'POST'],
      ['agent_anchors/a-1/edit', 'POST'],
      ['agent_anchors/a-1/insert_blocks', 'POST'],
      ['agent_anchors/a-1', 'DELETE'],
    ] as const) {
      expect(allows(`/workspaces/w-harbor/docs/d-harbor/${verb}`, method), verb).toBe(true);
      expect(allows(`/workspaces/w-harbor/docs/d-harbor/${verb}`, 'PUT'), verb).toBe(false);
      // Another board's doc, under either board's id.
      expect(allows(`/workspaces/w-river/docs/d-river/${verb}`, method), verb).toBe(false);
      expect(allows(`/workspaces/w-harbor/docs/d-river/${verb}`, method), verb).toBe(false);
    }
  });

  it('refuses the operator verbs and anything it does not name', () => {
    for (const [verb, method] of [
      ['content', 'POST'],
      ['reparse_from_disk', 'POST'],
      ['archive', 'POST'],
      ['unarchive', 'POST'],
      ['agent_anchors/a-1/edit/more', 'POST'],
      ['constructor', 'GET'],
    ] as const) {
      expect(allows(`/workspaces/w-harbor/docs/d-harbor/${verb}`, method), verb).toBe(false);
    }
    expect(allows('/workspaces/w-harbor/docs/d-harbor', 'DELETE')).toBe(false);
    expect(allows('/workspaces/w-harbor/docs', 'POST')).toBe(false);
  });
});
