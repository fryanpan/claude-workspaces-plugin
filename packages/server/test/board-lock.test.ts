/**
 * `POST /api/share/lock`: a board locked never-shareable from the box refuses
 * every share mint naming the lock, reads closed to the visitors it already
 * had, and cannot be unlocked from off the box.
 *
 * Each refusal is paired with the same call succeeding: minting works before
 * the lock and again after the unlock, and the visitor reads the board before
 * it is locked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'board-lock-kid';
const SHARE_AUD = 'aud-share-app';
const OWNER_AUD = 'aud-owner-app';
const SHARE_HOST = 'share.harborlight.test';
const OWNER_HOST = 'workspaces.harborlight.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const MEMBER = 'bob@riverbend.example';
const OWNER_EMAIL = 'owner@harborlight.test';

let jwks: JSONWebKeySet;
let signJwt: (aud: string, email: string) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  jwks = { keys: [publicJwk] };
  signJwt = (aud, email) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-visitor')
      .sign(privateKey);
});

interface Refusal {
  error: string;
  workspaceId?: string;
  hint?: string;
}

describe('a board locked never-shareable', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let fixtures: string;
  let base: string;
  let board: string;
  let other: string;
  let docId: string;
  let linkId: string;

  const req = (path: string, host: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
    });
  const json = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const postLocal = (path: string, body: unknown) =>
    req(path, `localhost:${handle.port}`, json(body));
  const postOwnerHost = async (path: string, body: unknown) =>
    req(path, OWNER_HOST, {
      ...json(body),
      headers: {
        'content-type': 'application/json',
        ...CF_RAY,
        'cf-access-jwt-assertion': await signJwt(OWNER_AUD, OWNER_EMAIL),
      },
    });
  const onShareHost = async (path: string, init: RequestInit = {}) =>
    req(path, SHARE_HOST, {
      ...init,
      headers: {
        ...((init.headers as Record<string, string>) ?? {}),
        ...CF_RAY,
        'cf-access-jwt-assertion': await signJwt(SHARE_AUD, MEMBER),
      },
    });
  const boardPath = (id: string) => `/workspaces/${encodeURIComponent(id)}?format=json`;
  const mintWorkspace = (id: string) => postLocal('/api/share/workspace', { workspaceId: id });
  const lock = (locked: boolean) =>
    postLocal('/api/share/lock', { workspaceId: board, locked, reason: 'private folder' });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'board-lock-'));
    fixtures = mkdtempSync(join(tmpdir(), 'board-lock-fixtures-'));
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
      proxiedTrustedHosts: [OWNER_HOST],
      proxiedTrustedEmails: [OWNER_EMAIL],
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    });
    base = `http://127.0.0.1:${handle.port}`;
    const makeBoard = async (name: string) =>
      ((await (await postLocal('/workspaces', { name })).json()) as { workspace: { id: string } })
        .workspace.id;
    board = await makeBoard('Harborlight board');
    other = await makeBoard('Riverbend board');
    const dir = join(fixtures, 'Harborlight');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# Harborlight\n\nNotes.\n');
    const bound = await postLocal('/workspaces', { folderPath: dir, hubWorkspaceId: board });
    docId = ((await bound.json()) as { files: Array<{ docId: string }> }).files[0]?.docId ?? '';
    expect(docId).not.toBe('');
    const minted = await mintWorkspace(board);
    expect(minted.status, await minted.clone().text()).toBe(200);
    linkId = ((await minted.json()) as { link: { linkId: string } }).link.linkId;
    expect((await onShareHost(`/s/${linkId}`)).status).toBe(302);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fixtures, { recursive: true, force: true });
  });

  it('CONTROL: before the lock the visitor reads the board', async () => {
    expect((await onShareHost(boardPath(board))).status).toBe(200);
  });

  it('is refused through the tunnel, even for the owner, and changes nothing', async () => {
    const r = await postOwnerHost('/api/share/lock', { workspaceId: board, locked: true });
    expect(r.status).toBe(403);
    expect(((await r.json()) as Refusal).error).toBe('lock_through_the_edge');
    expect((await mintWorkspace(board)).status).toBe(200);
  });

  it('locks from the box', async () => {
    const r = await lock(true);
    expect(r.status, await r.clone().text()).toBe(200);
    const body = (await r.json()) as {
      board: { workspaceId: string; locked: boolean; open: boolean };
      sharing: { lockedBoards?: string[] };
    };
    expect(body.board).toEqual({ workspaceId: board, locked: true, open: false });
    expect(body.sharing.lockedBoards).toEqual([board]);
  });

  it('refuses share_workspace, naming the lock', async () => {
    const r = await mintWorkspace(board);
    expect(r.status).toBe(403);
    const body = (await r.json()) as Refusal;
    expect(body.error).toBe('board_never_shareable');
    expect(body.workspaceId).toBe(board);
    expect(body.hint).toContain('locked never-shareable');
  });

  it('refuses a share link, naming the lock', async () => {
    const r = await postLocal('/api/share/link', {
      workspaceId: board,
      allowDomains: ['@riverbend.example'],
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as Refusal).error).toBe('board_never_shareable');
  });

  it('refuses share_doc on a doc of the board, naming the lock', async () => {
    const r = await postLocal('/api/share/doc', { docId });
    expect(r.status).toBe(403);
    const body = (await r.json()) as Refusal;
    expect(body.error).toBe('board_never_shareable');
    expect(body.workspaceId).toBe(board);
  });

  it('CONTROL: another board still mints', async () => {
    expect((await mintWorkspace(other)).status).toBe(200);
  });

  it('reads closed to the visitor it already had', async () => {
    const r = await onShareHost(boardPath(board));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'sharing_disabled' });
  });

  it('cannot be unlocked by a share visitor or through the tunnel', async () => {
    const asVisitor = await onShareHost('/api/share/lock', {
      ...json({ workspaceId: board, locked: false }),
    });
    expect(asVisitor.status).toBe(403);
    const asTunnel = await postOwnerHost('/api/share/lock', { workspaceId: board, locked: false });
    expect(asTunnel.status).toBe(403);
    expect(((await asTunnel.json()) as Refusal).error).toBe('lock_through_the_edge');
    expect((await mintWorkspace(board)).status).toBe(403);
  });

  it('is not undone by reopening the board with the sharing switch', async () => {
    const r = await postLocal('/api/share/enabled', { workspaceId: board, enabled: true });
    expect(r.status).toBe(200);
    expect((await mintWorkspace(board)).status).toBe(403);
    expect((await onShareHost(boardPath(board))).status).toBe(403);
  });

  it('unlocks from the box, and minting works again', async () => {
    expect((await lock(false)).status).toBe(200);
    expect((await mintWorkspace(board)).status).toBe(200);
    expect((await onShareHost(boardPath(board))).status).toBe(200);
  });

  it('refuses a board that does not exist', async () => {
    const r = await postLocal('/api/share/lock', { workspaceId: 'w-nope', locked: true });
    expect(r.status).toBe(404);
  });
});
