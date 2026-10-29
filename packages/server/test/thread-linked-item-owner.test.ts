/**
 * Who may link another board's review item onto a shared board's thread.
 *
 * The item's headline is that board's content, and a shared board's members
 * read every comment on it, so the snapshot would show them a board they were
 * never given. On a shared board the link is the owner's alone, made from
 * the board's own page: an Access assertion for the owner email, from the
 * page's own origin, as `inbox-routes.test.ts` proves the owner. An agent on
 * this machine, whose every request is loopback, is refused there and
 * allowed on a board nobody else can open (`thread-linked-item.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'linked-item-owner-kid';
const OWNER_AUD = 'aud-owner-app';
const OWNER_HOST = 'workspaces.harborlight.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
// Built at runtime so no address sits in the source.
const OWNER_EMAIL = ['owner', 'harborlight.test'].join('@');
const SAME_ORIGIN = { origin: `https://${OWNER_HOST}`, 'sec-fetch-site': 'same-origin' };
const AGENT = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
const HEADLINE = 'Which Riverbend layout ships?';

let signJwt: (email: string) => Promise<string>;
let handle: ServerHandle;
let root = '';
let base = '';
let boardA = '';
let boardB = '';
let taskB = '';
let itemB = '';
let threadA = '';

const local = () => `localhost:${handle.port}`;
const post = (path: string, body: unknown, host: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { host, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const ok = async (path: string, body: unknown) => {
  const res = await post(path, body, local());
  expect(res.ok, `${path} ${res.status} ${await res.clone().text()}`).toBe(true);
  return res.json() as Promise<Record<string, unknown>>;
};
const ownerHeaders = async (browser: Record<string, string> = SAME_ORIGIN) => ({
  ...CF_RAY,
  'x-forwarded-proto': 'https',
  'cf-access-jwt-assertion': await signJwt(OWNER_EMAIL),
  ...browser,
});
const linkPath = () => `/workspaces/${boardA}/docs/report/threads/${threadA}/linked-items`;
const ITEM = () => ({ workspaceId: boardB, taskId: taskB, reviewItemId: itemB });
const linkedOnA = async (): Promise<number> => {
  const res = await fetch(`${base}/workspaces/${boardA}/docs/report/threads/${threadA}`, {
    headers: { host: local() },
  });
  const { thread } = (await res.json()) as {
    thread: { comments: Array<{ linkedItem?: unknown }> };
  };
  return thread.comments.filter((c) => c.linkedItem).length;
};

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const jwks: JSONWebKeySet = { keys: [publicJwk] };
  signJwt = (email) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(OWNER_AUD)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-linked-item')
      .sign(privateKey);
  root = mkdtempSync(join(tmpdir(), 'linked-item-owner-'));
  handle = createServer({
    port: 0,
    dataDir: join(root, 'data'),
    cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
    proxiedTrustedHosts: [OWNER_HOST],
    proxiedTrustedEmails: [OWNER_EMAIL],
    ownerEmail: OWNER_EMAIL,
    share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
  });
  base = `http://127.0.0.1:${handle.port}`;
  const board = async (name: string) =>
    ((await ok('/workspaces', { name, author: AGENT })) as { workspace: { id: string } }).workspace
      .id;
  boardA = await board('Harborlight');
  boardB = await board('Riverbend');
  const file = join(root, 'report.html');
  writeFileSync(file, '<!doctype html><html><body><main><h3>Riverbend</h3></main></body></html>');
  await ok(`/workspaces/${boardA}/docs`, { docId: 'report', type: 'mockup', sourceUrl: file });
  await ok(`/workspaces/${boardA}/docs:attach`, { docId: 'report' });
  threadA = (
    (await ok(`/workspaces/${boardA}/docs/report/threads`, {
      author: AGENT,
      text: 'Which question is this mock answering?',
      anchor: { kind: 'subject' },
    })) as { thread: { id: string } }
  ).thread.id;
  taskB = (
    (await ok(`/workspaces/${boardB}/tasks`, {
      title: 'Pick the Riverbend layout',
      body: 'Alice can pick a layout so that the page ships this week.',
      author: AGENT,
    })) as { task: { id: string } }
  ).task.id;
  itemB = (
    (await ok(`/workspaces/${boardB}/tasks/${taskB}/review-items`, {
      author: AGENT,
      review: { shape: 'review', headline: HEADLINE },
    })) as { item: { id: string } }
  ).item.id;
  // Board A is shared: a live link to it, as the owner's mint makes one.
  handle.shareLinks.addToAudience(boardA, ['@partner.example'], 'Harborlight');
  await ok('/api/share/link', { workspaceId: boardA, allowDomains: ['@partner.example'] });
});

afterAll(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
  resetOwnerIdentities();
});

describe('linking another board’s item onto a shared board', () => {
  it('is refused to an agent on this machine, and writes nothing', async () => {
    const res = await post(linkPath(), { author: AGENT, item: ITEM() }, local());
    expect(res.status).toBe(403);
    expect(await linkedOnA()).toBe(0);
  });

  it('is refused to the owner from another origin: the proof needs the board’s own page', async () => {
    const res = await post(
      linkPath(),
      { item: ITEM() },
      OWNER_HOST,
      await ownerHeaders({ origin: 'http://localhost:5173', 'sec-fetch-site': 'cross-site' }),
    );
    expect(res.status).toBe(403);
    expect(await linkedOnA()).toBe(0);
  });

  it('is kept for the owner from the board’s own page', async () => {
    const res = await post(linkPath(), { item: ITEM() }, OWNER_HOST, await ownerHeaders());
    expect(res.status, await res.clone().text()).toBe(200);
    const { linkedItem } = (await res.json()) as { linkedItem: { headline: string } };
    expect(linkedItem.headline).toBe(HEADLINE);
    expect(await linkedOnA()).toBe(1);
  });

  it('is open to the agent for an item on the thread’s own board', async () => {
    // The rule is about crossing boards: the same agent, same shared board,
    // an item from that board itself.
    const ownTask = (
      (await ok(`/workspaces/${boardA}/tasks`, {
        title: 'Name the Harborlight report',
        body: 'Alice can name the report so that the board reads clearly.',
        author: AGENT,
      })) as { task: { id: string } }
    ).task.id;
    const ownItem = (
      (await ok(`/workspaces/${boardA}/tasks/${ownTask}/review-items`, {
        author: AGENT,
        review: { shape: 'review', headline: 'Is Harborlight report the name?' },
      })) as { item: { id: string } }
    ).item.id;
    const res = await post(
      linkPath(),
      { author: AGENT, item: { workspaceId: boardA, taskId: ownTask, reviewItemId: ownItem } },
      local(),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await linkedOnA()).toBe(2);
  });
});
