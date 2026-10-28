/**
 * Every file a folder bind lists has a link that opens, before anybody has
 * opened it from the tree.
 *
 * A browse bind opens one doc, its entry, and every other file became a doc
 * only when the tree opened it. So a link to an unopened member — the page
 * for a recording a peer lead had just attached with `include` — answered
 * 404, while the entry png's link answered 200. The bind now answers with
 * `links`, a `url` for every listed file, and the first request to one opens
 * its doc. `files` still names only the entry: it is what the bind opened.
 *
 * Read through a share link as well, on the configuration
 * `attachment-privacy-share.test.ts` uses: a visitor whose share covers the
 * set opens an unopened member, and a local-only set's member stays refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { tinyMp4 } from './tiny-mp4.ts';
import { tinyPng } from './tiny-png.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'folder-member-links-kid';
const SHARE_AUD = 'aud-share-app';
const SHARE_HOST = 'share.harborlight.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const MEMBER = 'bob@riverbend.example';

const MP4_A = 'video-A-harborlight.mp4';
const MP4_B = 'video-B-riverbend.mp4';
const PNG_A = 'video-A-harborlight-lastframe.png';
const PNG_B = 'video-B-riverbend-lastframe.png';

interface BindAnswer {
  setId: string;
  listed: string[];
  files: Array<{ docId: string; relPath: string; reviewUrl: string }>;
  links: Array<{ docId: string; relPath: string; url: string }>;
}

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

describe('a link to a folder member nobody has opened', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let fixtures: string;
  let base: string;
  let board: string;
  let set: BindAnswer;
  let privateSet: BindAnswer;

  const req = (path: string, host: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
    });
  const getLocal = (path: string, headers: Record<string, string> = {}) =>
    req(path, `localhost:${handle.port}`, { headers });
  const onShareHost = async (path: string) =>
    req(path, SHARE_HOST, {
      headers: { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(SHARE_AUD, MEMBER) },
    });
  const postLocal = (path: string, body: unknown) =>
    req(path, `localhost:${handle.port}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  /** A repo ignoring `*.mp4`, and the folder of recordings inside it. */
  const repo = (name: string): string => {
    const root = join(fixtures, name);
    const dir = join(root, 'recordings');
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['-C', root, 'init', '-q']);
    writeFileSync(join(root, '.gitignore'), '*.mp4\n.env\n');
    writeFileSync(join(dir, MP4_A), tinyMp4(4096, 1));
    writeFileSync(join(dir, MP4_B), tinyMp4(4096, 2));
    writeFileSync(join(dir, PNG_A), tinyPng(40));
    writeFileSync(join(dir, PNG_B), tinyPng(90));
    writeFileSync(join(dir, '.env'), 'MARKER=not-a-credential\n');
    return dir;
  };
  const bind = async (folderPath: string, extra: Record<string, unknown> = {}) => {
    const r = await postLocal('/workspaces', { folderPath, hubWorkspaceId: board, ...extra });
    expect(r.status, await r.clone().text()).toBe(200);
    return (await r.json()) as BindAnswer;
  };
  const docOf = (s: BindAnswer, relPath: string) => {
    const f = s.links.find((x) => x.relPath === relPath);
    if (!f) throw new Error(`${relPath} is not in links`);
    return f;
  };
  const pathOf = (url: string) => new URL(url).pathname;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'member-links-'));
    fixtures = mkdtempSync(join(tmpdir(), 'member-links-fixtures-'));
    // A stand-in client build, so the page route has a shell to serve.
    const appDist = join(dataDir, 'app-dist');
    mkdirSync(appDist);
    writeFileSync(join(appDist, 'index.html'), '<!--shell-->\n');
    writeFileSync(join(appDist, 'app.js'), '//app\n');
    handle = createServer({
      port: 0,
      dataDir,
      markdownAppDistDir: appDist,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: 'aud-owner-app', jwks },
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    });
    base = `http://127.0.0.1:${handle.port}`;
    const created = await postLocal('/workspaces', { name: 'Harborlight board' });
    board = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    const include = [MP4_A, MP4_B];
    set = await bind(repo('recordings'), { include });
    privateSet = await bind(repo('private-recordings'), { include, privacy: 'local-only' });
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

  it('links every listed file, in listed order, and files names the entry it opened', () => {
    expect(set.listed).toEqual([PNG_A, MP4_A, PNG_B, MP4_B].sort());
    expect(set.links.map((l) => l.relPath)).toEqual(set.listed);
    expect(set.files.map((f) => f.relPath)).toEqual([PNG_A]);
    // The entry's link is the address its opened doc already has.
    expect(docOf(set, PNG_A).url).toBe(set.files[0]?.reviewUrl);
    for (const f of set.links) {
      expect(pathOf(f.url)).toBe(
        `/workspaces/${encodeURIComponent(board)}/docs/${encodeURIComponent(f.docId)}`,
      );
    }
  });

  it("opens an unopened recording's page and its doc from the link alone", async () => {
    const video = docOf(set, MP4_A);
    // Nobody opened it: only the entry is a doc yet.
    expect(handle.docStore.docExists(video.docId)).toBe(false);
    expect(handle.docStore.docExists(docOf(set, PNG_A).docId)).toBe(true);
    // CONTROL: the entry's page, which opened at bind time.
    expect((await getLocal(pathOf(docOf(set, PNG_A).url), { accept: 'text/html' })).status).toBe(
      200,
    );
    const page = await getLocal(pathOf(video.url), { accept: 'text/html' });
    expect(page.status).toBe(200);
    const meta = await getLocal(`${pathOf(video.url)}?format=json`);
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { meta: { relPath: string } }).meta.relPath).toBe(MP4_A);
  });

  it('opens nothing for a file the listing does not hold', async () => {
    const id = `${set.setId}:.env`;
    const r = await getLocal(
      `/workspaces/${encodeURIComponent(board)}/docs/${encodeURIComponent(id)}?format=json`,
    );
    expect(r.status).toBe(404);
    // A visitor gets the scope refusal: an id the listing does not hold is
    // in no workspace, so the share does not cover it.
    const visitor = await onShareHost(
      `/workspaces/${encodeURIComponent(board)}/docs/${encodeURIComponent(id)}?format=json`,
    );
    expect(visitor.status).toBe(403);
    expect(handle.docStore.docExists(id)).toBe(false);
  });

  it('opens an unopened member for a share visitor whose share covers the set', async () => {
    const f = docOf(set, MP4_B);
    expect(handle.docStore.docExists(f.docId)).toBe(false);
    const r = await onShareHost(`${pathOf(f.url)}?format=json`);
    expect(r.status, await r.clone().text()).toBe(200);
  });

  it("refuses a local-only set's unopened member off the box, and opens nothing", async () => {
    const f = docOf(privateSet, PNG_B);
    const r = await onShareHost(`${pathOf(f.url)}?format=json`);
    // Not opened, so answered as an id nothing holds.
    expect(r.status).toBe(404);
    expect(handle.docStore.docExists(f.docId)).toBe(false);
    // CONTROL: the same link opens on the box.
    expect((await getLocal(`${pathOf(f.url)}?format=json`)).status).toBe(200);
  });

  it('opens nothing for a listed file removed since the listing', async () => {
    const gone = await bind(repo('removed-recordings'), { include: [MP4_A, MP4_B] });
    const f = docOf(gone, PNG_B);
    rmSync(join(fixtures, 'removed-recordings', 'recordings', PNG_B));
    // The listing is still cached and holds the file; the open finds it gone.
    expect((await getLocal(`${pathOf(f.url)}?format=json`)).status).toBe(404);
    expect(handle.docStore.docExists(f.docId)).toBe(false);
    // CONTROL: an unopened file still there opens from the same set.
    const kept = docOf(gone, MP4_A);
    expect(handle.docStore.docExists(kept.docId)).toBe(false);
    expect((await getLocal(`${pathOf(kept.url)}?format=json`)).status).toBe(200);
  });

  it('opens every file the answer lists', async () => {
    for (const f of set.links) {
      const r = await getLocal(`${pathOf(f.url)}?format=json`);
      expect(r.status, f.relPath).toBe(200);
    }
  });
});
