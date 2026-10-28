/**
 * The GitHub hub's routes on one real server (`routes/github-hub.ts`).
 *
 * Minting a push key and setting a board's subscriptions are this machine's
 * alone. The relay's two routes take a caller the home feed would admit (a
 * loopback peer, or through the tunnel the one Access service token) AND
 * this board's live push key, and nothing else: no key, another board's key,
 * a retired key, an `at2`, a cookie and a person's Access stamp are each
 * refused. A pushed event reaches an agent holding a stream on the board as
 * one `workspace.github_event` frame carrying the words, and the MCP child
 * renders those words as a quote.
 *
 * All fixtures synthetic; port 0; no request leaves the machine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ChannelNotification, createChannelMessages } from '../../mcp/src/channel-messages.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type FrameListener, listenFrames } from './sse-frames.ts';
import { waitFor } from './wait-for.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'gh-hub-kid';
const AUD = 'aud-for-the-project-app';
const PROXIED_HOST = 'riverbend.example.com';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const RELAY_CLIENT_ID = 'relay-service-token.access';
const AGENT = { id: 'agent-riverbend', name: 'Riverbend', kind: 'agent' };
const REPO = 'riverbend/site';
const LINE = '🔀 PR #12 merged on `riverbend/site`: **Ship the Saltmarsh index**';

let h: ServerHandle;
let dataDir: string;
let base: string;
let board = '';
let otherBoard = '';
let serviceJwt = '';
let personJwt = '';
let stream: FrameListener;

const local = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      host: `localhost:${h.port}`,
      'content-type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
/** Through the tunnel: the edge adds cf-ray, Access adds its stamp. */
const tunnel = (path: string, stamp: string, init: RequestInit = {}) =>
  local(path, {
    ...init,
    headers: {
      host: PROXIED_HOST,
      ...CF_RAY,
      'cf-access-jwt-assertion': stamp,
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

async function mintKey(boardId: string): Promise<string> {
  const res = await local('/api/github-push-keys', {
    method: 'POST',
    body: JSON.stringify({ workspaceId: boardId }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { key: string }).key;
}

let seq = 0;
const event = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: `event-${String(++seq).padStart(4, '0')}`,
    repo: REPO,
    kind: 'merge',
    text: LINE,
    ...over,
  });

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = (await exportJWK(publicKey)) as JWK;
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const jwks: JSONWebKeySet = { keys: [jwk] };
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(privateKey);
  serviceJwt = await sign({ common_name: RELAY_CLIENT_ID });
  personJwt = await sign({ email: 'alice@example.com' });
  dataDir = mkdtempSync(join(tmpdir(), 'gh-hub-routes-'));
  h = createServer({
    port: 0,
    dataDir,
    cfAccess: { teamDomain: TEAM_DOMAIN, audience: AUD, jwks },
    // Sharing wired, as on every deployed server; without it loopback
    // would need a stamp too.
    share: { config: { publicHostname: 'links.example.com' } },
    proxiedTrustedHosts: [PROXIED_HOST],
    homeFeedClientId: RELAY_CLIENT_ID,
  });
  base = `http://127.0.0.1:${h.port}`;
  const make = async (name: string) => {
    const res = await local('/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
    return ((await res.json()) as { workspace: { id: string } }).workspace.id;
  };
  board = await make('Riverbend board');
  otherBoard = await make('Saltmarsh board');
  await local(`/workspaces/${board}/agents`, {
    method: 'POST',
    body: JSON.stringify({
      agentId: AGENT.id,
      agentName: AGENT.name,
      runtime: 'claude-code-local',
    }),
  });
  await local(`/api/agents/${AGENT.id}/watches`, {
    method: 'POST',
    body: JSON.stringify({ add: [`ws:${board}`] }),
  });
  stream = listenFrames(await fetch(`${base}/events/agent/${AGENT.id}`));
  const put = await local(`/workspaces/${board}/github-subscriptions`, {
    method: 'PUT',
    body: JSON.stringify({ subscriptions: [{ repo: REPO, kinds: ['merge', 'ci'] }] }),
  });
  expect(put.status, await put.clone().text()).toBe(200);
});

afterAll(async () => {
  await stream?.stop();
  await h.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('A. keys and subscriptions are set on this machine only', () => {
  it('refuses a mint or a subscription write through the edge or from a page', async () => {
    const body = JSON.stringify({ workspaceId: board });
    const edge = await local('/api/github-push-keys', { method: 'POST', body, headers: CF_RAY });
    expect(edge.status).toBe(403);
    const page = await local('/api/github-push-keys', {
      method: 'POST',
      body,
      headers: { origin: 'https://studio.example.net', 'sec-fetch-mode': 'cors' },
    });
    expect([401, 403]).toContain(page.status);
    const subs = JSON.stringify({ subscriptions: [] });
    const viaEdge = await tunnel(`/workspaces/${board}/github-subscriptions`, serviceJwt, {
      method: 'PUT',
      body: subs,
    });
    expect(viaEdge.status).toBe(403);
    // Unchanged by the refused write.
    const read = await local(`/workspaces/${board}/github-subscriptions`);
    expect(((await read.json()) as { subscriptions: unknown[] }).subscriptions).toHaveLength(1);
  });

  it('refuses a mint for a board this server does not hold', async () => {
    const res = await local('/api/github-push-keys', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'w-nosuch' }),
    });
    expect(res.status).toBe(404);
  });

  it('refuses a malformed subscription list with the reason', async () => {
    const res = await local(`/workspaces/${board}/github-subscriptions`, {
      method: 'PUT',
      body: JSON.stringify({ subscriptions: [{ repo: REPO, kinds: ['push'] }] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('kinds');
  });
});

describe('B. the relay routes take the push key and nothing else', () => {
  let key = '';
  beforeAll(async () => {
    key = await mintKey(board);
  });
  const subsPath = () => `/workspaces/${board}/github/subscriptions`;
  const eventsPath = () => `/workspaces/${board}/github/events`;

  it('POSITIVE CONTROL: the key reads the list from loopback and through the tunnel', async () => {
    const res = await local(subsPath(), { headers: bearer(key) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspaceId: board,
      subscriptions: [{ repo: REPO, kinds: ['ci', 'merge'] }],
    });
    expect((await tunnel(subsPath(), serviceJwt, { headers: bearer(key) })).status).toBe(200);
  });

  it('refuses a request without the key, with another board’s, or with a retired one', async () => {
    expect((await local(subsPath())).status).toBe(401);
    const other = await mintKey(otherBoard);
    expect((await local(subsPath(), { headers: bearer(other) })).status).toBe(401);
    const post = await local(eventsPath(), {
      method: 'POST',
      body: event(),
      headers: bearer(other),
    });
    expect(post.status).toBe(401);
    const old = await mintKey(board);
    key = await mintKey(board);
    expect((await local(subsPath(), { headers: bearer(old) })).status).toBe(401);
    expect((await local(subsPath(), { headers: bearer(key) })).status).toBe(200);
  });

  it('refuses an at2 in its place', async () => {
    const res = await local('/api/board-tokens', {
      method: 'POST',
      body: JSON.stringify({ agentId: AGENT.id, boardId: board, label: 'test' }),
    });
    const { token } = (await res.json()) as { token: string };
    expect((await local(subsPath(), { headers: bearer(token) })).status).toBe(401);
  });

  it('refuses a share or collab visitor even holding the key: a cookie, or a person’s stamp', async () => {
    const withCookie = await tunnel(subsPath(), serviceJwt, {
      headers: { ...bearer(key), cookie: 'cw_link=anything' },
    });
    expect(withCookie.status).toBe(403);
    const person = await tunnel(subsPath(), personJwt, { headers: bearer(key) });
    expect(person.status).toBe(403);
    const unstamped = await local(subsPath(), { headers: { ...bearer(key), ...CF_RAY } });
    expect(unstamped.status).toBe(403);
  });

  it('delivers a subscribed event once, as one frame carrying the words', async () => {
    const before = stream.frames.length;
    const body = event();
    const res = await tunnel(eventsPath(), serviceJwt, {
      method: 'POST',
      body,
      headers: bearer(key),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ delivered: true, reached: 1 });
    const again = await local(eventsPath(), { method: 'POST', body, headers: bearer(key) });
    expect(await again.json()).toEqual({ delivered: false, reason: 'duplicate' });
    const frame = await waitFor(
      () => stream.frames.slice(before).find((f) => f.event === 'workspace.github_event'),
      { describe: 'the github_event frame' },
    );
    expect(frame.data).toMatchObject({ workspaceId: board, repo: REPO, kind: 'merge', text: LINE });

    const out: ChannelNotification['params'][] = [];
    const messages = createChannelMessages({
      notify: async (n) => {
        out.push(n.params);
      },
      http: async () => ({}),
      authorId: AGENT.id,
    });
    await messages.emitChannelMessage(frame.event, frame.data);
    expect(out).toHaveLength(1);
    const line = out[0]?.content ?? '';
    expect(line).toStartWith('[workspace.github_event]');
    expect(line).toContain('Ship the Saltmarsh index');
    expect(line).toContain('untrusted');
    expect(out[0]?.meta.workspace_id).toBe(board);
  });

  it('answers an unsubscribed repo or kind without delivering it', async () => {
    const before = stream.frames.length;
    for (const over of [{ repo: 'riverbend/other' }, { kind: 'issue' }]) {
      const res = await local(eventsPath(), {
        method: 'POST',
        body: event(over),
        headers: bearer(key),
      });
      expect(await res.json()).toEqual({ delivered: false, reason: 'not_subscribed' });
    }
    // A subscribed one after them, so their absence is not a race.
    await local(eventsPath(), {
      method: 'POST',
      body: event({ kind: 'ci' }),
      headers: bearer(key),
    });
    await waitFor(
      () => stream.frames.slice(before).some((f) => f.data?.kind === 'ci') || undefined,
      { describe: 'the sentinel ci frame' },
    );
    const got = stream.frames.slice(before).filter((f) => f.event === 'workspace.github_event');
    expect(got.map((f) => f.data?.kind)).toEqual(['ci']);
  });

  it('refuses a malformed event with the reason', async () => {
    const res = await local(eventsPath(), {
      method: 'POST',
      body: event({ text: 'bell \u0007' }),
      headers: bearer(key),
    });
    expect(res.status).toBe(400);
  });
});
