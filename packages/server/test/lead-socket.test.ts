/**
 * The lead socket (`src/lead-socket.ts`): a sandboxed lead's one way in,
 * admitting a board agent token (`at2`) and nothing else.
 *
 * Over the socket, Harborlight's token reads Harborlight and is refused
 * Riverbend; no token, an `at1`, any other bearer and a forged `Host` are each
 * a 401. Over TCP from loopback the same requests are the positive controls:
 * with no token a trusted-local caller reaches Riverbend, so the socket's
 * refusals are the socket's and not the board's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentTokenKey, mintAgentToken } from '../src/auth/agent-token.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { loadCookieKey } from '../src/share/link-session.ts';

const AGENT = 'agent-harborlight';

let h: ServerHandle;
let dataDir: string;
let socketPath: string;
let base: string;
let harborlight: string;
let riverbend: string;
let token: string;

const tcp = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      host: `localhost:${h.port}`,
      'content-type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });

const viaSocket = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  fetch(`http://lead${path}`, {
    ...init,
    unix: socketPath,
    headers: { 'content-type': 'application/json', ...headers },
  } as RequestInit);

const bearer = (value: string) => ({ authorization: `Bearer ${value}` });

async function board(name: string): Promise<string> {
  const res = await tcp('/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'lead-sock-'));
  // A unix socket path is limited to 104 bytes on macOS, so it sits in its
  // own short folder rather than inside the data folder.
  socketPath = join(mkdtempSync(join(tmpdir(), 'ls-')), 'lead.sock');
  h = createServer({ port: 0, dataDir, leadSocketPath: socketPath });
  base = `http://127.0.0.1:${h.port}`;
  harborlight = await board('Harborlight');
  riverbend = await board('Riverbend');
  const minted = await tcp('/api/board-tokens', {
    method: 'POST',
    body: JSON.stringify({ agentId: AGENT, boardId: harborlight, label: 'lead socket test' }),
  });
  expect(minted.status, await minted.clone().text()).toBe(201);
  token = ((await minted.json()) as { token: string }).token;
});

afterAll(async () => {
  await h.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the lead socket', () => {
  it('is readable by this user alone', () => {
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it("reads its own board's tasks with its token, and is refused another board's", async () => {
    const own = await viaSocket(`/workspaces/${harborlight}/tasks`, bearer(token));
    expect(own.status, await own.clone().text()).toBe(200);
    const other = await viaSocket(`/workspaces/${riverbend}/tasks`, bearer(token));
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: string }).error).toBe('out_of_board_token_scope');
  });

  it('refuses no token, an at1, any other bearer and a forged Host with a 401', async () => {
    const at1 = mintAgentToken(AGENT, agentTokenKey(loadCookieKey(dataDir)));
    const cases: Array<[string, Record<string, string>]> = [
      // First: without the listener's mark, this one is trusted-local.
      ['no token, Host: localhost', { host: 'localhost' }],
      ['no token', {}],
      ['an at1', bearer(at1)],
      ['another bearer', bearer('not-a-board-token')],
      ['a forged at2', bearer(`${token.slice(0, -4)}AAAA`)],
    ];
    for (const [what, headers] of cases) {
      const res = await viaSocket(`/workspaces/${riverbend}/tasks`, headers);
      expect(res.status, what).toBe(401);
    }
  });

  it('refuses a browser carrying the token, and a websocket upgrade', async () => {
    const page = await viaSocket(`/workspaces/${harborlight}/tasks`, {
      ...bearer(token),
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    });
    expect(page.status).toBe(403);
    const upgrade = await viaSocket(`/workspaces/${harborlight}/tasks`, {
      ...bearer(token),
      upgrade: 'websocket',
      connection: 'Upgrade',
    });
    expect(upgrade.status).toBe(403);
  });

  it('reaches none of the loopback-only routes, whatever the token', async () => {
    const mint = await viaSocket('/api/board-tokens', bearer(token), {
      method: 'POST',
      body: JSON.stringify({ agentId: AGENT, boardId: riverbend }),
    });
    expect(mint.status).toBe(403);
    expect((await viaSocket('/workspaces?format=json', bearer(token))).status).toBe(403);
  });
});

describe('the positive controls, over TCP from loopback', () => {
  it('a trusted-local caller with no token reaches the other board', async () => {
    expect((await tcp(`/workspaces/${riverbend}/tasks`)).status).toBe(200);
  });

  it('the same token over TCP is held to its board, as on the socket', async () => {
    expect((await tcp(`/workspaces/${harborlight}/tasks`, { headers: bearer(token) })).status).toBe(
      200,
    );
    expect((await tcp(`/workspaces/${riverbend}/tasks`, { headers: bearer(token) })).status).toBe(
      403,
    );
  });
});
