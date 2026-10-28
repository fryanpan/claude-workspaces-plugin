/**
 * A share link with an AUDIENCE, over HTTP: only a matching sign-in can
 * redeem it, and a member is checked against it on every request, so an
 * audience that stops naming them ends their access.
 *
 * The parser and matcher are unit-tested in `share-audience.test.ts`; this
 * file drives the real route table, because a gate wired after a route that
 * already answered still passes a unit test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'share-audience-kid';
const SHARE_AUD = 'aud-for-the-share-app';
const OWNER_AUD = 'aud-for-the-owner-app';
const SHARE_HOST = 'share.example.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

const ALICE = 'alice@harborlight.example';
const BOB = 'bob@harborlight.example';
const RIVERBEND = 'alice@riverbend.example';

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

describe('a share link with an audience', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let board: string;

  const boot = () => {
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
      proxiedTrustedHosts: ['workspaces.example.test'],
      proxiedTrustedEmails: ['owner@example.test'],
    });
  };
  const base = () => `http://127.0.0.1:${handle.port}`;

  const postLocal = (path: string, body: unknown) =>
    fetch(`${base()}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const onShareHost = async (path: string, email: string) =>
    fetch(`${base()}${path}`, {
      redirect: 'manual',
      headers: { host: SHARE_HOST, ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(email) },
    });

  const mint = async (allowDomains?: unknown): Promise<string> => {
    const r = await postLocal('/api/share/workspace', {
      workspaceId: board,
      ...(allowDomains !== undefined ? { allowDomains } : {}),
    });
    expect(r.status, await r.clone().text()).toBe(200);
    return ((await r.json()) as { link: { linkId: string } }).link.linkId;
  };

  const opensBoard = async (email: string) =>
    (await onShareHost(`/workspaces/${encodeURIComponent(board)}?format=json`, email)).status;

  const members = async (): Promise<string[]> => {
    const r = await fetch(`${base()}/api/share`, { headers: { host: `localhost:${handle.port}` } });
    const body = (await r.json()) as { members: Array<{ workspaceId: string; email: string }> };
    return body.members.filter((m) => m.workspaceId === board).map((m) => m.email);
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'share-link-audience-'));
    boot();
    const created = await postLocal('/workspaces', { name: 'Harborlight team' });
    expect(created.status).toBe(200);
    board = ((await created.json()) as { workspace: { id: string } }).workspace.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('says on the reply which audience it applied', async () => {
    const r = await postLocal('/api/share/workspace', {
      workspaceId: board,
      allowDomains: ['@Harborlight.Example'],
    });
    expect(((await r.json()) as { audience: unknown }).audience).toEqual(['@harborlight.example']);
    const open = await postLocal('/api/share/workspace', { workspaceId: board });
    expect(((await open.json()) as { audience: unknown }).audience).toBe('anyone-who-signs-in');
  });

  it('refuses a malformed audience and mints nothing', async () => {
    for (const bad of [[], [''], ['@'], ['*@harborlight.example'], ['a@b@harborlight.example']]) {
      const r = await postLocal('/api/share/workspace', { workspaceId: board, allowDomains: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('bad_allow_domains');
    }
  });

  it('for one address, admits that address and refuses any other at redemption', async () => {
    const linkId = await mint([ALICE]);
    const refused = await onShareHost(`/s/${linkId}`, BOB);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('This link was shared with a different address');
    expect(await members()).not.toContain(BOB);
    expect(await opensBoard(BOB)).toBe(403);

    expect((await onShareHost(`/s/${linkId}`, 'Alice@HARBORLIGHT.example')).status).toBe(302);
    expect(await opensBoard(ALICE)).toBe(200);
  });

  it('for @domain, admits the domain only — not a lookalike, not a subdomain', async () => {
    const linkId = await mint(['@harborlight.example']);
    for (const outsider of [
      RIVERBEND,
      'x@harborlight.example.evil.test',
      'x@sub.harborlight.example',
    ]) {
      expect((await onShareHost(`/s/${linkId}`, outsider)).status, outsider).toBe(403);
      expect(await opensBoard(outsider), outsider).toBe(403);
    }
    expect((await onShareHost(`/s/${linkId}`, 'Bob@HarborLight.Example')).status).toBe(302);
    expect(await opensBoard(BOB)).toBe(200);
    expect(await members()).not.toContain('x@sub.harborlight.example');
  });

  it('ends a member whose share audience no longer names them, on their next request', async () => {
    const linkId = await mint(['@riverbend.example']);
    expect((await onShareHost(`/s/${linkId}`, RIVERBEND)).status).toBe(302);
    expect(await opensBoard(RIVERBEND)).toBe(200);

    // Narrow the audience on disk and restart: the record is the only place
    // it lives, and nothing re-redeems.
    await handle.stop();
    const path = join(dataDir, 'share-links.json');
    const disk = JSON.parse(readFileSync(path, 'utf8')) as {
      links: Array<{ linkId: string; allowDomains?: string[] }>;
    };
    const record = disk.links.find((l) => l.linkId === linkId);
    if (!record) throw new Error('link not on disk');
    record.allowDomains = ['saltmarsh@riverbend.example'];
    writeFileSync(path, JSON.stringify(disk));
    boot();

    expect(await opensBoard(RIVERBEND)).toBe(403);
    // Positive control: the same restart left the Harborlight members in.
    expect(await opensBoard(BOB)).toBe(200);
  });

  it('with no audience, admits whoever signs in, as before', async () => {
    const linkId = await mint();
    const stranger = 'bob@saltmarsh.example';
    expect((await onShareHost(`/s/${linkId}`, stranger)).status).toBe(302);
    expect(await opensBoard(stranger)).toBe(200);
  });
});
