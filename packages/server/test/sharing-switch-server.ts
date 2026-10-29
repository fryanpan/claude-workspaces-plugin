/**
 * The server `sharing-switch.test.ts` and `sharing-switch-notice.test.ts`
 * share: the share-link configuration prod runs (a share hostname, the
 * owner's proxied hostname, the retired per-share registry alongside), two
 * boards a member has joined through their links, and the requests the
 * tests make against it. Each file that calls `useSharingSwitchServer` gets a
 * server of its own.
 */
import { afterAll, beforeAll, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

export const TEAM_DOMAIN = 'test.cloudflareaccess.com';
export const KID = 'sharing-switch-kid';
export const SHARE_AUD = 'aud-share-app';
export const OWNER_AUD = 'aud-owner-app';
export const SHARE_HOST = 'share.harborlight.test';
export const OWNER_HOST = 'workspaces.harborlight.test';
export const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
export const MEMBER = 'bob@riverbend.example';
export const LATE_MEMBER = 'alice@saltmarsh.example';
export const OWNER_EMAIL = 'owner@harborlight.test';
/** What a fetch from the board's own page on the owner's hostname carries. */
export const OWN_PAGE = {
  'x-forwarded-proto': 'https',
  'sec-fetch-site': 'same-origin',
  origin: `https://${OWNER_HOST}`,
};

/** One card the sharing notice filed, as the board's review items list it. */
export interface Notice {
  board: string;
  taskId: string;
  reviewItemId: string;
  access: unknown;
}

export interface SharingSwitchServer {
  readonly handle: ServerHandle;
  /** The board the tests close, and the one they leave open. */
  readonly closing: string;
  readonly other: string;
  readonly closingLink: string;
  /** Every headline the quality gate was shown. */
  judged: string[];
  signJwt: (aud: string, email: string) => Promise<string>;
  req: (path: string, host: string, init?: RequestInit) => Promise<Response>;
  postLocal: (path: string, body: unknown) => Promise<Response>;
  onShareHost: (path: string, email: string) => Promise<Response>;
  onOwnerHost: (path: string) => Promise<Response>;
  postOwner: (path: string, body: unknown, page?: Record<string, string>) => Promise<Response>;
  openNotices: () => Promise<Notice[]>;
  doorPath: (n: Notice) => string;
  approveNotice: (n: Notice) => Promise<Response>;
  turnBackOn: () => Promise<void>;
  boardPath: (id: string) => string;
  status: () => Promise<{ enabled: boolean; locked: boolean; closedBoards?: string[] }>;
}

export function useSharingSwitchServer(): SharingSwitchServer {
  let jwks: JSONWebKeySet;
  let sign: (aud: string, email: string) => Promise<string>;
  const signJwt = (aud: string, email: string) => sign(aud, email);

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const publicJwk = (await exportJWK(publicKey)) as JWK;
    publicJwk.kid = KID;
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    jwks = { keys: [publicJwk] };
    sign = (aud, email) =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(`https://${TEAM_DOMAIN}`)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .setSubject('cf-access-visitor')
        .sign(privateKey);
  });

  const judged: string[] = [];
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let closing: string;
  let other: string;
  let closingLink: string;

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
  const onShareHost = async (path: string, email: string) =>
    req(path, SHARE_HOST, {
      headers: { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(SHARE_AUD, email) },
    });
  const onOwnerHost = async (path: string) =>
    req(path, OWNER_HOST, {
      headers: { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(OWNER_AUD, OWNER_EMAIL) },
    });
  /** The owner's own request, through the tunnel: what proves the owner. */
  const postOwner = async (path: string, body: unknown, page: Record<string, string> = {}) =>
    req(path, OWNER_HOST, {
      method: 'POST',
      headers: {
        ...CF_RAY,
        'cf-access-jwt-assertion': await signJwt(OWNER_AUD, OWNER_EMAIL),
        'content-type': 'application/json',
        ...page,
      },
      body: JSON.stringify(body),
    });
  /** The sharing notice's open cards, on every board. */
  const openNotices = async (): Promise<
    Array<{ board: string; taskId: string; reviewItemId: string; access: unknown }>
  > => {
    const r = await req('/workspaces?format=json', `localhost:${handle.port}`);
    const boards = ((await r.json()) as { boardWorkspaces: Array<{ id: string }> }).boardWorkspaces;
    const found: Array<{ board: string; taskId: string; reviewItemId: string; access: unknown }> =
      [];
    for (const { id } of boards) {
      const items = (await (
        await req(`/workspaces/${id}/review-items`, `localhost:${handle.port}`)
      ).json()) as {
        items: Array<{ askedBy: string; taskId: string; reviewItemId: string; access?: unknown }>;
      };
      for (const row of items.items.filter((i) => i.askedBy === 'Sharing switch')) {
        found.push({
          board: id,
          taskId: row.taskId,
          reviewItemId: row.reviewItemId,
          access: row.access,
        });
      }
    }
    return found;
  };
  const doorPath = (n: { board: string; taskId: string; reviewItemId: string }) =>
    `/workspaces/${n.board}/tasks/${n.taskId}/review-items/${n.reviewItemId}/access`;
  /** The owner's Approve on the notice's card, through the tunnel. */
  const approveNotice = async (n: {
    board: string;
    taskId: string;
    reviewItemId: string;
    access: unknown;
  }) => postOwner(doorPath(n), { decision: 'approve', access: n.access }, OWN_PAGE);
  /**
   * Turn the master switch back on the only way left: the owner approving
   * the card it filed, at the access door, through the tunnel (Bryan, 29 Oct:
   * an agent's call cannot open the doors again).
   */
  const turnBackOn = async (): Promise<void> => {
    for (const n of await openNotices()) {
      const answered = await approveNotice(n);
      expect(answered.status, await answered.clone().text()).toBe(200);
    }
    expect((await status()).enabled).toBe(true);
  };
  const boardPath = (id: string) => `/workspaces/${encodeURIComponent(id)}?format=json`;
  const status = async () =>
    (
      (await (await req('/api/share', `localhost:${handle.port}`)).json()) as {
        sharing: { enabled: boolean; locked: boolean; closedBoards?: string[] };
      }
    ).sharing;

  const boardWithLink = async (name: string): Promise<{ id: string; linkId: string }> => {
    const created = await postLocal('/workspaces', { name });
    expect(created.status).toBe(200);
    const id = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    handle.shareLinks.addToAudience(id, [MEMBER, LATE_MEMBER], 'Bryan');
    const minted = await postLocal('/api/share/workspace', { workspaceId: id });
    expect(minted.status, await minted.clone().text()).toBe(200);
    const linkId = ((await minted.json()) as { link: { linkId: string } }).link.linkId;
    return { id, linkId };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'sharing-switch-'));
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
      proxiedTrustedHosts: [OWNER_HOST],
      proxiedTrustedEmails: [OWNER_EMAIL],
      // So a request Access proves as this address proves the owner.
      ownerEmail: OWNER_EMAIL,
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
      // The quality gate, stubbed to pass and to record what it was shown, so
      // the notice block can see the server's own item went through it.
      reviewJudge: async (input) => {
        judged.push(input.item.headline ?? '');
        return { ok: true, reason: 'fine' };
      },
    });
    base = `http://127.0.0.1:${handle.port}`;
    const a = await boardWithLink('Harborlight board');
    const b = await boardWithLink('Riverbend board');
    closing = a.id;
    closingLink = a.linkId;
    other = b.id;
    // The member joins both boards through their links.
    expect((await onShareHost(`/s/${a.linkId}`, MEMBER)).status).toBe(302);
    expect((await onShareHost(`/s/${b.linkId}`, MEMBER)).status).toBe(302);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    resetOwnerIdentities();
  });

  return {
    get handle() {
      return handle;
    },
    get closing() {
      return closing;
    },
    get other() {
      return other;
    },
    get closingLink() {
      return closingLink;
    },
    judged,
    signJwt,
    req,
    postLocal,
    onShareHost,
    onOwnerHost,
    postOwner,
    openNotices,
    doorPath,
    approveNotice,
    turnBackOn,
    boardPath,
    status,
  };
}
