/**
 * What a board's lead may not bind through `POST /workspaces`.
 *
 * `refuseLeadBind` (`routes/lead-bind-scope.ts`) judges the body. A bind
 * must be a folder bind on the lead's own board, under a root registered for
 * that board, with no set id, no shareable privacy and a bounded scan. On a
 * server without the contained file calls it refuses every lead bind first,
 * which is every platform but macOS on arm64.
 *
 * So the body's rules are driven here through the function, with the mode
 * passed in, and they run on every platform. The route's half is driven over
 * a real lead socket: the refusal reaches the lead as a 403 and leaves no set.
 * A bind that passes reads the folder through `tree-fs.ts`, which
 * `walled-folder-bind.test.ts` covers on macOS. Fixtures synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leadSetId } from '../src/board-socket-roots.ts';
import { boardSocketPath } from '../src/board-sockets.ts';
import { refuseLeadBind } from '../src/routes/lead-bind-scope.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const LEAD = 'w-harbor';
const ROOT = '/tmp/harborlight-project';
/** The board's one registered root, as `board-socket-roots.ts` would answer. */
const rootOf = (board: string, folder: string) =>
  board === LEAD && (folder === ROOT || folder.startsWith(`${ROOT}/`)) ? ROOT : null;
const judge = (body: Record<string, unknown> | null, mode: 'contained' | 'legacy' = 'contained') =>
  refuseLeadBind(LEAD, body, rootOf, mode);
const own = { folderPath: ROOT, hubWorkspaceId: LEAD };

describe('refuseLeadBind', () => {
  it('binds the board’s own root, under the set id the board owns', () => {
    expect(judge(own)).toEqual({ board: LEAD, root: ROOT, setId: leadSetId(ROOT, LEAD) });
    expect(judge({ ...own, privacy: 'local-only', maxFiles: 5_000 })).toMatchObject({
      root: ROOT,
    });
  });

  const refusals: Array<[string, Record<string, unknown> | null, string]> = [
    ['creates a board', { name: 'Riverbend' }, 'not create a board'],
    ['sends no body', null, 'not create a board'],
    ['binds onto another board', { ...own, hubWorkspaceId: 'w-river' }, 'its own board only'],
    ['names a set id', { ...own, setId: 'set-1' }, 're-file an attachment set'],
    ['names a set id by its old name', { ...own, workspaceId: 'set-1' }, 're-file'],
    ['asks for a shareable set', { ...own, privacy: 'workspace' }, 'may not make it shareable'],
    ['asks the scan for no files', { ...own, maxFiles: 0 }, 'maxFiles is a whole number'],
    ['asks for too many files', { ...own, maxFiles: 5_001 }, 'maxFiles is a whole number'],
    ['asks for part of a file', { ...own, maxFiles: 1.5 }, 'maxFiles is a whole number'],
    [
      'binds a folder under no root of its board',
      { ...own, folderPath: '/tmp/saltmarsh-project' },
      'folders registered for its board',
    ],
  ];
  for (const [what, body, says] of refusals) {
    it(`refuses a lead that ${what}`, () => {
      const r = judge(body) as { error: string; message: string };
      expect(r.error).toBe('out_of_lead_scope');
      expect(r.message).toContain(says);
    });
  }

  it('refuses even its own root where the contained calls are missing', () => {
    expect(judge(own, 'legacy')).toMatchObject({
      error: 'out_of_lead_scope',
      message: expect.stringContaining('needs the contained file calls'),
    });
  });

  it('refuses a caller that is no board’s lead', () => {
    expect(refuseLeadBind(null, own, rootOf, 'contained')).toMatchObject({
      message: expect.stringContaining('Only a board’s lead'),
    });
  });
});

describe('a lead’s POST /workspaces on its board socket', () => {
  let h: ServerHandle;
  let dataDir: string;
  let socketRoot: string;
  let socketDir: string;
  let board = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'lead-bind-refusals-'));
    socketRoot = mkdtempSync(
      process.platform === 'darwin' ? '/private/tmp/lbr-' : join(tmpdir(), 'lbr-'),
    );
    socketDir = join(socketRoot, 'boards');
    h = createServer({ port: 0, dataDir, boardSocketDir: socketDir });
    const res = await fetch(`http://127.0.0.1:${h.port}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Harborlight' }),
    });
    board = ((await res.json()) as { workspace: { id: string } }).workspace.id;
  });

  afterAll(async () => {
    await h.stop();
    for (const d of [dataDir, socketRoot]) rmSync(d, { recursive: true, force: true });
  });

  it('is refused as out of scope, and leaves no set behind', async () => {
    const res = await fetch('http://board/workspaces', {
      method: 'POST',
      unix: boardSocketPath(socketDir, board),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Riverbend' }),
    } as RequestInit);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('out_of_lead_scope');
    const live = await fetch(`http://127.0.0.1:${h.port}/workspaces/${board}?format=json`);
    const docIds = ((await live.json()) as { workspace: { docIds?: string[] } }).workspace.docIds;
    expect(docIds ?? []).toEqual([]);
  });
});
