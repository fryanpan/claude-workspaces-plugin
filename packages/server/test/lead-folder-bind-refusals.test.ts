/**
 * What a board's lead may not bind through `POST /workspaces` on its own
 * socket (`refuseLeadBind`, `routes/workspaces-create-read.ts`). The route
 * holds the body to a folder bind on the lead's own board, under a root
 * registered for that board, with no set id, no shareable privacy and a
 * bounded scan. Each refusal is a 403 naming `out_of_lead_scope`, and none
 * leaves a set behind.
 *
 * The refusals are judged before any file is read, so this suite runs on
 * every platform. A bind that passes them reads the folder through
 * `tree-fs.ts`, and `walled-folder-bind.test.ts` covers that half on macOS.
 * Fixtures synthetic, temp dirs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardSocketPath } from '../src/board-sockets.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

let h: ServerHandle;
let dataDir: string;
let workDir: string;
let socketRoot: string;
let socketDir: string;
let base: string;
let harborlight: string;
let riverbend: string;
let ownRoot: string;
let elsewhere: string;

const json = { 'content-type': 'application/json' };
const tcp = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { ...json, ...(init.headers ?? {}) } });

async function board(name: string): Promise<string> {
  const res = await tcp('/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
  return ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

/** `POST /workspaces` as Harborlight's lead, on its board socket. */
async function leadBind(body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  const res = await fetch('http://board/workspaces', {
    method: 'POST',
    unix: boardSocketPath(socketDir, harborlight),
    headers: json,
    body: JSON.stringify(body),
  } as RequestInit);
  return { status: res.status, json: await res.json() };
}

function folder(name: string): string {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'notes.md'), `# ${name}\n`);
  return dir;
}

async function setCount(): Promise<number> {
  const res = await tcp(`/workspaces/${harborlight}/attachments?archived=true`);
  const listed = (await res.json()) as { archived: unknown[] };
  const live = await tcp(`/workspaces/${harborlight}?format=json`);
  const docIds = ((await live.json()) as { workspace: { docIds?: string[] } }).workspace.docIds;
  return listed.archived.length + (docIds?.length ?? 0);
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'lead-bind-refusals-'));
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'lead-bind-refusals-work-')));
  socketRoot = mkdtempSync(
    process.platform === 'darwin' ? '/private/tmp/lbr-' : join(tmpdir(), 'lbr-'),
  );
  socketDir = join(socketRoot, 'boards');
  h = createServer({ port: 0, dataDir, boardSocketDir: socketDir });
  base = `http://127.0.0.1:${h.port}`;
  harborlight = await board('Harborlight');
  riverbend = await board('Riverbend');
  ownRoot = folder('harborlight-project');
  elsewhere = folder('saltmarsh-project');
  const roots = await tcp(`/api/board-sockets/${harborlight}/roots`, {
    method: 'PUT',
    body: JSON.stringify({ roots: [ownRoot] }),
  });
  expect(roots.status).toBe(200);
});

afterAll(async () => {
  await h.stop();
  for (const d of [dataDir, workDir, socketRoot]) rmSync(d, { recursive: true, force: true });
});

describe('a lead’s POST /workspaces is refused when it', () => {
  const cases: Array<[string, () => Record<string, unknown>, string]> = [
    ['creates a board', () => ({ name: 'Another' }), 'not create a board'],
    [
      'binds onto another board',
      () => ({ folderPath: ownRoot, hubWorkspaceId: riverbend }),
      'its own board only',
    ],
    [
      'names a set id',
      () => ({ folderPath: ownRoot, hubWorkspaceId: harborlight, setId: 'set-1' }),
      're-file an attachment set',
    ],
    [
      'names a set id by its old name',
      () => ({ folderPath: ownRoot, hubWorkspaceId: harborlight, workspaceId: 'set-1' }),
      're-file an attachment set',
    ],
    [
      'asks for a shareable set',
      () => ({ folderPath: ownRoot, hubWorkspaceId: harborlight, privacy: 'workspace' }),
      'may not make it shareable',
    ],
    [
      'asks the scan for no files',
      () => ({ folderPath: ownRoot, hubWorkspaceId: harborlight, maxFiles: 0 }),
      'maxFiles is a whole number',
    ],
    [
      'asks the scan for too many files',
      () => ({ folderPath: ownRoot, hubWorkspaceId: harborlight, maxFiles: 5_001 }),
      'maxFiles is a whole number',
    ],
    [
      'binds a folder under no root of its board',
      () => ({ folderPath: elsewhere, hubWorkspaceId: harborlight }),
      'folders registered for its board',
    ],
  ];

  for (const [what, body, says] of cases) {
    it(what, async () => {
      const before = await setCount();
      const r = await leadBind(body());
      expect(r.status).toBe(403);
      const refusal = r.json as { error: string; message: string };
      expect(refusal.error).toBe('out_of_lead_scope');
      expect(refusal.message).toContain(says);
      expect(await setCount()).toBe(before);
    });
  }
});
