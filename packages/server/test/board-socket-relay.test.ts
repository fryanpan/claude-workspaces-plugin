/**
 * The relay a walled lead runs (option G's item 4): the node relay, started
 * through the plugin's own launcher with `CW_BOARD_SOCKET` set, reaches its
 * board over that board's unix socket and nothing else, and holds no token.
 *
 * A. Without a sandbox: the session is the server's (not the relay's local
 *    fallback), its tools reach Harborlight and are refused Riverbend, its
 *    pushes come from Harborlight only, the board token its calls carry is
 *    on the server's record, and the relay's own environment holds no `at1`
 *    or `at2`.
 * B. The door a session id was opened through is the only one it answers
 *    on: a socket session's id is refused over TCP and on Riverbend's socket.
 * C. Under the real `/usr/bin/sandbox-exec`, with the board wall's rules and a
 *    deny on this server's TCP port: the relay's calls go over the socket.
 *    The controls, under the same profile: the relay pointed at TCP gets no
 *    server, and pointed at Riverbend's socket gets no server. Skipped, and
 *    saying so, where there is no sandbox-exec (Linux CI).
 *
 * All fixtures synthetic; port 0; a short socket folder under /private/tmp,
 * because a unix socket path must fit in 104 bytes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardWallRules } from '../../../scripts/lead-sandbox-wall.ts';
import { resolveAgentAuthor } from '../../mcp/src/author.ts';
import { agentTokenKey, mintAgentToken } from '../src/auth/agent-token.ts';
import { type BoardTokenRecord, boardTokensPath } from '../src/auth/board-agent-token.ts';
import { boardSocketPath } from '../src/board-sockets.ts';
import { BOARD_SOCKET_SESSION_LABEL } from '../src/connector/board-token-lease.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { loadCookieKey } from '../src/share/link-session.ts';
import { type StdioChild, nodeRelayArm, startChild } from './relay-harness.ts';
import { waitFor } from './wait-for.ts';

const AGENT = 'Harborlight Lead';
const AGENT_ID = resolveAgentAuthor({ CW_AGENT_NAME: AGENT, CW_AUTHOR: 'agent' }).id;
const PERSON = { id: 'known-reviewer', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const ARM = nodeRelayArm();
/** What the relay says when it answered initialize itself. */
const LOCAL_ANSWER = 'did not answer when this session started';

let h: ServerHandle;
let dataDir: string;
let workDir: string;
let socketRoot: string;
let socketDir: string;
let base: string;
let harborlight: string;
let riverbend: string;
let children: StdioChild[] = [];

async function board(name: string): Promise<string> {
  const res = await fetch(`${base}/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

async function makeDoc(ws: string, alias: string): Promise<string> {
  const path = join(workDir, `${alias}.md`);
  writeFileSync(path, `# ${alias}\n\nBody.\n`);
  const res = await fetch(`${base}/workspaces/${ws}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: alias, sourceUrl: path, title: alias }),
  });
  return ((await res.json()) as { docId: string }).docId;
}

function comment(ws: string, docId: string, text: string): Promise<Response> {
  return fetch(`${base}/workspaces/${ws}/docs/${docId}/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ author: PERSON, text, anchor: { kind: 'subject' } }),
  });
}

/** The relay as a walled lead starts it: no base URL, its board's socket. */
function lead(env: Record<string, string>, prefix: string[] = []): StdioChild {
  const child = startChild(
    ARM,
    { CW_AGENT_NAME: AGENT, CW_RELAY_INIT_WAIT_MS: '1500', ...env },
    workDir,
    prefix,
  );
  children.push(child);
  return child;
}

const instructionsOf = (init: Record<string, unknown>) =>
  String((init.result as { instructions?: unknown } | undefined)?.instructions ?? '');

const channelWith = (c: StdioChild, text: string) =>
  c.channel().find((p) => String(p.content).includes(text));

/** A process's environment as `ps` prints it after its command line. */
function environmentOf(pid: number): string {
  const r = spawnSync('/bin/ps', ['eww', '-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8',
  });
  return r.stdout;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'board-sock-relay-'));
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'board-sock-relay-work-')));
  socketRoot = mkdtempSync(
    process.platform === 'darwin' ? '/private/tmp/bsr-' : join(tmpdir(), 'bsr-'),
  );
  socketDir = join(socketRoot, 'boards');
  h = createServer({ port: 0, dataDir, boardSocketDir: socketDir });
  base = `http://127.0.0.1:${h.port}`;
  harborlight = await board('Harborlight');
  riverbend = await board('Riverbend');
});

afterEach(async () => {
  for (const c of children) await c.stop();
  children = [];
});

afterAll(async () => {
  await h.stop();
  for (const d of [dataDir, workDir, socketRoot]) rmSync(d, { recursive: true, force: true });
});

describe('A. the relay on its board socket', () => {
  it('is served by the server, reaches its own board and is refused another', async () => {
    const child = lead({ CW_BOARD_SOCKET: boardSocketPath(socketDir, harborlight) });
    const init = await child.handshake();
    expect(instructionsOf(init)).not.toContain(LOCAL_ANSWER);
    expect(instructionsOf(init).length).toBeGreaterThan(200);
    await waitFor(() => child.stderr().includes('node relay started on a board socket'), {
      describe: 'the socket banner',
    });

    const own = await child.callTool('list_tasks', { workspaceId: harborlight });
    expect(own.isError, own.text).toBe(false);
    const other = await child.callTool('list_tasks', { workspaceId: riverbend });
    expect(other.isError).toBe(true);
    expect(other.text).toContain('403');
  }, 30_000);

  it('hears comments on its own board and not on another', async () => {
    const ownDoc = await makeDoc(harborlight, 'harbor-plan');
    const otherDoc = await makeDoc(riverbend, 'river-plan');
    const child = lead({ CW_BOARD_SOCKET: boardSocketPath(socketDir, harborlight) });
    await child.handshake();
    expect((await child.callTool('watch_doc', { docId: ownDoc })).isError).toBe(false);
    // The tool keeps an in-memory watch whatever the server says; the server
    // refuses to store it (out_of_board_token_scope), and that is what the
    // stream reads.
    await child.callTool('watch_doc', { docId: otherDoc });

    // The same agent over TCP, with its own token, does store a Riverbend
    // watch: the agent's set is one set, so only the stream's cut to the
    // socket's board keeps this out.
    const at1 = mintAgentToken(AGENT_ID, agentTokenKey(loadCookieKey(dataDir)));
    const stored = await fetch(`${base}/api/agents/${AGENT_ID}/watches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${at1}` },
      body: JSON.stringify({ add: [otherDoc] }),
    });
    expect(stored.status, await stored.clone().text()).toBe(200);

    await comment(riverbend, otherDoc, 'a Riverbend line');
    await comment(harborlight, ownDoc, 'a Harborlight line');
    await waitFor(() => channelWith(child, 'a Harborlight line'), {
      timeout: 10_000,
      describe: 'the Harborlight comment',
    });
    // Posted first, and the stream is ordered: had it been sent, it would be here.
    expect(channelWith(child, 'a Riverbend line')).toBeUndefined();
  }, 30_000);

  it('holds no token: the board token is the server’s, and the relay’s environment has none', async () => {
    const child = lead({ CW_BOARD_SOCKET: boardSocketPath(socketDir, harborlight) });
    await child.handshake();
    expect((await child.callTool('list_tasks', { workspaceId: harborlight })).isError).toBe(false);

    // The server minted one for this agent and board, and keeps it.
    const records = JSON.parse(readFileSync(boardTokensPath(dataDir), 'utf8')) as {
      tokens: BoardTokenRecord[];
    };
    const held = records.tokens.filter(
      (r) => r.label === BOARD_SOCKET_SESSION_LABEL && r.revokedAt === undefined,
    );
    expect(held.map((r) => [r.agentId, r.boardId])).toContainEqual([AGENT_ID, harborlight]);

    const env = environmentOf(child.pid);
    // The positive control: this is the relay's environment, read.
    expect(env).toContain(`CW_BOARD_SOCKET=${boardSocketPath(socketDir, harborlight)}`);
    expect(env).not.toMatch(/\bat[12]\./);
    expect(env).not.toMatch(/(AGENT|BOARD)_TOKEN=/);
  }, 30_000);
});

describe('B. a session answers only on the door it was opened through', () => {
  it('refuses a socket session’s id over TCP and on another board’s socket', async () => {
    const own = boardSocketPath(socketDir, harborlight);
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-cw-agent': AGENT,
      'x-cw-cwd': workDir,
    };
    const init = await fetch('http://board/mcp', {
      method: 'POST',
      unix: own,
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      }),
    } as RequestInit);
    expect(init.status, await init.clone().text()).toBe(200);
    const sid = init.headers.get('mcp-session-id') ?? '';
    const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const withSid = { ...headers, 'mcp-session-id': sid };

    const same = await fetch('http://board/mcp', {
      method: 'POST',
      unix: own,
      headers: withSid,
      body: list,
    } as RequestInit);
    expect(same.status).toBe(200);
    const riverSocket = await fetch('http://board/mcp', {
      method: 'POST',
      unix: boardSocketPath(socketDir, riverbend),
      headers: withSid,
      body: list,
    } as RequestInit);
    expect(riverSocket.status).toBe(403);
    // Over TCP the route asks the agent's token first; with it, the host
    // still refuses a session opened on a socket.
    const at1 = mintAgentToken(AGENT_ID, agentTokenKey(loadCookieKey(dataDir)));
    const tcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...withSid, authorization: `Bearer ${at1}` },
      body: list,
    });
    expect(tcp.status).toBe(403);
  }, 30_000);
});

const CAN_SANDBOX = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
if (!CAN_SANDBOX) console.warn(`[board-socket-relay] C skipped: no ${SANDBOX_EXEC} here`);

describe.skipIf(!CAN_SANDBOX)('C. under the real sandbox-exec', () => {
  let profile: string;

  beforeAll(() => {
    // The board wall's own rules, plus this test server's port: the wall's
    // port list names 8787 to 8790, and this server is on a spare one.
    const rules = [
      '(version 1)',
      '(allow default)',
      `(deny network-outbound (remote ip "*:${h.port}"))`,
      ...boardWallRules({ boardWall: true, boardId: harborlight }, socketDir, realpathSync),
    ];
    profile = join(socketRoot, 'harborlight.sb');
    writeFileSync(profile, `${rules.join('\n')}\n`);
  });

  const walled = (env: Record<string, string>) => lead(env, [SANDBOX_EXEC, '-f', profile]);

  it('carries the lead’s MCP calls over its own board’s socket', async () => {
    const child = walled({ CW_BOARD_SOCKET: boardSocketPath(socketDir, harborlight) });
    const init = await child.handshake();
    expect(instructionsOf(init)).not.toContain(LOCAL_ANSWER);
    const own = await child.callTool('list_tasks', { workspaceId: harborlight });
    expect(own.isError, own.text).toBe(false);
    const other = await child.callTool('list_tasks', { workspaceId: riverbend });
    expect(other.isError).toBe(true);
  }, 30_000);

  it('control: the same profile refuses the relay that dials TCP', async () => {
    const child = walled({ CW_BASE_URL: base });
    const init = await child.handshake();
    expect(instructionsOf(init)).toContain(LOCAL_ANSWER);
  }, 30_000);

  it('control: the same profile refuses the relay that dials another board’s socket', async () => {
    const child = walled({ CW_BOARD_SOCKET: boardSocketPath(socketDir, riverbend) });
    const init = await child.handshake();
    expect(instructionsOf(init)).toContain(LOCAL_ANSWER);
  }, 30_000);
});
