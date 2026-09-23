/**
 * `set_board_sharing_lock`, and `attach_folder`'s `privacy` — every argument
 * is sent or refused, and the answer carries what the server said.
 *
 * Driven from SOURCE against a stub server, as `sharing-switch-tool.test.ts`
 * is: the cases assert the body that reached the route. The stub answers a
 * folder bind the way the server does, naming the privacy, so the last case
 * shows that naming reaches the agent's tool result. The server's own answer
 * is `packages/server/test/attachment-privacy-share.test.ts`.
 *
 * Fixtures are synthetic; the agent name is fictional.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { type Server, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isBackgroundRequest } from './harness/background-requests.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = join(HERE, '../src/mcp.ts');
const AGENT = 'Beacon Bot';

type Recorded = { method: string; path: string; body: Record<string, unknown> };
type Reply = {
  result?: { isError?: boolean; content?: Array<{ text: string }> };
  error?: { message: string };
};

const seen: Recorded[] = [];
let stub: Server;
let child: ChildProcess;
let nextId = 100;
let pending = '';
const waiters = new Map<number, (value: unknown) => void>();

function replyFor(path: string, body: Record<string, unknown>): unknown {
  if (path === '/api/share') {
    return {
      shares: [],
      links: [],
      members: [],
      sharing: { enabled: true, locked: false, lockedBoards: ['w-locked'] },
    };
  }
  if (path === '/workspaces') {
    const privacy = body.privacy ?? 'workspace';
    return {
      ok: true,
      setId: 'w-set',
      privacy,
      privacyNote:
        privacy === 'local-only' ? 'This folder is local-only.' : 'This folder is shareable.',
      files: [],
    };
  }
  return { ok: true };
}

function send(msg: unknown) {
  child.stdin?.write(`${JSON.stringify(msg)}\n`);
}

function rpc(method: string, params: unknown): Promise<Reply> {
  const id = nextId++;
  return new Promise((resolve) => {
    waiters.set(id, (v) => resolve(v as Reply));
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function call(name: string, args: Record<string, unknown>): Promise<Reply> {
  return rpc('tools/call', { name, arguments: args });
}

function payload(reply: Reply): Record<string, unknown> {
  expect(reply.result?.isError, reply.result?.content?.[0]?.text).not.toBe(true);
  return JSON.parse(reply.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

/**
 * Only the verb's POSTs. The child also restores its watches against the
 * stub on initialize, redials its event stream and fires a heartbeat it does
 * not await; the recorder drops that traffic (`background-requests.ts`), and
 * this narrows to one route on top of it.
 */
function postsTo(path: string): Recorded[] {
  return seen.filter((r) => r.method === 'POST' && r.path === path);
}

function lastTo(path: string): Recorded {
  const r = postsTo(path).at(-1);
  expect(r, `the stub server received no POST to ${path}`).toBeTruthy();
  return r as Recorded;
}

beforeAll(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      const path = req.url ?? '';
      let body: Record<string, unknown> = {};
      try {
        body = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      const rec = { method: req.method ?? '', path, body };
      if (!isBackgroundRequest(rec)) seen.push(rec);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(replyFor(path, body)));
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const port = (stub.address() as AddressInfo).port;

  child = spawn('bun', ['run', MCP_ENTRY], {
    env: {
      ...process.env,
      CW_BASE_URL: `http://127.0.0.1:${port}`,
      FEEDBACK_BASE_URL: `http://127.0.0.1:${port}`,
      CW_AGENT_NAME: AGENT,
      CW_WORKSPACE_ID: 'w-home',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => {
    pending += d.toString();
    let nl = pending.indexOf('\n');
    while (nl !== -1) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (line.startsWith('{')) {
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === 'number') waiters.get(msg.id)?.(msg);
        waiters.delete(msg.id as number);
      }
      nl = pending.indexOf('\n');
    }
  });

  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'board-lock-tool-test', version: '0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}, 30_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => stub?.close(() => r()));
});

describe('set_board_sharing_lock', () => {
  it('sends the board, the lock, the reason and this session', async () => {
    const before = postsTo('/api/share/lock').length;
    payload(
      await call('set_board_sharing_lock', {
        workspaceId: 'w-harbor',
        locked: true,
        reason: 'a private folder is attached',
      }),
    );
    expect(postsTo('/api/share/lock').length).toBe(before + 1);
    expect(lastTo('/api/share/lock').body).toEqual({
      workspaceId: 'w-harbor',
      locked: true,
      reason: 'a private folder is attached',
      actor: { id: expect.any(String), name: AGENT },
    });
  });

  it('refuses an argument it does not read, before anything is sent', async () => {
    const before = postsTo('/api/share/lock').length;
    const reply = await call('set_board_sharing_lock', { workspaceId: 'w-harbor', enabled: false });
    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.content?.[0]?.text).toContain('enabled');
    expect(postsTo('/api/share/lock').length).toBe(before);
  });

  it('refuses a call with no board', async () => {
    const reply = await call('set_board_sharing_lock', { locked: true });
    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.content?.[0]?.text).toContain('workspaceId');
  });

  it("reads one board's lock without changing anything when locked is omitted", async () => {
    const before = postsTo('/api/share/lock').length;
    expect(
      payload(await call('set_board_sharing_lock', { workspaceId: 'w-locked' })).board,
    ).toEqual({ workspaceId: 'w-locked', locked: true });
    expect(
      payload(await call('set_board_sharing_lock', { workspaceId: 'w-harbor' })).board,
    ).toEqual({ workspaceId: 'w-harbor', locked: false });
    expect(postsTo('/api/share/lock').length).toBe(before);
  });
});

describe('attach_folder privacy', () => {
  it('sends local-only to the server, and the answer names it', async () => {
    const out = payload(
      await call('attach_folder', {
        workspaceId: 'w-harbor',
        folderPath: '/tmp/harborlight',
        privacy: 'local-only',
        subscribe: false,
      }),
    );
    expect(lastTo('/workspaces').body.privacy).toBe('local-only');
    expect(out.privacy).toBe('local-only');
  });

  it('sends no privacy when it was omitted, and the answer says shareable', async () => {
    const out = payload(
      await call('attach_folder', {
        workspaceId: 'w-harbor',
        folderPath: '/tmp/riverbend',
        subscribe: false,
      }),
    );
    expect('privacy' in lastTo('/workspaces').body).toBe(false);
    expect(out.privacy).toBe('workspace');
    expect(out.privacyNote).toContain('shareable');
  });
});
