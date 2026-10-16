/**
 * A board agent token (`at2`) through the real route table.
 *
 * The holder is an agent on another machine reaching one board through the
 * tunnel: the Access application in front of the operator's hostname admits
 * its service token (a JWT with no email), and the token says which agent it
 * is and which board it may open. These tests drive both halves:
 *
 *   A. The mint, list and revoke are this machine's alone.
 *   B. Through the tunnel, the token reads and comments on its own board, as
 *      its own agent, and is refused another board, Mac paths, mounts, deploy
 *      and sharing. Every refusal sits beside a positive control on the
 *      matching path of its own board, so a gate that refused everything
 *      would fail here rather than pass.
 *   C. Its watch set is its own, cut to its board.
 *   D. A revoked token is refused, and the stream it held open is hung up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'board-token-kid';
const OPERATOR_AUD = 'aud-for-the-operator-app';
const PROXIED_HOST = 'operator.example.com';
const LINK_HOST = 'links.example.com';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const OPERATOR_EMAIL = 'operator@example.com';
const AGENT = 'agent-riverbend';

let h: ServerHandle;
let dataDir: string;
let base: string;
let serviceJwt: string;
let ownBoard: string;
let otherBoard: string;
let docId: string;
let otherDocId: string;

const local = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      host: `localhost:${h.port}`,
      'content-type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });

/** Through the tunnel, as the remote agent: service token plus `at2`. */
const remote = (token: string, path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      host: PROXIED_HOST,
      ...CF_RAY,
      'cf-access-jwt-assertion': serviceJwt,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });

async function mint(agentId: string, boardId: string): Promise<{ id: string; token: string }> {
  const res = await local('/api/board-tokens', {
    method: 'POST',
    body: JSON.stringify({ agentId, boardId, label: 'test' }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { id: string; token: string };
}

async function boardWithDoc(name: string): Promise<{ boardId: string; docId: string }> {
  const board = await local('/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  expect(board.status, await board.clone().text()).toBe(200);
  const boardId = ((await board.json()) as { workspace: { id: string } }).workspace.id;
  const slug = `${name.toLowerCase()}-doc`;
  const path = join(dataDir, `${slug}.md`);
  writeFileSync(path, '# Doc\n\nBody to comment on.\n');
  const doc = await local(`/workspaces/${boardId}/docs`, {
    method: 'POST',
    body: JSON.stringify({ docId: slug, type: 'markdown', sourceUrl: path }),
  });
  expect(doc.status, await doc.clone().text()).toBe(200);
  const id = ((await doc.json()) as { docId: string }).docId;
  const filed = await local(`/workspaces/${boardId}/docs:attach`, {
    method: 'POST',
    body: JSON.stringify({ docId: slug }),
  });
  expect(filed.status, await filed.clone().text()).toBe(200);
  return { boardId, docId: id };
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const jwks: JSONWebKeySet = { keys: [publicJwk] };
  // An Access SERVICE token: admitted to the hostname, naming no email.
  serviceJwt = await new SignJWT({ common_name: 'service-token-client-id' })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(`https://${TEAM_DOMAIN}`)
    .setAudience(OPERATOR_AUD)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
    .sign(privateKey);
  dataDir = mkdtempSync(join(tmpdir(), 'board-token-'));
  h = createServer({
    port: 0,
    dataDir,
    cfAccess: { teamDomain: TEAM_DOMAIN, audience: OPERATOR_AUD, jwks },
    share: { config: { publicHostname: LINK_HOST } },
    proxiedTrustedHosts: [PROXIED_HOST],
    proxiedTrustedEmails: [OPERATOR_EMAIL],
  });
  base = `http://127.0.0.1:${h.port}`;
  ({ boardId: ownBoard, docId } = await boardWithDoc('Harborlight'));
  ({ boardId: otherBoard, docId: otherDocId } = await boardWithDoc('Saltmarsh'));
});

afterAll(async () => {
  await h.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('A. minting is this machine’s alone', () => {
  it('mints from loopback, and lists the record without the token value', async () => {
    const { id, token } = await mint(AGENT, ownBoard);
    expect(token.startsWith(`at2.${id}.${AGENT}.${ownBoard}.`)).toBe(true);
    const listed = await local('/api/board-tokens');
    const body = (await listed.json()) as { tokens: Array<Record<string, unknown>> };
    const row = body.tokens.find((t) => t.id === id);
    expect(row).toMatchObject({ agentId: AGENT, boardId: ownBoard });
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it('refuses a mint through the edge, from a page, and by a token holder', async () => {
    const body = JSON.stringify({ agentId: AGENT, boardId: ownBoard });
    const edge = await local('/api/board-tokens', { method: 'POST', body, headers: CF_RAY });
    expect(edge.status).toBe(403);
    const page = await local('/api/board-tokens', {
      method: 'POST',
      body,
      headers: { origin: 'https://studio.example.net' },
    });
    // Refused either by the sign-in write gate (401) or by the route's own
    // browser check (403), depending on which this deployment runs first.
    expect([401, 403]).toContain(page.status);
    const count = async () =>
      ((await (await local('/api/board-tokens')).json()) as { tokens: unknown[] }).tokens.length;
    const before = await count();
    const { token } = await mint(AGENT, ownBoard);
    const holder = await remote(token, '/api/board-tokens', { method: 'POST', body });
    expect(holder.status).toBe(403);
    // Only the control mint above landed.
    expect(await count()).toBe(before + 1);
  });

  it('refuses a mint for a board this server does not hold', async () => {
    const res = await local('/api/board-tokens', {
      method: 'POST',
      body: JSON.stringify({ agentId: AGENT, boardId: 'w-nosuch' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('B. through the tunnel, one board and nothing else', () => {
  let token: string;
  beforeAll(async () => {
    ({ token } = await mint(AGENT, ownBoard));
  });

  it('reads its own board, its threads and its feed', async () => {
    expect((await remote(token, `/workspaces/${ownBoard}`)).status).toBe(200);
    expect((await remote(token, `/workspaces/${ownBoard}/docs/${docId}/threads`)).status).toBe(200);
    expect((await remote(token, `/workspaces/${ownBoard}/events`)).status).toBe(200);
  });

  it('comments on its own board as its own agent, whatever the body claims', async () => {
    const res = await remote(token, `/workspaces/${ownBoard}/docs/${docId}/threads/by_find`, {
      method: 'POST',
      body: JSON.stringify({
        author: { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' },
        text: 'a note from the remote agent',
        find: 'Body',
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const listed = await local(`/workspaces/${ownBoard}/docs/${docId}/threads`);
    const { threads } = (await listed.json()) as {
      threads: Array<{ comments: Array<{ text: string; author: { id: string } }> }>;
    };
    const mine = threads
      .flatMap((t) => t.comments)
      .find((c) => c.text === 'a note from the remote agent');
    expect(mine?.author.id).toBe(AGENT);
  });

  it('is refused every route of another board', async () => {
    for (const path of [
      `/workspaces/${otherBoard}`,
      `/workspaces/${otherBoard}/docs/${otherDocId}/threads`,
      `/workspaces/${otherBoard}/events`,
      `/workspaces/${otherBoard}/events:stream`,
    ]) {
      expect((await remote(token, path)).status, path).toBe(403);
    }
    const write = await remote(
      token,
      `/workspaces/${otherBoard}/docs/${otherDocId}/threads/by_find`,
      {
        method: 'POST',
        body: JSON.stringify({ text: 'should not land', find: 'Body' }),
      },
    );
    expect(write.status).toBe(403);
  });

  it('is refused Mac paths, mounts, deploy and sharing', async () => {
    const path = join(dataDir, 'host-file.md');
    writeFileSync(path, '# Host\n');
    const refused: Array<[string, RequestInit]> = [
      // Binding a file on this machine to its own board.
      [
        `/workspaces/${ownBoard}/docs`,
        { method: 'POST', body: JSON.stringify({ docId: 'host-file', sourceUrl: path }) },
      ],
      ['/api/repos', {}],
      ['/api/mounts', {}],
      ['/api/mounts', { method: 'POST', body: JSON.stringify({ path: dataDir }) }],
      ['/api/deploy', { method: 'POST', body: '{}' }],
      ['/api/deploy', {}],
      ['/api/share/workspace', { method: 'POST', body: JSON.stringify({ workspaceId: ownBoard }) }],
      ['/api/share/link', { method: 'POST', body: JSON.stringify({ workspaceId: ownBoard }) }],
      ['/api/share/enabled', { method: 'POST', body: JSON.stringify({ enabled: false }) }],
      ['/workspaces', {}],
      ['/events/agent/agent-riverbend', {}],
    ];
    for (const [p, init] of refused) {
      expect((await remote(token, p, init)).status, `${init.method ?? 'GET'} ${p}`).toBe(403);
    }
  });

  it('is refused by a browser carrying it, and with no Access token in front', async () => {
    const page = await remote(token, `/workspaces/${ownBoard}`, {
      headers: { origin: `https://${PROXIED_HOST}` },
    });
    expect(page.status).toBe(403);
    const bare = await fetch(`${base}/workspaces/${ownBoard}`, {
      headers: { host: PROXIED_HOST, ...CF_RAY, authorization: `Bearer ${token}` },
    });
    expect(bare.status).toBe(401);
  });

  it('refuses a tampered token and a token for another protocol', async () => {
    const swapped = token.replace(`.${ownBoard}.`, `.${otherBoard}.`);
    expect((await remote(swapped, `/workspaces/${otherBoard}`)).status).toBe(401);
    expect((await remote(swapped, `/workspaces/${ownBoard}`)).status).toBe(401);
    const forged = `${token.slice(0, -4)}AAAA`;
    expect((await remote(forged, `/workspaces/${ownBoard}`)).status).toBe(401);
  });

  it('narrows a loopback caller too: off the tunnel it opens only its board', async () => {
    const asHolder = (p: string) => local(p, { headers: { authorization: `Bearer ${token}` } });
    expect((await asHolder(`/workspaces/${ownBoard}`)).status).toBe(200);
    expect((await asHolder(`/workspaces/${otherBoard}`)).status).toBe(403);
    expect((await asHolder('/api/mounts')).status).toBe(403);
  });
});

describe('C. its watch set, cut to its board', () => {
  it('adds and lists keys on its board, and refuses any other', async () => {
    // A key on another board already in the set, from the agent's own machine.
    h.agentWatches.update(AGENT, { add: [`ws:${otherBoard}`] });
    const { token } = await mint(AGENT, ownBoard);
    const watches = `/api/agents/${AGENT}/watches`;
    const added = await remote(token, watches, {
      method: 'POST',
      body: JSON.stringify({ add: [`ws:${ownBoard}`, docId] }),
    });
    expect(added.status, await added.clone().text()).toBe(200);
    const offBoard = await remote(token, watches, {
      method: 'POST',
      body: JSON.stringify({ add: [otherDocId] }),
    });
    expect(offBoard.status).toBe(403);
    const listed = (await (await remote(token, watches)).json()) as {
      watches: Array<{ key: string }>;
    };
    const keys = listed.watches.map((w) => w.key).sort();
    expect(keys).toEqual([docId, `ws:${ownBoard}`].sort());
    // Another agent's set is not its to read.
    expect((await remote(token, '/api/agents/agent-saltmarsh/watches')).status).toBe(403);
  });
});

describe('D. revocation', () => {
  it('refuses a revoked token and hangs up the stream it held open', async () => {
    const { id, token } = await mint(AGENT, ownBoard);
    const stream = await remote(token, `/workspaces/${ownBoard}/events:stream`);
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();
    let ended = false;
    void (async () => {
      while (reader) {
        const { done } = await reader.read();
        if (done) break;
      }
      ended = true;
    })();

    const revoked = await local(`/api/board-tokens/${id}/revoke`, { method: 'POST' });
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect((await remote(token, `/workspaces/${ownBoard}`)).status).toBe(401);
    await waitFor(() => ended, { describe: 'the revoked token’s stream to close' });

    const listed = (await (await local('/api/board-tokens')).json()) as {
      tokens: Array<{ id: string; revokedAt?: number }>;
    };
    // Soft: the record is kept, marked.
    expect(listed.tokens.find((t) => t.id === id)?.revokedAt).toBeNumber();
  });

  it('leaves every other token standing', async () => {
    const a = await mint(AGENT, ownBoard);
    const b = await mint(AGENT, ownBoard);
    await local(`/api/board-tokens/${a.id}/revoke`, { method: 'POST' });
    expect((await remote(a.token, `/workspaces/${ownBoard}`)).status).toBe(401);
    expect((await remote(b.token, `/workspaces/${ownBoard}`)).status).toBe(200);
  });
});
