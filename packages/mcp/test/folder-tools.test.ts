/**
 * The Library folder verbs reach peers, and reach the routes the server
 * serves. The harness runs the committed bundle as a real MCP server against
 * a recording stub, so what is asserted is the declaration a client receives
 * and the request the handler actually made.
 *
 * All fixtures synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, startBundle } from './harness/mcp-bundle.ts';

let mcp: BundleHarness;

beforeAll(async () => {
  mcp = await startBundle(() => ({ ok: true, folders: [] }));
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

const sent = async (name: string, args: Record<string, unknown>) => {
  const res = await mcp.call(name, args);
  return res.sent.map((r) => ({ method: r.method, path: r.path, body: r.body }));
};

describe('the Library folder tools', () => {
  it('POSITIVE CONTROL: the running bundle serves a known tool', () => {
    expect(mcp.tool('list_agents')).toBeDefined();
    expect(mcp.tool('a_tool_that_was_never_declared')).toBeUndefined();
  });

  it('are declared, each addressed to a board', () => {
    for (const name of [
      'list_folders',
      'create_folder',
      'rename_folder',
      'move_folder',
      'archive_folder',
      'unarchive_folder',
      'move_doc_to_folder',
    ]) {
      expect(mcp.tool(name)?.inputSchema?.required, name).toContain('workspaceId');
    }
  });

  it('call the folder routes with what the caller passed', async () => {
    const W = { workspaceId: 'w-1' };
    expect(await sent('create_folder', { ...W, name: 'Plans' })).toContainEqual({
      method: 'POST',
      path: '/workspaces/w-1/library/folders',
      body: { name: 'Plans', parentId: null },
    });
    expect(
      await sent('rename_folder', { ...W, folderId: 'f-1', name: 'Riverbend' }),
    ).toContainEqual({
      method: 'POST',
      path: '/workspaces/w-1/library/folders/f-1/rename',
      body: { name: 'Riverbend' },
    });
    expect(await sent('move_folder', { ...W, folderId: 'f-1', parentId: 'f-2' })).toContainEqual({
      method: 'POST',
      path: '/workspaces/w-1/library/folders/f-1/move',
      body: { parentId: 'f-2' },
    });
    const archived = await sent('archive_folder', { ...W, folderId: 'f-1' });
    expect(archived.map((r) => `${r.method} ${r.path}`)).toContain(
      'POST /workspaces/w-1/library/folders/f-1/archive',
    );
    const back = await sent('unarchive_folder', { ...W, folderId: 'f-1' });
    expect(back.map((r) => `${r.method} ${r.path}`)).toContain(
      'POST /workspaces/w-1/library/folders/f-1/unarchive',
    );
    expect(await sent('move_doc_to_folder', { ...W, docId: 'd-1', folderId: null })).toContainEqual(
      {
        method: 'PUT',
        path: '/workspaces/w-1/library/docs/d-1/folder',
        body: { folderId: null },
      },
    );
    const listed = await sent('list_folders', W);
    expect(listed.map((r) => `${r.method} ${r.path}`)).toContain(
      'GET /workspaces/w-1/library/folders',
    );
  });

  it('refuses a folder verb with no folder, before any request', async () => {
    const res = await mcp.call('archive_folder', { workspaceId: 'w-1' });
    expect(res.text).toContain('needs a folderId');
    expect(res.sent.some((r) => r.path.includes('/library/folders/'))).toBe(false);
  });
});
