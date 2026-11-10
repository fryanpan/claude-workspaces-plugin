/**
 * Adding a person to a board's audience is enough to let them in.
 *
 * The gate used to admit only member rows, and a row was written only when
 * somebody redeemed a share link. The owner added two people to a board's
 * audience and sent a direct doc link: past Cloudflare, they were told they
 * had no workspace access. Now an audience entry admits its person on their
 * first signed-in request, at the owner's hostname, with no link opened, and
 * widens nothing else: no other board, nobody the audience does not name,
 * and removing them still ends it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';
import { AUDIENCE_ONLY, ShareLinks } from '../src/share/share-links.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'audience-admits-kid';
const OWNER_AUD = 'aud-owner-app';
const MAIN_HOST = 'workspaces.harborlight.test';
/** A share hostname exists, as in prod; nothing here opens a link on it. */
const SHARE_HOST = 'share.harborlight.test';
const SHARE_AUD = 'aud-share-app';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const OWNER_EMAIL = 'owner@harborlight.test';
/** Named by her own address on the Harborlight board's audience. */
const ALICE = 'alice@riverbend.example';
/** Let in by a `@saltmarsh.example` domain entry, never named. */
const BOB = 'bob@saltmarsh.example';
/** Signed in to Access, named by no audience. */
const STRANGER = 'alice@harborlight.example';

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
      .setAudience(OWNER_AUD)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-member')
      .sign(privateKey);
});

describe('a board audience entry admits its person with no link', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let harborlight: string;
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
  /** At the owner's hostname, through the tunnel, signed in as `email`. */
  const as = async (email: string, path: string) =>
    req(path, MAIN_HOST, {
      headers: { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(email) },
    });
  /** Each board's one doc, by the id its create answered. */
  const docIds = new Map<string, string>();
  const docPath = (ws: string) =>
    `/workspaces/${ws}/docs/${encodeURIComponent(docIds.get(ws) ?? '')}?format=json`;

  const board = async (name: string): Promise<string> => {
    const r = await postLocal('/workspaces', { name });
    expect(r.status).toBe(200);
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  };
  const doc = async (ws: string, dir: string) => {
    const file = join(dir, `${ws}.md`);
    writeFileSync(file, '# Plan\n\nThe Harborlight launch plan.\n');
    const r = await postLocal(`/workspaces/${encodeURIComponent(ws)}/docs`, {
      docId: `plan-${ws}`,
      type: 'markdown',
      sourceUrl: file,
      owner: dir,
      title: 'Plan',
    });
    expect(r.status, await r.clone().text()).toBe(200);
    const body = (await r.json()) as { docId?: string; doc?: { id?: string } };
    docIds.set(ws, body.docId ?? body.doc?.id ?? `plan-${ws}`);
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'audience-admits-'));
    const docs = mkdtempSync(join(tmpdir(), 'audience-admits-docs-'));
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
      proxiedTrustedHosts: [MAIN_HOST],
      proxiedTrustedEmails: [OWNER_EMAIL],
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    });
    base = `http://127.0.0.1:${handle.port}`;
    harborlight = await board('Harborlight launch');
    riverbend = await board('Riverbend research');
    await doc(harborlight, docs);
    await doc(riverbend, docs);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses her before she is added, and opens the doc once she is', async () => {
    // The control: the same request, the same signed-in address, refused
    // while the audience does not name her.
    expect((await as(ALICE, docPath(harborlight))).status).toBe(403);
    expect(handle.shareLinks.forWorkspace(harborlight)).toEqual([]);

    handle.shareLinks.addToAudience(harborlight, [ALICE], 'Bryan');
    const r = await as(ALICE, docPath(harborlight));
    expect(r.status, await r.clone().text()).toBe(200);
    // No link was minted or opened.
    expect(handle.shareLinks.forWorkspace(harborlight)).toEqual([]);
    // She is a listed regular member now, as a redemption would make her.
    const row = handle.shareLinks.membersOf(harborlight).find((m) => m.email === ALICE);
    expect(row?.role).toBeUndefined();
    expect(handle.shareLinks.roleOf(harborlight, ALICE)).toBe('member');
  });

  it('opens no other board', async () => {
    expect((await as(ALICE, docPath(riverbend))).status).toBe(403);
    expect(handle.shareLinks.isMember(riverbend, ALICE)).toBe(false);
  });

  it('admits nobody the audience does not name', async () => {
    expect((await as(STRANGER, docPath(harborlight))).status).toBe(403);
    expect(handle.shareLinks.membersOf(harborlight).map((m) => m.email)).not.toContain(STRANGER);
  });

  it('admits a person a domain entry covers', async () => {
    expect((await as(BOB, docPath(harborlight))).status).toBe(403);
    handle.shareLinks.addToAudience(harborlight, ['@saltmarsh.example'], 'Bryan');
    expect((await as(BOB, docPath(harborlight))).status).toBe(200);
  });

  it('removing her from the audience ends it on her next request', async () => {
    expect((await as(ALICE, docPath(harborlight))).status).toBe(200);
    const lost = handle.shareLinks.removeFromAudience(harborlight, ALICE);
    expect(lost).toContain(ALICE);
    expect((await as(ALICE, docPath(harborlight))).status).toBe(403);
    expect(handle.shareLinks.isMember(harborlight, ALICE)).toBe(false);
  });

  it('removing a domain member keeps the domain from letting him back in', async () => {
    expect(handle.shareLinks.removeMember(harborlight, BOB)).toBe(true);
    expect((await as(BOB, docPath(harborlight))).status).toBe(403);
    expect(handle.shareLinks.isMember(harborlight, BOB)).toBe(false);
  });
});

describe('the store: an audience entry admits on its own', () => {
  const BOARD = 'w-board-1';
  const REVIEWER = 'alice@partner.example';
  const OTHER_REVIEWER = 'bob@partner.example';
  let dataDir: string;
  let links: ShareLinks;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'audience-admits-store-'));
    links = new ShareLinks({ dataDir });
    links.addToAudience(BOARD, ['@partner.example'], 'Bryan');
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('lets in an address it names on the first ask, with no link, as a regular member', () => {
    expect(links.forWorkspace(BOARD)).toEqual([]);
    expect(links.isMember(BOARD, REVIEWER)).toBe(true);
    const row = links.membersOf(BOARD).find((m) => m.email === REVIEWER);
    expect(row?.viaLinkId).toBe(AUDIENCE_ONLY);
    expect(links.roleOf(BOARD, REVIEWER)).toBe('member');
    // Written down, so a restart keeps them listed.
    expect(new ShareLinks({ dataDir }).membersOf(BOARD).map((m) => m.email)).toEqual([REVIEWER]);
  });

  it('lets in nobody it does not name, and writes no row for them', () => {
    expect(links.isMember(BOARD, 'alice@harborlight.example')).toBe(false);
    expect(links.membersOf(BOARD)).toEqual([]);
  });

  it('ends on removal, and a removed person is not let back in by the domain', () => {
    expect(links.isMember(BOARD, REVIEWER)).toBe(true);
    expect(links.removeMember(BOARD, REVIEWER)).toBe(true);
    expect(links.isMember(BOARD, REVIEWER)).toBe(false);
    expect(links.isMember(BOARD, OTHER_REVIEWER)).toBe(true);
    expect(links.removeFromAudience(BOARD, '@partner.example')).toEqual([OTHER_REVIEWER]);
    expect(links.isMember(BOARD, OTHER_REVIEWER)).toBe(false);
  });

  it('does not cost a redeemed link its role', () => {
    const owner = links.create({ workspaceId: BOARD, createdBy: 'Test Agent', role: 'owner' });
    expect(links.redeem(owner.linkId, REVIEWER).ok).toBe(true);
    expect(links.roleOf(BOARD, REVIEWER)).toBe('owner');
  });
});
