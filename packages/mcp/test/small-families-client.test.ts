/**
 * The folder, component, person, whiteboard, inbox and chat-attachment tools
 * call the server through the typed client, over the contracts beside
 * `packages/server/src/routes/route-contract.ts`.
 *
 * The cases record what reached `http`: the same method, path and body the
 * hand-spelled paths sent, ids percent-encoded as before, and no key for a
 * field the caller left out. `typeProbes` never runs; `bun run typecheck`
 * compiles it, and each `@ts-expect-error` fails the typecheck if the line
 * under it stops being an error.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  docComponentsClient,
  inboxClient,
  leadChatFilesClient,
  libraryFoldersClient,
  personClient,
  whiteboardClient,
} from '../src/server-client.ts';
import { readChatAttachment } from '../src/tools/chat-attachment.ts';
import { handleComponentTool } from '../src/tools/components.ts';
import { handleFolderTool } from '../src/tools/folders.ts';
import { handleInboxTool } from '../src/tools/inbox.ts';
import { handlePersonTool } from '../src/tools/person.ts';
import { handleWhiteboardTool } from '../src/tools/whiteboard.ts';

const AUTHOR = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
const SIGNED = { id: 'agent-harborlight', name: 'Harborlight site', color: '#123456' };
const B = '/workspaces/w-1';

type Call = [string, string, unknown];
type Tool = (
  name: string,
  a: Record<string, unknown>,
  ctx: never,
) => Promise<{ content: Array<{ type: string; text?: string }> } | undefined>;

function recorder(answer: unknown) {
  const calls: Call[] = [];
  const ctx = {
    http: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return answer;
    },
    ok: (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    err: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
    AUTHOR,
    suggestionAuthor: () => SIGNED,
    watchDoc: async () => true,
  };
  /** The tool's answer, parsed. */
  const run = async (tool: Tool, name: string, args: Record<string, unknown>) => {
    const out = await tool(name, { workspaceId: 'w-1', ...args }, ctx as never);
    return JSON.parse(out?.content[0]?.text ?? 'null') as Record<string, unknown>;
  };
  return { calls, run };
}

/** Each recorded body's keys, sorted; `[]` for no body. */
const keysOf = (calls: Call[]) =>
  calls.map(([, , body]) => (body === undefined ? [] : Object.keys(body as object).sort()));

describe('the folder tools, through the typed client', () => {
  it('sends each verb where the hand-spelled path did', async () => {
    const r = recorder({ ok: true, folders: [] });
    const folder = handleFolderTool as unknown as Tool;
    await r.run(folder, 'list_folders', {});
    await r.run(folder, 'create_folder', { name: 'Riverbend', parentId: 'f-0' });
    await r.run(folder, 'create_folder', { name: 'Saltmarsh' });
    await r.run(folder, 'rename_folder', { folderId: 'f 1', name: 'Saltmarsh' });
    await r.run(folder, 'move_folder', { folderId: 'f 1', parentId: '' });
    await r.run(folder, 'archive_folder', { folderId: 'f 1' });
    await r.run(folder, 'unarchive_folder', { folderId: 'f 1' });
    await r.run(folder, 'move_doc_to_folder', { docId: 'd 1', folderId: 'f-2' });
    const F = `${B}/library/folders`;
    expect(r.calls).toEqual([
      ['GET', F, undefined],
      ['POST', F, { name: 'Riverbend', parentId: 'f-0' }],
      ['POST', F, { name: 'Saltmarsh', parentId: null }],
      ['POST', `${F}/f%201/rename`, { name: 'Saltmarsh' }],
      ['POST', `${F}/f%201/move`, { parentId: null }],
      ['POST', `${F}/f%201/archive`, undefined],
      ['POST', `${F}/f%201/unarchive`, undefined],
      ['PUT', `${B}/library/docs/d%201/folder`, { folderId: 'f-2' }],
    ]);
  });

  it('refuses a missing folder id before any call', async () => {
    const r = recorder({});
    await expect(r.run(handleFolderTool as unknown as Tool, 'archive_folder', {})).rejects.toThrow(
      'archive_folder needs a folderId',
    );
    expect(r.calls).toEqual([]);
  });
});

describe('the component tools, through the typed client', () => {
  it('sends each call where the hand-spelled path did, signed', async () => {
    const r = recorder({ ok: true });
    const tool = handleComponentTool as unknown as Tool;
    await r.run(tool, 'list_components', { docId: 'd 1' });
    await r.run(tool, 'get_component_state', { docId: 'd 1', componentId: 'c-1' });
    await r.run(tool, 'get_component_state', { docId: 'd 1', componentId: 'c-1', path: 'a b' });
    await r.run(tool, 'set_component_state', { docId: 'd 1', componentId: 'c-1', ops: [1] });
    await r.run(tool, 'place_component', { docId: 'd 1', importPath: './x', props: {} });
    await r.run(tool, 'place_component', {
      docId: 'd 1',
      importPath: './x',
      name: 'Chart',
      props: {},
      headingId: 'h-1',
    });
    await r.run(tool, 'request_component_grant', {
      docId: 'd 1',
      folder: 'charts',
      taskId: 't-1',
      why: 'Alice asked',
    });
    const D = `${B}/docs/d%201`;
    expect(r.calls).toEqual([
      ['GET', `${D}/agent-components`, undefined],
      ['GET', `${D}/agent-components/c-1/state`, undefined],
      ['GET', `${D}/agent-components/c-1/state?path=a+b`, undefined],
      ['POST', `${D}/agent-components/c-1/state`, { ops: [1], author: SIGNED }],
      ['POST', `${D}/agent-components/place`, { importPath: './x', props: {}, author: SIGNED }],
      [
        'POST',
        `${D}/agent-components/place`,
        { importPath: './x', name: 'Chart', props: {}, headingId: 'h-1', author: SIGNED },
      ],
      [
        'POST',
        `${D}/component-grants`,
        { folder: 'charts', taskId: 't-1', why: 'Alice asked', author: SIGNED },
      ],
    ]);
    expect(keysOf(r.calls)[4]).toEqual(['author', 'importPath', 'props']);
  });
});

describe('the person tools, through the typed client', () => {
  it('watches and shows, and reads the landing and the spot', async () => {
    const r = recorder({ ok: true, watching: true, landing: { path: '/x' }, spot: { s: 1 } });
    const tool = handlePersonTool as unknown as Tool;
    expect(await r.run(tool, 'watch_person', {})).toEqual({
      watching: true,
      landing: { path: '/x' },
    });
    expect(await r.run(tool, 'show_person', { docId: ' d 1 ', scroll: 0.5, quote: '' })).toEqual({
      shown: true,
      spot: { s: 1 },
    });
    const who = { agentId: AUTHOR.id, agentName: AUTHOR.name };
    expect(r.calls).toEqual([
      ['POST', `${B}/person/watch`, { ...who, on: true }],
      ['POST', `${B}/person/show`, { ...who, docId: 'd 1', scroll: 0.5 }],
    ]);
  });

  it('confirms its person and replies, and reads the state and message id', async () => {
    const r = recorder({ ok: true, state: 'pending', message: { id: 'm-1' } });
    const tool = handlePersonTool as unknown as Tool;
    expect(await r.run(tool, 'confirm_person', { email: ' alice@example.invalid ' })).toEqual({
      ok: true,
      state: 'pending',
    });
    await r.run(tool, 'confirm_person', { email: null });
    expect(await r.run(tool, 'reply_private', { personId: 'p 1', text: ' Hi Bob ' })).toEqual({
      ok: true,
      messageId: 'm-1',
    });
    const A = `/api/agents/${AUTHOR.id}`;
    expect(r.calls).toEqual([
      ['POST', `${A}/person`, { email: 'alice@example.invalid' }],
      ['POST', `${A}/person`, { personId: null }],
      ['POST', `${A}/messages/p%201`, { text: 'Hi Bob' }],
    ]);
  });
});

describe('the whiteboard tools, through the typed client', () => {
  it('creates, draws and reads where the hand-spelled path did', async () => {
    const r = recorder({ docId: 'd-9', url: '/wb', meta: { reviewUrl: '/review' } });
    const tool = handleWhiteboardTool as unknown as Tool;
    expect(await r.run(tool, 'create_whiteboard', {})).toEqual({ docId: 'd-9', url: '/review' });
    await r.run(tool, 'create_whiteboard', { title: 'Saltmarsh plan' });
    await r.run(tool, 'draw_on_whiteboard', { docId: 'd 1', shapes: [] });
    await r.run(tool, 'draw_on_whiteboard', {
      docId: 'd 1',
      shapes: [{ kind: 'box' }],
      mode: 'replace',
      point: null,
    });
    await r.run(tool, 'get_whiteboard', { docId: 'd 1' });
    const W = `${B}/docs/d%201/whiteboard`;
    expect(r.calls).toEqual([
      ['POST', `${B}/whiteboards`, { author: AUTHOR }],
      ['POST', `${B}/whiteboards`, { title: 'Saltmarsh plan', author: AUTHOR }],
      ['POST', W, { shapes: [], author: AUTHOR }],
      ['POST', W, { shapes: [{ kind: 'box' }], mode: 'replace', point: null, author: AUTHOR }],
      ['GET', W, undefined],
    ]);
  });

  it('falls back to the page url when the answer carries no review url', async () => {
    const r = recorder({ docId: 'd-9', url: '/wb', meta: {} });
    const out = await r.run(handleWhiteboardTool as unknown as Tool, 'create_whiteboard', {});
    expect(out).toEqual({ docId: 'd-9', url: '/wb' });
  });
});

describe('post_inbox_rows, through the typed client', () => {
  it('sends the pass, and run or dismiss only when given', async () => {
    const r = recorder({ ok: true });
    const tool = handleInboxTool as unknown as Tool;
    await r.run(tool, 'post_inbox_rows', { pass: 'p-1', rows: [{ a: 1 }] });
    await r.run(tool, 'post_inbox_rows', { pass: 'p-2', run: 'r-1', dismiss: [{ x: 1 }] });
    expect(r.calls).toEqual([
      ['POST', '/inbox/rows', { agentId: AUTHOR.id, pass: 'p-1', rows: [{ a: 1 }] }],
      [
        'POST',
        '/inbox/rows',
        { agentId: AUTHOR.id, pass: 'p-2', rows: [], run: 'r-1', dismiss: [{ x: 1 }] },
      ],
    ]);
    expect(keysOf(r.calls)[0]).toEqual(['agentId', 'pass', 'rows']);
  });
});

describe('read_chat_attachment, through the typed client', () => {
  const root = mkdtempSync(join(tmpdir(), 'cw-small-families-test-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('asks for the base64 form at the encoded board path', async () => {
    const calls: Call[] = [];
    const file = { id: 'lf-AAAAaaaaBBBB', name: 'a.txt', type: 'text/plain', size: 2 };
    await readChatAttachment(
      {
        tempRoot: root,
        err: (message) => ({ isError: true, content: [{ type: 'text', text: message }] }),
        http: async (method, path, body) => {
          calls.push([method, path, body]);
          return { file, data: Buffer.from('hi').toString('base64') };
        },
      },
      'w 1',
      'lf-AAAAaaaaBBBB',
    );
    expect(calls).toEqual([
      ['GET', '/workspaces/w%201/lead-chat/files/lf-AAAAaaaaBBBB?encoding=base64', undefined],
    ]);
  });
});

/** Compiled by `bun run typecheck`, never run. */
async function typeProbes(http: never): Promise<void> {
  const ws = { ws: 'w-1' };
  const library = libraryFoldersClient(http).workspaces[':ws'].library;
  // @ts-expect-error -- a new folder's parent is `parentId`.
  await library.folders.$post({ param: ws, json: { name: 'x', parent: null } });
  await library.docs[':docId'].folder.$put({
    param: { ...ws, docId: 'd' },
    // @ts-expect-error -- a doc's folder is `folderId`.
    json: { folder: null },
  });
  const doc = docComponentsClient(http).workspaces[':ws'].docs[':docId'];
  await doc['component-grants'].$post({
    param: { ...ws, docId: 'd' },
    // @ts-expect-error -- the grant's reason is `why`.
    json: { folder: 'x', taskId: 't', reason: 'x', author: {} },
  });
  const person = personClient(http);
  await person.workspaces[':ws'].person.show.$post({
    param: ws,
    // @ts-expect-error -- the phrase to point at is `quote`.
    json: { agentId: 'a', phrase: 'x' },
  });
  const watched = await (
    await person.workspaces[':ws'].person.watch.$post({ param: ws, json: { agentId: 'a' } })
  ).json();
  // @ts-expect-error -- where the owner is now is `landing`.
  void watched.landed;
  const replied = await (
    await person.api.agents[':agentId'].messages[':personId'].$post({
      param: { agentId: 'a', personId: 'p' },
      json: { text: 'x' },
    })
  ).json();
  // @ts-expect-error -- the reply is `message`, with its `id`.
  void replied.messageId;
  const made = await (
    await whiteboardClient(http).workspaces[':ws'].whiteboards.$post({ param: ws, json: {} })
  ).json();
  // @ts-expect-error -- the board's review link is under `meta`.
  void made.reviewUrl;
  // @ts-expect-error -- a pass's rows are `rows`.
  await inboxClient(http).inbox.rows.$post({ json: { agentId: 'a', pass: 'p', items: [] } });
  const got = await (
    await leadChatFilesClient(http).workspaces[':ws']['lead-chat'].files[':id'].$get({
      param: { ...ws, id: 'f' },
      query: { encoding: 'base64' },
    })
  ).json();
  // @ts-expect-error -- the bytes are `data`.
  void got.bytes;
}
void typeProbes;
