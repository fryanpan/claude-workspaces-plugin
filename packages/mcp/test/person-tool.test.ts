/**
 * `watch_person` and `show_person` — an agent hears where the board owner's
 * attended tab lands, and takes that one tab to a place
 * (`routes/workspace-point.ts`, `person-presence.ts`).
 *
 * Driven from SOURCE (`bun run src/mcp.ts`), as point-at-tool.test.ts is,
 * against a stub that records what reached it. The assertions are the route,
 * the body, the token, and what the agent is told when nobody is there.
 *
 * Fixtures are synthetic; every name is a house fixture name.
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
const AGENT = 'Harborlight Lead';

type Recorded = {
  method: string;
  path: string;
  body: Record<string, unknown>;
  authorization?: string;
};

/** The token the stub mints, as the server's mint route would. */
const TOKEN = 'at1.agent-house-lead.stub';
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

const LANDING = {
  workspaceId: 'w-live',
  person: { id: 'known-riverbend', name: 'Riverbend' },
  resource: { kind: 'doc', id: 'd-quay' },
  spot: { surface: 'doc', docId: 'd-quay' },
};

/** `w-live` has the owner on it; `w-empty` has nobody attending. */
function replyFor(path: string): { status: number; body: unknown } {
  if (/^\/api\/agents\/[^/]+\/token$/.test(path)) return { status: 200, body: { token: TOKEN } };
  if (path === '/workspaces/w-empty/person/show') {
    return {
      status: 409,
      body: { error: 'not-here', message: 'Nobody is looking at this board.' },
    };
  }
  if (path === '/workspaces/w-live/person/show') {
    return { status: 200, body: { ok: true, spot: { surface: 'doc', docId: 'd-quay' } } };
  }
  if (/^\/api\/agents\/[^/]+\/person$/.test(path)) {
    return { status: 200, body: { ok: true, state: 'pending' } };
  }
  if (path === '/workspaces/w-live/person/watch') {
    return { status: 200, body: { ok: true, watching: true, landing: LANDING } };
  }
  return { status: 200, body: {} };
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
 * Only the line POSTs. The child also restores its watches against the stub
 * on initialize, redials its event stream on a backoff of its own, and fires
 * a heartbeat it does not await — all of which race a tool call. The recorder
 * drops that traffic (`background-requests.ts`); this narrows to the verb on
 * top of it.
 */
function personPosts(): Recorded[] {
  return seen.filter(
    (r) => r.method === 'POST' && /(\/person\/(watch|show)|\/agents\/[^/]+\/person)$/.test(r.path),
  );
}

function last(): Recorded {
  const r = personPosts().at(-1);
  expect(r, 'the stub server received no person POST at all').toBeTruthy();
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
      const rec: Recorded = {
        method: req.method ?? '',
        path,
        body,
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      };
      if (!isBackgroundRequest(rec)) seen.push(rec);
      const reply = replyFor(path);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
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
    clientInfo: { name: 'person-tool-test', version: '0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}, 30_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => stub?.close(() => r()));
});

describe('watch_person and show_person', () => {
  it('starts a watch with this session\u2019s id and token, and says where the owner is now', async () => {
    const out = payload(await call('watch_person', { workspaceId: 'w-live' }));
    expect(last().path).toBe('/workspaces/w-live/person/watch');
    expect(last().body).toEqual({
      agentId: expect.stringMatching(/^agent-/),
      agentName: AGENT,
      on: true,
    });
    expect(last().authorization).toBe(`Bearer ${TOKEN}`);
    expect(out).toMatchObject({ watching: true, landing: { resource: { id: 'd-quay' } } });
    await call('watch_person', { workspaceId: 'w-live', on: false });
    expect(last().body).toMatchObject({ on: false });
  });

  it('sends the place to show, the same place fields point_at takes', async () => {
    const out = payload(
      await call('show_person', {
        workspaceId: 'w-live',
        docId: 'd-quay',
        quote: ' opens at dawn ',
      }),
    );
    expect(last().path).toBe('/workspaces/w-live/person/show');
    expect(last().body).toEqual({
      agentId: expect.stringMatching(/^agent-/),
      agentName: AGENT,
      docId: 'd-quay',
      quote: 'opens at dawn',
    });
    expect(last().authorization).toBe(`Bearer ${TOKEN}`);
    expect(out).toMatchObject({ shown: true });
  });

  it('says nobody is looking, rather than failing, when no tab is attended', async () => {
    const out = payload(await call('show_person', { workspaceId: 'w-empty', path: 'home' }));
    expect(out).toMatchObject({ shown: false, error: 'not-here' });
  });
});

describe('confirm_person', () => {
  it("posts this agent's side of the link with its token, and says the link is pending", async () => {
    const out = payload(await call('confirm_person', { email: 'alice@example.com' }));
    expect(last().path).toMatch(/^\/api\/agents\/agent-[^/]+\/person$/);
    expect(last().body).toEqual({ email: 'alice@example.com' });
    expect(last().authorization).toBe(`Bearer ${TOKEN}`);
    expect(out).toMatchObject({ ok: true, state: 'pending' });
  });

  it('clears its side with email null', async () => {
    payload(await call('confirm_person', { email: null }));
    expect(last().body).toEqual({ personId: null });
  });
});
