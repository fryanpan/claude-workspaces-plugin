/**
 * A signed-in member at the owner's main address, over HTTP.
 *
 * The main address used to be the owner's door and nobody else's: Access
 * admitted a member's email, the operator allowlist refused it, and every path
 * answered `{"error":"forbidden"}` — the root and the member's own board alike
 * (Bryan, 29 Sept, in a private window). Now an admitted email that is not the
 * owner's is a VISITOR there, scoped exactly as it is on the collaboration
 * hostname, and `/` lists the boards that email belongs to.
 *
 * What must stay shut is the reason the door existed: past the owner gate a
 * request is what a loopback request is, so every operator verb is asserted
 * refused to a member on the main address, beside the owner reaching the same
 * verbs as the positive control.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { BOARD_FEEDBACK_DOC_ID, type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'member-home-kid';
/** One Access application fronts the main and collaboration hostnames. */
const OWNER_AUD = 'aud-for-the-owner-app';
/** The share hostname has an application of its own. */
const SHARE_AUD = 'aud-for-the-share-app';
const MAIN_HOST = 'workspaces.example.test';
const COLLAB_HOST = 'collab.example.test';
const SHARE_HOST = 'share.example.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

const OWNER_EMAIL = 'owner@example.test';
/** Redeems links to two boards. */
const ALICE = 'alice@harborlight.example';
/** Admitted by Access, a member of nothing. */
const BOB = 'bob@riverbend.example';

let jwks: JSONWebKeySet;
let signJwt: (aud: string, email: string | null) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  jwks = { keys: [publicJwk] };
  signJwt = (aud, email) =>
    new SignJWT(email === null ? {} : { email })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-member')
      .sign(privateKey);
});

describe('a member at the main address', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  /** Alice's two boards, and one nobody shared. */
  let harborlight: string;
  let saltmarsh: string;
  let riverbend: string;

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

  /** Through the tunnel, as `email`, on `host`. `page` asks the way a browser
   *  navigating does; without it the request asks the way `fetch()` does. */
  const as = async (
    email: string | null,
    host: string,
    path: string,
    init: RequestInit & { page?: boolean } = {},
  ) =>
    req(path, host, {
      ...init,
      headers: {
        ...CF_RAY,
        'cf-access-jwt-assertion': await signJwt(
          host === SHARE_HOST ? SHARE_AUD : OWNER_AUD,
          email,
        ),
        ...(init.page
          ? { accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate' }
          : {}),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const page = (email: string | null, path: string, host = MAIN_HOST) =>
    as(email, host, path, { page: true });

  const board = async (name: string): Promise<string> => {
    const r = await postLocal('/workspaces', { name });
    expect(r.status).toBe(200);
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  };

  const redeem = async (workspaceId: string, email: string) => {
    handle.shareLinks.addToAudience(workspaceId, [email], 'Bryan');
    const minted = await postLocal('/api/share/workspace', { workspaceId });
    expect(minted.status, await minted.clone().text()).toBe(200);
    const { link } = (await minted.json()) as { link: { linkId: string } };
    expect((await as(email, SHARE_HOST, `/s/${link.linkId}`)).status).toBe(302);
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'member-home-'));
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
      proxiedTrustedHosts: [MAIN_HOST],
      proxiedTrustedEmails: [OWNER_EMAIL],
      accessTunnelHosts: [COLLAB_HOST],
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    });
    base = `http://127.0.0.1:${handle.port}`;
    harborlight = await board('Harborlight research');
    saltmarsh = await board('Saltmarsh site');
    riverbend = await board('Riverbend launch');
    await redeem(harborlight, ALICE);
    await redeem(saltmarsh, ALICE);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('the root lists the boards the member belongs to', () => {
    it('names each of them, and no other board', async () => {
      const r = await page(ALICE, '/');
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/html');
      const html = await r.text();
      expect(html).toContain('Harborlight research');
      expect(html).toContain('Saltmarsh site');
      expect(html).toContain(`/workspaces/${harborlight}/home`);
      expect(html).not.toContain('Riverbend launch');
      expect(html).not.toContain(riverbend);
      expect(html).toContain(ALICE);
    });

    it('is not the owner’s landing page', async () => {
      // The owner's page carries the unfiled docs, the review bar and the
      // API footer. None of it is a member's to read.
      const html = await (await page(ALICE, '/')).text();
      expect(html).not.toContain('POST /workspaces/');
      const owner = await (await page(OWNER_EMAIL, '/')).text();
      expect(owner).toContain('POST /workspaces/');
      expect(owner).toContain('Riverbend launch');
    });

    // The Workspaces feedback doc is shared by every board, and a Yjs peer
    // syncs the whole doc, so the widget on a member's list would hand them
    // every board's feedback threads. The owner's list carries it.
    it('carries the Workspaces feedback widget for the owner and for no member', async () => {
      const owner = await (await page(OWNER_EMAIL, '/')).text();
      const tag = owner.match(/<claude-feedback-widget\b[^>]*>/)?.[0] ?? '';
      expect(tag).toContain(`doc-id="${BOARD_FEEDBACK_DOC_ID}"`);
      expect(tag).toContain('identity-scope="host"');
      // The doc belongs to every board; the widget needs one to be reached at.
      expect(tag).toMatch(/workspace-id="[^"]+"/);
      for (const host of [MAIN_HOST, SHARE_HOST]) {
        const html = await (await page(ALICE, '/', host)).text();
        expect(html).toContain('Harborlight research');
        // The element, not the word: the list's stylesheet names it.
        expect(html).not.toMatch(/<claude-feedback-widget\b/);
        expect(html).not.toContain(BOARD_FEEDBACK_DOC_ID);
      }
    });

    it('says so when nothing is shared with the address', async () => {
      const r = await page(BOB, '/');
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain('Nothing is shared with this address yet');
      expect(html).toContain(BOB);
      expect(html).not.toContain('Harborlight research');
    });

    it('answers the same list on the share and collaboration hostnames', async () => {
      const onShare = await page(ALICE, '/', SHARE_HOST);
      expect(onShare.status).toBe(200);
      expect(await onShare.text()).toContain('Harborlight research');
      // Collaboration membership is a share's allow list; alice is on none.
      const onCollab = await page(ALICE, '/', COLLAB_HOST);
      expect(onCollab.status).toBe(200);
      expect(await onCollab.text()).not.toContain('Harborlight research');
    });
  });

  describe('a board the member belongs to', () => {
    it('opens as the member’s board, with a way back to the list', async () => {
      const r = await page(ALICE, `/workspaces/${harborlight}/home`);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain('data-visitor="1"');
      expect(html).toContain('data-visitor-home="1"');
      expect(html).toContain(`data-signed-in-as="${ALICE}"`);
    });

    it('the owner’s own board carries no visitor stamp', async () => {
      // The owner's email at the main address is not a visitor at all: no
      // stamp, so the board keeps the owner's own chrome.
      const html = await (await page(OWNER_EMAIL, `/workspaces/${harborlight}/home`)).text();
      expect(html).not.toContain('data-visitor');
      expect(html).not.toContain('data-signed-in-as');
    });
  });

  describe('a board the member does not belong to', () => {
    it('answers one page, the same for a board that exists and one that does not', async () => {
      const notTheirs = await page(ALICE, `/workspaces/${riverbend}/home`);
      const noSuchBoard = await page(ALICE, '/workspaces/w-missing/home');
      expect(notTheirs.status).toBe(403);
      expect(noSuchBoard.status).toBe(403);
      expect(notTheirs.headers.get('content-type')).toContain('text/html');
      const a = await notTheirs.text();
      const b = await noSuchBoard.text();
      expect(a).toContain('You don’t have access to this workspace');
      expect(a).toContain(ALICE);
      expect(a).toContain('href="/"');
      expect(a).not.toContain('Riverbend launch');
      expect(b).toBe(a);
    });

    it('keeps the JSON refusal for a caller that is not a page', async () => {
      const r = await as(ALICE, MAIN_HOST, `/workspaces/${riverbend}/tasks`);
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'out_of_share_scope' });
    });

    it('answers the same page on the share and collaboration hostnames', async () => {
      for (const host of [SHARE_HOST, COLLAB_HOST]) {
        const r = await page(ALICE, `/workspaces/${riverbend}/home`, host);
        expect(r.status, host).toBe(403);
        expect(await r.text(), host).toContain('You don’t have access to this workspace');
      }
    });
  });

  describe('what a member never reaches at the main address', () => {
    const operatorVerbs: Array<[string, string, unknown?]> = [
      ['POST', '/api/deploy'],
      ['POST', '/api/plugin/refresh'],
      ['POST', '/workspaces', { name: 'Should not exist' }],
      ['GET', '/api/share'],
      ['POST', '/api/share/workspace', {}],
    ];

    it('refuses every operator verb, as a page and as an API call', async () => {
      for (const [method, path, body] of operatorVerbs) {
        const r = await as(ALICE, MAIN_HOST, path, {
          method,
          headers: { 'content-type': 'application/json' },
          body:
            body === undefined ? undefined : JSON.stringify({ ...body, workspaceId: riverbend }),
        });
        expect(r.status, `${method} ${path}`).toBe(403);
      }
    });

    it('positive control: the owner reaches the same verbs', async () => {
      // 501 is "no deployer on this server" — behind the host gate and the
      // identity check, so reaching it is what makes the 403 above mean
      // something.
      const deploy = await as(OWNER_EMAIL, MAIN_HOST, '/api/deploy', { method: 'POST' });
      expect(deploy.status).toBe(501);
      const shares = await as(OWNER_EMAIL, MAIN_HOST, '/api/share');
      expect(shares.status).toBe(200);
    });

    it('a token with no email is still nobody', async () => {
      const r = await as(null, MAIN_HOST, '/', { page: true });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'forbidden' });
    });
  });

  describe('the owner’s switches', () => {
    it('a board closed to outside visitors leaves the list and stops opening', async () => {
      const closed = await postLocal('/api/share/enabled', {
        workspaceId: saltmarsh,
        enabled: false,
      });
      expect(closed.status, await closed.clone().text()).toBe(200);
      try {
        const list = await (await page(ALICE, '/')).text();
        expect(list).toContain('Harborlight research');
        expect(list).not.toContain('Saltmarsh site');
        const open = await page(ALICE, `/workspaces/${saltmarsh}/home`);
        expect(open.status).toBe(403);
      } finally {
        // Reopening is the owner's: an agent's call files a card instead.
        handle.sharingGate.setBoardEnabled(saltmarsh, true);
      }
      expect(await (await page(ALICE, '/')).text()).toContain('Saltmarsh site');
    });

    it('the master switch shuts the list with everything else', async () => {
      expect((await postLocal('/api/share/enabled', { enabled: false })).status).toBe(200);
      try {
        const r = await page(ALICE, '/');
        expect(r.status).toBe(403);
        expect(await r.json()).toEqual({ error: 'sharing_disabled' });
      } finally {
        // Only the owner turns it back on; the test sets the gate directly.
        handle.sharingGate.setEnabled(true);
      }
    });
  });
});
