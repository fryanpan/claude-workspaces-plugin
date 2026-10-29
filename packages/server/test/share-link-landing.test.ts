/**
 * A share link lands on the thing it was made for, and the board's library
 * answers the people it lets in.
 *
 * Both were reported on 29 Sept from a private window: a share link opened,
 * the reader signed in as a member of the board, and landed on the board
 * rather than the resource they were sent — and the board's Library said it
 * could not load. These drive the real route table on the share hostname
 * with a genuine Access token, because both failures lived in the route
 * layer: the redeem route only ever redirected to the board, and the
 * Library's data route was on no member table.
 *
 * Every landing is asserted twice: where the redirect points, and that the
 * member can then open it. A redirect to a page the gate refuses would pass
 * the first check alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'share-landing-kid';
const SHARE_AUD = 'aud-for-the-share-app';
const OWNER_AUD = 'aud-for-the-owner-app';
const SHARE_HOST = 'share.example.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

const MEMBER = 'alice@example.com';
const STRANGER = 'bob@example.com';

let jwks: JSONWebKeySet;
let signJwt: (email: string) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  jwks = { keys: [publicJwk] };
  signJwt = (email) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(SHARE_AUD)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-share-visitor')
      .sign(privateKey);
});

describe('share link landing and the shared library', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let board: string;
  let otherBoard: string;
  let docId: string;
  let mockId: string;
  let appId: string;
  /** An app whose dev server IS running, so its host page is drawn. */
  let liveAppId: string;
  let devServer: ReturnType<typeof Bun.serve>;
  let taskId: string;
  let otherTaskId: string;
  let otherDocId: string;

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
  const onShareHost = async (path: string, email: string, init: RequestInit = {}) =>
    req(path, SHARE_HOST, {
      ...init,
      headers: {
        ...CF_RAY,
        'cf-access-jwt-assertion': await signJwt(email),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const mint = (workspaceId: string, landing?: unknown) => {
    handle.shareLinks.addToAudience(workspaceId, ['@example.com'], 'Bryan');
    return postLocal('/api/share/workspace', {
      workspaceId,
      ...(landing === undefined ? {} : { landing }),
    });
  };
  const mintLinkId = async (workspaceId: string, landing?: unknown): Promise<string> => {
    const r = await mint(workspaceId, landing);
    expect(r.status, await r.clone().text()).toBe(200);
    return ((await r.json()) as { link: { linkId: string } }).link.linkId;
  };

  const boardNamed = async (name: string): Promise<string> => {
    const r = await postLocal('/workspaces', { name });
    expect(r.status).toBe(200);
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  };
  const fileDoc = async (ws: string, name: string, type: 'markdown' | 'mockup') => {
    const path = join(dataDir, type === 'mockup' ? `${name}.html` : `${name}.md`);
    writeFileSync(
      path,
      type === 'mockup'
        ? '<!doctype html><html><head><title>Riverbend mock</title></head><body>Mock</body></html>'
        : `# ${name}\n\nBody.\n`,
    );
    const r = await postLocal(`/workspaces/${ws}/docs`, { docId: name, type, sourceUrl: path });
    expect(r.status, await r.clone().text()).toBe(200);
    const id = ((await r.json()) as { docId: string }).docId;
    const filed = await postLocal(`/workspaces/${ws}/docs:attach`, { docId: id });
    expect(filed.status, await filed.clone().text()).toBe(200);
    return id;
  };
  const fileTask = async (ws: string, title: string): Promise<string> => {
    const r = await postLocal(`/workspaces/${ws}/tasks`, { title, assignee: 'human' });
    expect(r.status, await r.clone().text()).toBe(200);
    return ((await r.json()) as { task: { id: string } }).task.id;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'share-landing-'));
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    });
    base = `http://127.0.0.1:${handle.port}`;
    board = await boardNamed('Harborlight launch');
    otherBoard = await boardNamed('Saltmarsh private');
    docId = await fileDoc(board, 'harborlight-plan', 'markdown');
    mockId = await fileDoc(board, 'riverbend-mock', 'mockup');
    otherDocId = await fileDoc(otherBoard, 'saltmarsh-notes', 'markdown');
    // An app whose dev server is not running: the waiting page answers, which
    // is all a landing needs to prove it is reachable.
    const app = await postLocal(`/workspaces/${board}/apps`, {
      docId: 'harborlight-site',
      origin: 'http://127.0.0.1:1/',
      title: 'Harborlight site',
    });
    expect(app.status, await app.clone().text()).toBe(200);
    appId = ((await app.json()) as { docId: string }).docId;
    devServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response('<!doctype html><title>Harborlight site</title><p>Running</p>', {
          headers: { 'content-type': 'text/html' },
        }),
    });
    const live = await postLocal(`/workspaces/${board}/apps`, {
      docId: 'harborlight-live',
      origin: `http://127.0.0.1:${devServer.port}/`,
      title: 'Harborlight live',
    });
    expect(live.status, await live.clone().text()).toBe(200);
    liveAppId = ((await live.json()) as { docId: string }).docId;
    taskId = await fileTask(board, 'Review the launch plan');
    otherTaskId = await fileTask(otherBoard, 'Private row');
  });

  afterAll(async () => {
    devServer.stop(true);
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('a link lands on the resource it names', () => {
    /**
     * Each row: the landing to mint, where the redirect must point, and the
     * read that proves the member may open what is there. The read is the
     * resource's DATA where its page is a built client shell, which this
     * suite does not build; the gate judges both addresses the same way.
     */
    const cases: Array<[string, () => unknown, () => string, () => string, number]> = [
      [
        'home',
        () => ({ kind: 'home' }),
        () => `/workspaces/${board}/home`,
        () => `/workspaces/${board}/home?format=json`,
        200,
      ],
      [
        'board',
        () => ({ kind: 'board' }),
        () => `/workspaces/${board}`,
        () => `/workspaces/${board}/tasks`,
        200,
      ],
      [
        'task',
        () => ({ kind: 'task', id: taskId }),
        () => `/workspaces/${board}?task=${encodeURIComponent(taskId)}`,
        () => `/workspaces/${board}/tasks/${encodeURIComponent(taskId)}/detail`,
        200,
      ],
      [
        'doc',
        () => ({ kind: 'doc', id: docId }),
        () => `/workspaces/${board}/docs/${encodeURIComponent(docId)}`,
        () => `/workspaces/${board}/docs/${encodeURIComponent(docId)}?format=json`,
        200,
      ],
      [
        'mockup',
        () => ({ kind: 'mockup', id: mockId }),
        () => `/workspaces/${board}/mockups/${encodeURIComponent(mockId)}`,
        () => `/workspaces/${board}/mockups/${encodeURIComponent(mockId)}`,
        200,
      ],
      [
        'dev server',
        () => ({ kind: 'app', id: appId }),
        () => `/workspaces/${board}/apps/${encodeURIComponent(appId)}/`,
        () => `/workspaces/${board}/apps/${encodeURIComponent(appId)}/`,
        // Its dev server is not running, so what answers is the waiting page.
        503,
      ],
    ];
    for (const [name, landing, expected, opens, status] of cases) {
      it(`${name}: redirects there after sign-in, and the member can open it`, async () => {
        const who = `${name.replace(' ', '-')}@example.com`;
        const linkId = await mintLinkId(board, landing());
        const redeemed = await onShareHost(`/s/${linkId}`, who);
        expect(redeemed.status).toBe(302);
        expect(redeemed.headers.get('location')).toBe(expected());
        // A returning member opening the same link lands in the same place.
        const again = await onShareHost(`/s/${linkId}`, who);
        expect(again.headers.get('location')).toBe(expected());
        const opened = await onShareHost(opens(), who);
        expect(opened.status, await opened.clone().text()).toBe(status);
      });
    }

    it('a link minted with no landing still opens the board', async () => {
      const linkId = await mintLinkId(board);
      const redeemed = await onShareHost(`/s/${linkId}`, MEMBER);
      expect(redeemed.headers.get('location')).toBe(`/workspaces/${board}`);
    });
  });

  describe('a landing cannot reach past the board it shares', () => {
    it('refuses a task or doc filed on another board, in the words an unknown id gets', async () => {
      const task = await mint(board, { kind: 'task', id: otherTaskId });
      const doc = await mint(board, { kind: 'doc', id: otherDocId });
      const ghost = await mint(board, { kind: 'doc', id: 'no-such-doc' });
      expect(task.status).toBe(400);
      expect(doc.status).toBe(400);
      expect(ghost.status).toBe(400);
      const bodies = await Promise.all([task.json(), doc.json(), ghost.json()]);
      // The two real ids on another board answer exactly as a made-up one.
      expect(bodies[1]).toEqual(bodies[2]);
      expect((bodies[0] as { error: string }).error).toBe('landing_not_on_board');
    });

    it('refuses a kind that does not match what the id is', async () => {
      const r = await mint(board, { kind: 'mockup', id: docId });
      expect(r.status).toBe(400);
    });

    it('refuses an unknown kind or a missing id', async () => {
      expect((await mint(board, { kind: 'settings' })).status).toBe(400);
      expect((await mint(board, { kind: 'doc' })).status).toBe(400);
      expect((await mint(board, 'doc')).status).toBe(400);
    });
  });

  describe("the board's library for a member", () => {
    const LIB = () => `/workspaces/${board}/library/items`;

    it("answers 200 with the board's docs and mocks, and nothing about the machine", async () => {
      const linkId = await mintLinkId(board);
      expect((await onShareHost(`/s/${linkId}`, MEMBER)).status).toBe(302);
      const r = await onShareHost(LIB(), MEMBER);
      expect(r.status, await r.clone().text()).toBe(200);
      const text = await r.clone().text();
      const lib = (await r.json()) as {
        project: unknown;
        files: Array<{ name: string; href?: string; open?: string }>;
      };
      const hrefs = lib.files.map((f) => f.href);
      expect(hrefs).toContain(`/workspaces/${board}/docs/${encodeURIComponent(docId)}`);
      expect(hrefs).toContain(`/workspaces/${board}/mockups/${encodeURIComponent(mockId)}`);
      // Nothing the member could not already open: no project path, no
      // unbound repo file to bind, no host path anywhere in the reply.
      expect(lib.project).toBeNull();
      expect(lib.files.every((f) => f.open === undefined)).toBe(true);
      expect(text).not.toContain(dataDir);
    });

    it('still refuses the open verb, which binds a file on this machine', async () => {
      const r = await onShareHost(`/workspaces/${board}/library/open`, MEMBER, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'README.md' }),
      });
      expect(r.status).toBe(403);
    });

    it("refuses a non-member, and a member reading another board's library", async () => {
      expect((await onShareHost(LIB(), STRANGER)).status).toBe(403);
      const other = await onShareHost(`/workspaces/${otherBoard}/library/items`, MEMBER);
      expect(other.status).toBe(403);
    });
  });

  describe('the board is one tap from where a link lands', () => {
    it("a doc names the member's board as its back arrow", async () => {
      const linkId = await mintLinkId(board, { kind: 'doc', id: docId });
      await onShareHost(`/s/${linkId}`, MEMBER);
      const r = await onShareHost(
        `/workspaces/${board}/docs/${encodeURIComponent(docId)}?format=json`,
        MEMBER,
      );
      expect(r.status).toBe(200);
      const body = (await r.json()) as { backTo?: { workspaceId: string; name: string } };
      expect(body.backTo).toEqual({ workspaceId: board, name: 'Harborlight launch' });
    });

    it('a mock and a dev server page carry a link to the board for a member, not the owner', async () => {
      const pill = `<a class="cw-board-link" href="/workspaces/${board}"`;
      const pages = [
        `/workspaces/${board}/mockups/${encodeURIComponent(mockId)}`,
        `/workspaces/${board}/apps/${encodeURIComponent(liveAppId)}/`,
      ];
      for (const path of pages) {
        const member = await onShareHost(path, MEMBER);
        expect(member.status).toBe(200);
        expect(await member.text()).toContain(pill);
        // The same host page on the owner's own host: drawn, and nothing over it.
        const owner = await req(path, `localhost:${handle.port}`);
        expect(owner.status).toBe(200);
        const ownerHtml = await owner.text();
        expect(ownerHtml).toContain('data-cw-mock-frame');
        expect(ownerHtml).not.toContain('cw-board-link');
      }
      // A dev server that is down answers its waiting page, which names the
      // board for every reader already.
      const waiting = await onShareHost(
        `/workspaces/${board}/apps/${encodeURIComponent(appId)}/`,
        MEMBER,
      );
      expect(await waiting.text()).toContain(`href="/workspaces/${board}"`);
    });
  });
});
