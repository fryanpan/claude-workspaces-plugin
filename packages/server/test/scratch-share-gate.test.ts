/**
 * A board holding a `scratch/` doc is never shared, and a shared board never
 * takes a `scratch/` doc.
 *
 * Driven through the real routes on a server with sharing configured. Every
 * refusal is paired with the same call succeeding where it should: an
 * ordinary board shares, and the scratch doc that cannot go on the shared
 * board binds fine on a private one.
 *
 * All fixtures synthetic; port 0; no production server is touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

interface Refusal {
  error: string;
  workspaceId?: string;
  docId?: string;
  title?: string;
  path?: string;
  hint?: string;
}

describe('the scratch/ share gate', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let fixtures: string;
  let base: string;
  /** Shared in beforeAll: the control that an ordinary board still shares. */
  let shared: string;
  /** Never shared: where the scratch doc is allowed to live. */
  let privateBoard: string;
  let scratchFile: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const board = async (id: string) =>
    (
      (await (
        await fetch(`${base}/workspaces/${id}?format=json`, {
          headers: { host: `localhost:${handle.port}` },
        })
      ).json()) as { workspace?: { docIds: string[] }; docIds?: string[] }
    ).workspace?.docIds ?? [];
  const makeBoard = async (name: string) =>
    ((await (await post('/workspaces', { name })).json()) as { workspace: { id: string } })
      .workspace.id;
  const bindDoc = (ws: string, docId: string, path: string) =>
    post(`/workspaces/${ws}/docs`, { docId, sourceUrl: path, title: docId });
  const mint = (ws: string) => post('/api/share/workspace', { workspaceId: ws });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'scratch-gate-'));
    fixtures = mkdtempSync(join(tmpdir(), 'scratch-gate-fixtures-'));
    // The sharing setup board-lock.test.ts uses: a share-link host and its
    // Access audience. No visitor signs in here, so the key only has to exist.
    const { publicKey } = await generateKeyPair('RS256');
    const jwk = (await exportJWK(publicKey)) as JWK;
    jwk.kid = 'scratch-gate-kid';
    const jwks: JSONWebKeySet = { keys: [jwk] };
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: 'test.cloudflareaccess.com', audience: 'aud-owner-app', jwks },
      shareLinkHosts: ['share.harborlight.test'],
      shareLinkAudience: 'aud-share-app',
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    });
    base = `http://127.0.0.1:${handle.port}`;
    mkdirSync(join(fixtures, 'repo', 'scratch'), { recursive: true });
    mkdirSync(join(fixtures, 'repo', 'docs'), { recursive: true });
    scratchFile = join(fixtures, 'repo', 'scratch', 'outreach.md');
    writeFileSync(scratchFile, '# Outreach\n\nSaltmarsh research.\n');
    writeFileSync(join(fixtures, 'repo', 'docs', 'plan.md'), '# Plan\n\nHarborlight.\n');
    writeFileSync(join(fixtures, 'repo', 'README.md'), '# Harborlight\n');

    shared = await makeBoard('Harborlight board');
    privateBoard = await makeBoard('Riverbend private');
    const ordinary = await bindDoc(
      shared,
      'harborlight-plan',
      join(fixtures, 'repo', 'docs', 'plan.md'),
    );
    expect(ordinary.status, await ordinary.clone().text()).toBe(200);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fixtures, { recursive: true, force: true });
  });

  it('CONTROL: an ordinary board shares', async () => {
    const r = await mint(shared);
    expect(r.status, await r.clone().text()).toBe(200);
  });

  it('refuses to bind a scratch/ path on the shared board, naming the doc, and binds nothing', async () => {
    const r = await bindDoc(shared, 'saltmarsh-outreach', scratchFile);
    expect(r.status).toBe(403);
    const body = (await r.json()) as Refusal;
    expect(body.error).toBe('scratch_doc_on_shared_board');
    expect(body.workspaceId).toBe(shared);
    expect(body.docId).toBe('saltmarsh-outreach');
    expect(body.path).toBe(scratchFile);
    expect(body.hint).toContain('saltmarsh-outreach');
    expect((await board(shared)).some((id) => id.includes('saltmarsh'))).toBe(false);
  });

  it('CONTROL: the same scratch/ path binds on a board that is not shared', async () => {
    const r = await bindDoc(privateBoard, 'saltmarsh-outreach', scratchFile);
    expect(r.status, await r.clone().text()).toBe(200);
  });

  it('refuses to share a board holding a scratch/ doc, naming the doc, on both mint routes', async () => {
    const r = await mint(privateBoard);
    expect(r.status).toBe(403);
    const body = (await r.json()) as Refusal;
    expect(body.error).toBe('board_holds_scratch_doc');
    expect(body.workspaceId).toBe(privateBoard);
    expect(body.title).toBe('saltmarsh-outreach');
    expect(body.path).toBe(scratchFile);
    expect(body.hint).toContain('saltmarsh-outreach');

    const link = await post('/api/share/link', {
      workspaceId: privateBoard,
      allowDomains: ['@riverbend.example'],
    });
    expect(link.status).toBe(403);
    expect(((await link.json()) as Refusal).error).toBe('board_holds_scratch_doc');
  });

  it('refuses to attach an existing scratch/ doc onto the shared board', async () => {
    const docIds = await board(privateBoard);
    const scratchDocId = docIds[0] ?? '';
    expect(scratchDocId).not.toBe('');
    const r = await post(`/workspaces/${shared}/docs:attach`, { docId: scratchDocId });
    expect(r.status).toBe(403);
    const body = (await r.json()) as Refusal;
    expect(body.error).toBe('scratch_doc_on_shared_board');
    expect(body.docId).toBe(scratchDocId);
    expect((await board(shared)).includes(scratchDocId)).toBe(false);
  });

  it('refuses a folder bind on the shared board that holds a scratch/ file, binding nothing', async () => {
    const before = await board(shared);
    const r = await post('/workspaces', {
      folderPath: join(fixtures, 'repo'),
      hubWorkspaceId: shared,
    });
    expect(r.status).toBe(403);
    const body = (await r.json()) as Refusal;
    expect(body.error).toBe('scratch_doc_on_shared_board');
    expect(body.path).toBe('scratch/outreach.md');
    expect(body.hint).toContain('scratch/');
    expect(await board(shared)).toEqual(before);
  });

  it('refuses to share a board whose folder holds a scratch/ file nobody has opened yet', async () => {
    const lazy = await makeBoard('Riverbend folder');
    const bound = await post('/workspaces', {
      folderPath: join(fixtures, 'repo'),
      hubWorkspaceId: lazy,
    });
    expect(bound.status, await bound.clone().text()).toBe(200);
    const r = await mint(lazy);
    expect(r.status).toBe(403);
    const body = (await r.json()) as Refusal;
    expect(body.error).toBe('board_holds_scratch_doc');
    expect(body.path).toBe('scratch/outreach.md');
  });

  it('refuses a folder browse rooted in scratch/ on the shared board', async () => {
    const r = await post(`/workspaces/${shared}/attachments`, {
      repo: join(fixtures, 'repo', 'scratch'),
    });
    expect(r.status).toBe(403);
    const body = (await r.json()) as Refusal;
    expect(body.error).toBe('scratch_doc_on_shared_board');
    expect(body.path).toBe(join(fixtures, 'repo', 'scratch'));
  });
  it('refuses to open a scratch/ file created after its folder went onto the shared board', async () => {
    const late = join(fixtures, 'later');
    mkdirSync(join(late, 'docs'), { recursive: true });
    writeFileSync(join(late, 'docs', 'notes.md'), '# Notes\n\nHarborlight.\n');
    const bound = await post('/workspaces', { folderPath: late, hubWorkspaceId: shared });
    expect(bound.status, await bound.clone().text()).toBe(200);
    const res = (await bound.json()) as { setId?: string; workspaceId?: string };
    const setId = res.setId ?? res.workspaceId ?? '';
    const open = (relPath: string) =>
      post(`/workspaces/${shared}/attachments/${encodeURIComponent(setId)}/context-file`, {
        relPath,
      });

    const ordinary = await open('docs/notes.md');
    expect(ordinary.status, await ordinary.clone().text()).toBe(200);

    mkdirSync(join(late, 'scratch'), { recursive: true });
    writeFileSync(join(late, 'scratch', 'later.md'), '# Later\n\nSaltmarsh.\n');
    const r = await open('scratch/later.md');
    expect(r.status).toBe(403);
    const body = (await r.json()) as Refusal;
    expect(body.error).toBe('scratch_doc_on_shared_board');
    expect(body.path).toBe('scratch/later.md');
  });
});
