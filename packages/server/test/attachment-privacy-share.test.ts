/**
 * A local-only folder, bound on a board that has a share link, read through
 * that link: refused. The same read of a shareable folder on the same board
 * succeeds, so the refusal is the privacy and not the link.
 *
 * Also the bind's answer: it names the set's privacy on every call, and a
 * caller that omitted the flag is told its folder is shareable.
 *
 * Built on the share-link configuration `sharing-switch.test.ts` uses: a
 * share hostname, the owner's proxied hostname behind Access, and `cf-ray`
 * on every call that crossed the edge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'attachment-privacy-kid';
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

interface BindAnswer {
  setId: string;
  privacy: string;
  privacyNote: string;
  files: Array<{ docId: string; path?: string }>;
}

describe('a local-only attachment set behind a share link', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let fixtures: string;
  let base: string;
  let board: string;
  let privateSet: BindAnswer;
  let openSet: BindAnswer;

  const req = (path: string, host: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
    });
  const postLocal = (path: string, body: unknown) =>
    req(path, `localhost:${handle.port}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const getLocal = (path: string) => req(path, `localhost:${handle.port}`);
  const onShareHost = async (path: string) =>
    req(path, SHARE_HOST, {
      headers: { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(SHARE_AUD, MEMBER) },
    });
  const onOwnerHost = async (path: string) =>
    req(path, OWNER_HOST, {
      headers: { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(OWNER_AUD, OWNER_EMAIL) },
    });

  const folder = (name: string, text: string) => {
    const dir = join(fixtures, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), `# ${name}\n\n${text}\n`);
    return dir;
  };
  const bind = async (path: string, extra: Record<string, unknown> = {}) => {
    const r = await postLocal('/workspaces', { folderPath: path, hubWorkspaceId: board, ...extra });
    expect(r.status, await r.clone().text()).toBe(200);
    return (await r.json()) as BindAnswer;
  };
  const filesPath = (set: BindAnswer) =>
    `/workspaces/${encodeURIComponent(board)}/attachments/${encodeURIComponent(set.setId)}/files`;
  const docPath = (set: BindAnswer) =>
    `/workspaces/${encodeURIComponent(board)}/docs/${encodeURIComponent(set.files[0]?.docId ?? '')}?format=json`;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'attachment-privacy-share-'));
    fixtures = mkdtempSync(join(tmpdir(), 'attachment-privacy-fixtures-'));
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
    const created = await postLocal('/workspaces', { name: 'Harborlight board' });
    board = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    privateSet = await bind(folder('Harborlight', 'Notes that stay on this machine.'), {
      privacy: 'local-only',
    });
    openSet = await bind(folder('Riverbend', 'Notes Bob may read.'));
    const minted = await postLocal('/api/share/workspace', { workspaceId: board });
    expect(minted.status, await minted.clone().text()).toBe(200);
    const linkId = ((await minted.json()) as { link: { linkId: string } }).link.linkId;
    expect((await onShareHost(`/s/${linkId}`)).status).toBe(302);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fixtures, { recursive: true, force: true });
  });

  describe('the bind answer', () => {
    it('names local-only when it was asked for', () => {
      expect(privateSet.privacy).toBe('local-only');
      expect(privateSet.privacyNote).toContain('local-only');
    });

    it('says shareable when the flag was omitted', () => {
      expect(openSet.privacy).toBe('workspace');
      expect(openSet.privacyNote).toContain('shareable');
    });

    it('keeps local-only when the same set is bound again without the flag', async () => {
      const again = await bind(join(fixtures, 'Harborlight'), { setId: privateSet.setId });
      expect(again.setId).toBe(privateSet.setId);
      expect(again.privacy).toBe('local-only');
    });

    it('refuses a misspelled privacy and binds nothing', async () => {
      const r = await postLocal('/workspaces', {
        folderPath: folder('Saltmarsh', 'Never bound.'),
        hubWorkspaceId: board,
        privacy: 'local_only',
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toContain('local-only');
    });
  });

  describe('reads through the share link', () => {
    it('CONTROL: the visitor reads the shareable folder', async () => {
      expect((await onShareHost(filesPath(openSet))).status).toBe(200);
      expect((await onShareHost(docPath(openSet))).status).toBe(200);
    });

    it("refuses the local-only folder's file list and its file", async () => {
      for (const path of [filesPath(privateSet), docPath(privateSet)]) {
        const r = await onShareHost(path);
        expect(r.status, path).toBe(403);
        expect(((await r.json()) as { error: string }).error).toBe('local_only');
      }
    });

    it('refuses the owner through the tunnel too, because the tunnel is off the box', async () => {
      expect((await onOwnerHost(filesPath(openSet))).status).toBe(200);
      const r = await onOwnerHost(filesPath(privateSet));
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: string }).error).toBe('local_only');
    });

    it('serves the local-only folder on the box', async () => {
      expect((await getLocal(filesPath(privateSet))).status).toBe(200);
      expect((await getLocal(docPath(privateSet))).status).toBe(200);
    });
  });
});
