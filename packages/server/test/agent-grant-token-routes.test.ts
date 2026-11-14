/**
 * The `at3` agent grant over the real server: minted at the loopback
 * board-token route only for an agent with a person on the board, admitted
 * like an `at2`, listed with its last use, hung up on revoke, and hung up
 * when its person leaves the board.
 *
 * Real server, port 0, a temp data dir, invented names.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentTokenKey, mintAgentToken } from '../src/auth/agent-token.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { loadCookieKey } from '../src/share/link-session.ts';
import { type SignedInPerson, signedInPerson } from './signed-in-person.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const A1 = 'agent-harborlight-a1';
const B1 = 'agent-riverbend-b1';
const ALICE = 'alice@harborlight.example';
const json = { 'content-type': 'application/json' };

describe('the at3 agent grant over the real server', () => {
  let handle: ServerHandle;
  let dataDir = '';
  let base = '';
  let ws = '';
  let other = '';
  let alice: SignedInPerson;

  const mint = (body: Record<string, unknown>) =>
    fetch(`${base}/api/board-tokens`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ boardId: ws, version: 'at3', ...body }),
    });
  const mintOk = async (): Promise<{ id: string; token: string }> => {
    const res = await mint({ agentId: A1, label: 'Harborlight relay' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; token: string };
    expect(body.token.startsWith('at3.')).toBe(true);
    return body;
  };
  const as = (token: string, path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { ...json, authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  /** An open stream, and a flag that turns true when the server hangs it up. */
  async function openStream(token: string) {
    const res = await as(token, `/workspaces/${ws}/events:stream`, {
      headers: { accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const state = { closed: false };
    void (async () => {
      try {
        while (!(await reader.read()).done) {}
      } catch {}
      state.closed = true;
    })();
    return { state, cancel: () => reader.cancel().catch(() => {}) };
  }
  function joinBoard(email: string) {
    const link = handle.shareLinks.create({ workspaceId: ws, createdBy: 'known-owner' });
    handle.shareLinks.addToAudience(ws, [email], 'Saltmarsh');
    expect(handle.shareLinks.redeem(link.linkId, email)).toMatchObject({ ok: true });
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-at3-routes-'));
    handle = createServer({ port: 0, dataDir } as Parameters<typeof createServer>[0]);
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base, { name: 'Harborlight' });
    other = await seedBoard(base, { name: 'Riverbend' });
    for (const agentId of [A1, B1]) {
      handle.tasks.attachAgent(ws, { agentId, agentName: agentId, runtime: 'claude-code-local' });
      handle.identities.upsertAgent(agentId, agentId);
    }
    alice = signedInPerson(handle, dataDir, base, { email: ALICE, name: 'Alice' });
    joinBoard(ALICE);
    const named = await fetch(`${base}/api/auth/profile`, {
      method: 'POST',
      headers: { ...json, ...alice.headers },
      body: JSON.stringify({ leadAgentId: A1 }),
    });
    expect(named.status).toBe(200);
    const at1 = mintAgentToken(A1, agentTokenKey(loadCookieKey(dataDir)));
    const confirmed = await fetch(`${base}/api/agents/${A1}/person`, {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${at1}` },
      body: JSON.stringify({ personId: alice.user.id }),
    });
    expect(await confirmed.json()).toMatchObject({ state: 'linked' });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('mints only for an agent whose person is on the board, at or below their role', async () => {
    const noPerson = await mint({ agentId: B1 });
    expect(noPerson.status).toBe(400);
    expect(await noPerson.json()).toMatchObject({ error: 'agent_has_no_person' });
    const above = await mint({ agentId: A1, role: 'owner' });
    expect(above.status).toBe(400);
    expect(await above.json()).toMatchObject({ error: 'role_above_person' });
    const offBoard = await mint({ agentId: A1, boardId: other });
    expect(offBoard.status).toBe(400);
    expect(await offBoard.json()).toMatchObject({ error: 'person_not_on_board' });
    const { token } = await mintOk();
    expect(token.startsWith('at3.')).toBe(true);
  });

  it('opens its one board and no other, and the list shows its last use', async () => {
    const { id, token } = await mintOk();
    expect((await as(token, `/workspaces/${ws}/tasks`)).status).toBe(200);
    expect((await as(token, `/workspaces/${other}/tasks`)).status).toBe(403);
    const list = (await (await fetch(`${base}/api/board-tokens`)).json()) as {
      tokens: Array<{ id: string; version?: string; lastUsedAt?: number; lastUsedVia?: string }>;
    };
    const row = list.tokens.find((t) => t.id === id);
    expect(row).toMatchObject({ version: 'at3', lastUsedVia: 'loopback' });
    expect(typeof row?.lastUsedAt).toBe('number');
  });

  it('renews to a value that still opens the board', async () => {
    const { id, token } = await mintOk();
    const res = await as(token, '/api/board-tokens/refresh', { method: 'POST' });
    expect(res.status).toBe(200);
    // Not compared with the old value: inside one millisecond the two are equal.
    const fresh = ((await res.json()) as { token: string }).token;
    expect(fresh.startsWith('at3.')).toBe(true);
    expect((await as(fresh, `/workspaces/${ws}/tasks`)).status).toBe(200);
    const list = (await (await fetch(`${base}/api/board-tokens`)).json()) as {
      tokens: Array<{ id: string; refreshedAt?: number }>;
    };
    expect(typeof list.tokens.find((t) => t.id === id)?.refreshedAt).toBe('number');
  });

  it('revoked: the next request is refused and its open stream is hung up', async () => {
    const { id, token } = await mintOk();
    const stream = await openStream(token);
    const revoked = await fetch(`${base}/api/board-tokens/${id}/revoke`, { method: 'POST' });
    expect(revoked.status).toBe(200);
    await waitFor(() => stream.state.closed, { describe: 'the revoked grant’s stream to close' });
    expect((await as(token, `/workspaces/${ws}/tasks`)).status).toBe(401);
  });

  it('its person removed from the board: refused, and the sweep hangs up its stream', async () => {
    const { token } = await mintOk();
    const stream = await openStream(token);
    expect(handle.shareLinks.removeMember(ws, ALICE)).toBe(true);
    expect((await as(token, `/workspaces/${ws}/tasks`)).status).toBe(401);
    handle.sweepDeadShares();
    await waitFor(() => stream.state.closed, { describe: 'the lapsed grant’s stream to close' });
    joinBoard(ALICE);
    expect((await as(token, `/workspaces/${ws}/tasks`)).status).toBe(200);
  });
});
