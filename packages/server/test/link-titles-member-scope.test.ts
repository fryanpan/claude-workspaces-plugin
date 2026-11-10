/**
 * The needs-review fact on `links:titles` never reaches a share member.
 *
 * The address in a lookup's body can name any board, and the title lookup
 * only checks that the address tells the truth about where its target lives.
 * So the review mark must not be answerable to somebody holding one board:
 * it would tell them that something on another board waits on its owner.
 * Today the share gate refuses the whole route to a member (their client
 * shows raw links), which is what this pins; the route ALSO cuts the mark to
 * the member's own board (`refInVisitorScope`), so opening the route to
 * members later cannot widen it by accident. Driven through the edge as an
 * Access-authenticated member, against the real route table, with the owner's
 * lookup of the same two links as the control.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'link-review-scope-kid';
const COLLAB_AUD = 'aud-for-the-collab-app';
const TUNNEL_HOST = 'workspaces.example.test';
const LINK_HOST = 'links.example.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const MEMBER_EMAIL = 'alice@partner.example';
const AGENT = { id: 'agent-harborlight', name: 'Harborlight Lead', kind: 'known' };
const QUESTION = { shape: 'review', headline: 'Is the Riverbend timetable right?' };

describe('links:titles — a member reads review marks for their own board only', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let jwt: string;
  let board = '';
  let otherBoard = '';
  let ownTask = '';
  let foreignTask = '';

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const publicJwk = (await exportJWK(publicKey)) as JWK;
    publicJwk.kid = KID;
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    const jwks: JSONWebKeySet = { keys: [publicJwk] };
    dataDir = mkdtempSync(join(tmpdir(), 'link-review-scope-'));
    handle = createServer({
      port: 0,
      dataDir,
      spawnerAgentId: null,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: COLLAB_AUD, jwks },
      share: {
        config: { ...ACCESS_SHARE_CONFIG, publicHostname: LINK_HOST },
        cfApi: mockCfApi(),
      },
      accessTunnelHosts: [TUNNEL_HOST],
    });
    base = `http://127.0.0.1:${handle.port}`;
    jwt = await new SignJWT({ email: MEMBER_EMAIL })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(COLLAB_AUD)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-link-review-scope')
      .sign(privateKey);

    board = handle.tasks.createWorkspace('Harborlight').id;
    otherBoard = handle.tasks.createWorkspace('Saltmarsh').id;
    const asked = (ws: string, title: string): string => {
      const made = handle.tasks.createTask(ws, { title, body: 'Alice can check it.' });
      if (!made.ok) throw new Error('task refused');
      const added = handle.tasks.addReviewItem(made.task.id, QUESTION, { actor: AGENT });
      if (!added.ok) throw new Error('item refused');
      return made.task.id;
    };
    ownTask = asked(board, 'Check the Harborlight timetable');
    foreignTask = asked(otherBoard, 'Check the Saltmarsh timetable');

    handle.shareLinks.addToAudience(board, ['@partner.example'], 'Bryan');
    const shared = await fetch(`${base}/api/share/link`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: board, allowDomains: ['@partner.example'] }),
    });
    expect(shared.status, await shared.clone().text()).toBe(200);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const lookup = (host: string, headers: Record<string, string>, urls: string[]) =>
    fetch(`${base}/workspaces/${board}/links:titles`, {
      method: 'POST',
      headers: { host, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ urls }),
    });

  it('refuses the member the lookup, while the owner is told about both boards', async () => {
    const own = `${base}/workspaces/${board}?task=${ownTask}`;
    const foreign = `${base}/workspaces/${otherBoard}?task=${foreignTask}`;
    const member = await lookup(TUNNEL_HOST, { ...CF_RAY, 'cf-access-jwt-assertion': jwt }, [
      own,
      foreign,
    ]);
    expect(member.status).toBe(403);
    expect(await member.text()).not.toContain('needsReview');

    // Control: the member IS admitted to their board — the refusal is this
    // route's, not a broken sign-in.
    const page = await fetch(`${base}/workspaces/${board}/tasks?format=json`, {
      headers: { host: TUNNEL_HOST, ...CF_RAY, 'cf-access-jwt-assertion': jwt },
    });
    expect(page.status).toBe(200);

    // Control: the owner, asking the same thing from the box, is told both.
    const owner = await lookup(`localhost:${handle.port}`, {}, [own, foreign]);
    expect(owner.status).toBe(200);
    const read = (await owner.json()) as { needsReview?: Record<string, boolean> };
    expect(read.needsReview?.[own]).toBe(true);
    expect(read.needsReview?.[foreign]).toBe(true);
  });
});
