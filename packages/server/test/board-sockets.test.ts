/**
 * Board sockets (`src/board-sockets.ts`): one unix socket per board, and a
 * request on one is held to that board (`middleware/board-socket-door.ts`).
 *
 * A. On Harborlight's socket, with no bearer, Harborlight answers and
 *    Riverbend is refused; a forged Host, an `at2` for Riverbend, a browser,
 *    an upgrade and every loopback-only route are refused too.
 * B. The `at1` gap: an agent token on a board socket reaches only its own
 *    watch set, cut to the socket's board, and no agent stream. Over TCP the
 *    same agent can add Riverbend (the control), which is the hole a socket
 *    must not have.
 * C. Boards made, archived and deleted while the server runs open and close
 *    their sockets.
 * D. The socket folder: too long a path is refused, and the folder is private.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentTokenKey, mintAgentToken } from '../src/auth/agent-token.ts';
import {
  SOCKET_PATH_MAX_BYTES,
  boardSocketDirError,
  boardSocketPath,
  openBoardSockets,
} from '../src/board-sockets.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { loadCookieKey } from '../src/share/link-session.ts';
import { waitFor } from './wait-for.ts';

const AGENT = 'agent-harborlight';

let h: ServerHandle;
let dataDir: string;
let socketDir: string;
let base: string;
let harborlight: string;
let riverbend: string;
let at1: string;

const tcp = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      host: `localhost:${h.port}`,
      'content-type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });

/** A request on `board`'s own socket. */
const on = (
  board: string,
  path: string,
  headers: Record<string, string> = {},
  init: RequestInit = {},
) =>
  fetch(`http://board${path}`, {
    ...init,
    unix: boardSocketPath(socketDir, board),
    headers: { 'content-type': 'application/json', ...headers },
  } as RequestInit);

const bearer = (value: string) => ({ authorization: `Bearer ${value}` });

async function board(name: string): Promise<string> {
  const res = await tcp('/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

async function mintAt2(boardId: string): Promise<string> {
  const res = await tcp('/api/board-tokens', {
    method: 'POST',
    body: JSON.stringify({ agentId: AGENT, boardId, label: 'board socket test' }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'board-sock-'));
  // A unix socket path is limited to 104 bytes on macOS, so the sockets sit
  // in their own short folder rather than inside the data folder.
  socketDir = join(mkdtempSync(join(tmpdir(), 'bs-')), 'boards');
  h = createServer({ port: 0, dataDir, boardSocketDir: socketDir });
  base = `http://127.0.0.1:${h.port}`;
  harborlight = await board('Harborlight');
  riverbend = await board('Riverbend');
  at1 = mintAgentToken(AGENT, agentTokenKey(loadCookieKey(dataDir)));
});

afterAll(async () => {
  await h.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('A. a board socket is held to its board', () => {
  it('opens one socket per board, readable by this user alone, in a private folder', () => {
    for (const id of [harborlight, riverbend])
      expect(statSync(boardSocketPath(socketDir, id)).mode & 0o777).toBe(0o600);
    expect(statSync(socketDir).mode & 0o777).toBe(0o700);
  });

  it('reads its own board with no bearer, and is refused another board', async () => {
    const own = await on(harborlight, `/workspaces/${harborlight}/tasks`);
    expect(own.status, await own.clone().text()).toBe(200);
    const other = await on(harborlight, `/workspaces/${riverbend}/tasks`);
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: string }).error).toBe('out_of_board_socket_scope');
    // Riverbend's own socket answers Riverbend: the board is the socket's.
    expect((await on(riverbend, `/workspaces/${riverbend}/tasks`)).status).toBe(200);
  });

  it('ignores a forged Host', async () => {
    const res = await on(harborlight, `/workspaces/${riverbend}/tasks`, { host: 'localhost' });
    expect(res.status).toBe(403);
  });

  it('refuses a board token for another board, and a forged one', async () => {
    const forRiverbend = await mintAt2(riverbend);
    const crossed = await on(harborlight, `/workspaces/${riverbend}/tasks`, bearer(forRiverbend));
    expect(crossed.status).toBe(403);
    const own = await on(
      harborlight,
      `/workspaces/${harborlight}/tasks`,
      bearer(await mintAt2(harborlight)),
    );
    expect(own.status).toBe(200);
    const forged = await on(
      harborlight,
      `/workspaces/${harborlight}/tasks`,
      bearer(`${forRiverbend.slice(0, -4)}AAAA`),
    );
    expect(forged.status).toBe(401);
    const badAt1 = await on(
      harborlight,
      `/workspaces/${harborlight}/tasks`,
      bearer(`at1.${AGENT}.nope`),
    );
    expect(badAt1.status).toBe(401);
  });

  it('refuses a browser, an upgrade, the mints and the cross-board lists', async () => {
    const page = await on(harborlight, `/workspaces/${harborlight}/tasks`, {
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    });
    expect(page.status).toBe(403);
    const upgrade = await on(harborlight, `/workspaces/${harborlight}/tasks`, {
      upgrade: 'websocket',
      connection: 'Upgrade',
    });
    expect(upgrade.status).toBe(403);
    const mint = await on(
      harborlight,
      '/api/board-tokens',
      {},
      {
        method: 'POST',
        body: JSON.stringify({ agentId: AGENT, boardId: riverbend }),
      },
    );
    expect(mint.status).toBe(403);
    for (const path of [
      `/api/agents/${AGENT}/token`,
      '/api/agent-token',
      '/workspaces?format=json',
      '/api/review-queue',
      '/mcp',
    ])
      expect((await on(harborlight, path, bearer(at1))).status, path).toBe(403);
  });

  it('is refused a board closed to outside visitors', async () => {
    h.sharingGate.setBoardEnabled(harborlight, false);
    try {
      expect((await on(harborlight, `/workspaces/${harborlight}/tasks`)).status).toBe(403);
    } finally {
      h.sharingGate.setBoardEnabled(harborlight, true);
    }
    expect((await on(harborlight, `/workspaces/${harborlight}/tasks`)).status).toBe(200);
  });

  it('a trusted-local caller over TCP still reaches every board (the control)', async () => {
    expect((await tcp(`/workspaces/${riverbend}/tasks`)).status).toBe(200);
  });
});

describe('B. an agent token on a board socket reaches only that board', () => {
  const watches = `/api/agents/${AGENT}/watches`;
  const post = (add: string[]) => ({ method: 'POST', body: JSON.stringify({ add }) });

  it('over TCP the same token adds Riverbend to its watches (the control)', async () => {
    const res = await tcp(watches, { ...post([`ws:${riverbend}`]), headers: bearer(at1) });
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it('on Harborlight’s socket it adds Harborlight and is refused Riverbend', async () => {
    const own = await on(harborlight, watches, bearer(at1), post([`ws:${harborlight}`]));
    expect(own.status, await own.clone().text()).toBe(200);
    const other = await on(harborlight, watches, bearer(at1), post([`ws:${riverbend}`]));
    expect(other.status).toBe(403);
  });

  it('lists only Harborlight’s keys there, though the set holds Riverbend’s', async () => {
    const res = await on(harborlight, watches, bearer(at1));
    expect(res.status).toBe(200);
    const keys = ((await res.json()) as { watches: Array<{ key: string }> }).watches.map(
      (w) => w.key,
    );
    expect(keys).toEqual([`ws:${harborlight}`]);
  });

  it('reaches no agent stream, no other agent’s set, and no watches without a token', async () => {
    expect((await on(harborlight, `/events/agent/${AGENT}`, bearer(at1))).status).toBe(403);
    expect((await on(harborlight, '/api/agents/agent-riverbend/watches', bearer(at1))).status).toBe(
      403,
    );
    expect((await on(harborlight, watches)).status).toBe(403);
  });
});

describe('C. sockets follow the boards', () => {
  it('opens a socket for a new board and closes it when the board is archived or deleted', async () => {
    const saltmarsh = await board('Saltmarsh');
    const path = boardSocketPath(socketDir, saltmarsh);
    await waitFor(() => existsSync(path));
    expect((await on(saltmarsh, `/workspaces/${saltmarsh}/tasks`)).status).toBe(200);
    h.tasks.setWorkspaceRetired(saltmarsh, true, { actor: { id: 'agent-test', name: 'test' } });
    await waitFor(() => !existsSync(path));
    h.tasks.setWorkspaceRetired(saltmarsh, false, { actor: { id: 'agent-test', name: 'test' } });
    await waitFor(() => existsSync(path));
    expect(h.tasks.deleteWorkspace(saltmarsh, { force: true }).ok).toBe(true);
    await waitFor(() => !existsSync(path));
  });
});

describe('D. the socket folder', () => {
  it('refuses a folder too long for a socket path, and accepts the default’s length', () => {
    const long = `/private/tmp/${'x'.repeat(SOCKET_PATH_MAX_BYTES)}`;
    expect(boardSocketDirError(long)).toContain('too long');
    expect(() =>
      openBoardSockets({ dir: long, handle: async () => undefined, j: () => new Response() }),
    ).toThrow('too long');
    expect(boardSocketDirError('relative/boards')).toContain('absolute');
    expect(boardSocketDirError('/private/tmp/cw-501-boards')).toBeNull();
  });
});
