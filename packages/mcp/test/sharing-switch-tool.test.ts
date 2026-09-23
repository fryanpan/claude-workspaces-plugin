/**
 * `set_sharing_enabled` — every argument is sent or refused.
 *
 * On 23 September a call passed a workspaceId to this tool, the handler
 * dropped it, and the master switch went off for every board while the answer
 * said `ok`. These cases drive the tool from SOURCE against a stub server and
 * assert the body that reached the route: a workspaceId travels to the server
 * (which narrows that one board and echoes the id), the reason and this
 * session's identity travel with every flip, and an argument the tool does
 * not read is refused before anything leaves the process.
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

function replyFor(path: string): unknown {
  if (path === '/api/share') {
    return {
      shares: [],
      links: [],
      members: [],
      sharing: { enabled: true, locked: false, closedBoards: ['w-closed'] },
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
 * Only the note POSTs. The child also restores its watches against the stub
 * on initialize, redials its event stream on a backoff of its own, and fires
 * a heartbeat it does not await — all of which race a tool call. The recorder
 * drops that traffic (`background-requests.ts`); this narrows to the verb on
 * top of it.
 */
function switchPosts(): Recorded[] {
  return seen.filter((r) => r.method === 'POST' && r.path === '/api/share/enabled');
}

function last(): Recorded {
  const r = switchPosts().at(-1);
  expect(r, 'the stub server received no switch POST at all').toBeTruthy();
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
      res.end(JSON.stringify(replyFor(path)));
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
    clientInfo: { name: 'sharing-switch-tool-test', version: '0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}, 30_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => stub?.close(() => r()));
});

describe('set_sharing_enabled', () => {
  it('sends the workspaceId, the reason and this session, so the server narrows one board', async () => {
    const before = switchPosts().length;
    payload(
      await call('set_sharing_enabled', {
        workspaceId: 'w-harbor',
        enabled: false,
        reason: 'binding a sensitive folder',
      }),
    );
    expect(switchPosts().length).toBe(before + 1);
    expect(last().body).toEqual({
      enabled: false,
      workspaceId: 'w-harbor',
      reason: 'binding a sensitive folder',
      actor: { id: expect.any(String), name: AGENT },
    });
  });

  it('sends no workspaceId for the master switch, and still names who and why', async () => {
    payload(await call('set_sharing_enabled', { enabled: true, reason: 'review done' }));
    expect(last().body).toEqual({
      enabled: true,
      reason: 'review done',
      actor: { id: expect.any(String), name: AGENT },
    });
  });

  it('refuses an argument it does not read, before anything is sent', async () => {
    const before = switchPosts().length;
    const reply = await call('set_sharing_enabled', { enabled: false, board: 'w-harbor' });
    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.content?.[0]?.text).toContain('board');
    expect(switchPosts().length).toBe(before);
  });

  it("reads one board's state without changing anything when enabled is omitted", async () => {
    const before = switchPosts().length;
    const out = payload(await call('set_sharing_enabled', { workspaceId: 'w-closed' }));
    expect(out.board).toEqual({ workspaceId: 'w-closed', enabled: false });
    expect(switchPosts().length).toBe(before);
  });
});
