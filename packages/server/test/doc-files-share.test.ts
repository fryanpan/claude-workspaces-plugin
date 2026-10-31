/**
 * A doc's folder files through a share link: a visitor in the board's
 * audience reads the page beside a doc on the shared board; a visitor outside
 * the audience reads nothing, and a member reads nothing beside a doc on a
 * board that was not shared. The member's read is the control, so each
 * refusal is the audience and not a broken link.
 *
 * Built on the share-link configuration `attachment-privacy-share.test.ts`
 * uses: a share hostname behind its own Access application, and `cf-ray` on
 * every call that crossed the edge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ShareTarget, shareScopeAllows } from '../src/middleware/host-guard.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'doc-files-share-kid';
const SHARE_AUD = 'aud-share-app';
const OWNER_AUD = 'aud-owner-app';
const SHARE_HOST = 'share.harborlight.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const MEMBER = 'bob@riverbend.example';
const OUTSIDER = 'alice@saltmarsh.example';

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

describe('a doc folder file through a share link', () => {
  let handle: ServerHandle;
  let root: string;
  let base: string;
  let shared: string;
  let unshared: string;

  const req = (path: string, host: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
    });
  const postLocal = async (path: string, body: unknown) => {
    const r = await req(path, `localhost:${handle.port}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(r.status, await r.clone().text()).toBe(200);
    return r;
  };
  const asVisitor = async (email: string, path: string) =>
    req(path, SHARE_HOST, {
      headers: { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(SHARE_AUD, email) },
    });
  const filePath = (board: string, doc: string) =>
    `/workspaces/${encodeURIComponent(board)}/docs/${doc}/files/map.html`;

  const bindDoc = async (board: string, name: string) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'doc.md'), `# ${name}\n\n::html{src="map.html"}\n`);
    writeFileSync(join(dir, 'map.html'), `<!doctype html><h1>${name} map</h1>`);
    await postLocal(`/workspaces/${board}/docs`, {
      docId: name.toLowerCase(),
      type: 'markdown',
      sourceUrl: join(dir, 'doc.md'),
    });
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'doc-files-share-'));
    handle = createServer({
      port: 0,
      dataDir: join(root, 'data'),
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    });
    base = `http://127.0.0.1:${handle.port}`;
    const boardOf = async (name: string) =>
      ((await (await postLocal('/workspaces', { name })).json()) as { workspace: { id: string } })
        .workspace.id;
    shared = await boardOf('Harborlight board');
    unshared = await boardOf('Riverbend board');
    await bindDoc(shared, 'Harborlight');
    await bindDoc(unshared, 'Riverbend');
    handle.shareLinks.addToAudience(shared, [MEMBER], 'Bryan');
    const minted = await postLocal('/api/share/workspace', { workspaceId: shared });
    const linkId = ((await minted.json()) as { link: { linkId: string } }).link.linkId;
    expect((await asVisitor(MEMBER, `/s/${linkId}`)).status).toBe(302);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('CONTROL: a visitor in the audience reads the page beside a shared doc', async () => {
    const r = await asVisitor(MEMBER, filePath(shared, 'harborlight'));
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Harborlight map');
  });

  it('gives a visitor outside the audience nothing', async () => {
    const r = await asVisitor(OUTSIDER, filePath(shared, 'harborlight'));
    expect(r.status).not.toBe(200);
    expect(await r.text()).not.toContain('Harborlight map');
  });

  it('gives a member nothing beside a doc on a board that was not shared', async () => {
    const r = await asVisitor(MEMBER, filePath(unshared, 'riverbend'));
    expect(r.status).not.toBe(200);
    expect(await r.text()).not.toContain('Riverbend map');
  });
});

describe('share scope for a doc’s folder files', () => {
  const BOARD: ShareTarget = { workspaceId: 'ws-1' };
  const owners = (id: string) => (id === 'harborlight' ? ['ws-1'] : []);

  it('admits a read on a doc the share admits, and nothing else', () => {
    const p = '/workspaces/ws-1/docs/harborlight/files/map.html';
    expect(shareScopeAllows(p, 'GET', BOARD, owners)).toBe(true);
    expect(shareScopeAllows(p, 'HEAD', BOARD, owners)).toBe(true);
    expect(shareScopeAllows(p, 'POST', BOARD, owners)).toBe(false);
    expect(
      shareScopeAllows('/workspaces/ws-1/docs/riverbend/files/map.html', 'GET', BOARD, owners),
    ).toBe(false);
    expect(
      shareScopeAllows('/workspaces/ws-2/docs/harborlight/files/map.html', 'GET', BOARD, owners),
    ).toBe(false);
  });
});
