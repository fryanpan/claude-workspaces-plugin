/**
 * `say_in_meeting` — the board's lead says one line into the meeting its
 * board's chat is running (`routes/workspace-lead-chat.ts`, `leadSays`).
 *
 * Driven from SOURCE (`bun run src/mcp.ts`), as answer-voice-tool.test.ts
 * is, against a stub that records what reached it. The assertions are the
 * route and the body, and what the agent is told when the server refuses.
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

/** A meeting runs on `w-live` only; `w-other` has a different lead. */
function replyFor(path: string): { status: number; body: unknown } {
  if (path.startsWith('/workspaces/w-live/'))
    return { status: 200, body: { ok: true, played: true } };
  if (path.startsWith('/workspaces/w-quiet/'))
    return { status: 409, body: { error: 'no-meeting' } };
  if (path.startsWith('/workspaces/w-other/')) return { status: 403, body: { error: 'not-lead' } };
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
function sayPosts(): Recorded[] {
  return seen.filter((r) => r.method === 'POST' && /\/lead-chat\/meeting\/say$/.test(r.path));
}

function last(): Recorded {
  const r = sayPosts().at(-1);
  expect(r, 'the stub server received no say POST at all').toBeTruthy();
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
    clientInfo: { name: 'say-in-meeting-tool-test', version: '0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}, 30_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => stub?.close(() => r()));
});

describe('say_in_meeting — the lead speaks into its meeting', () => {
  it('posts the line to the board’s meeting with this session’s id, in one call', async () => {
    const out = payload(
      await call('say_in_meeting', { workspaceId: 'w-live', text: '  Who is it for?  ' }),
    );
    expect(last().path).toBe('/workspaces/w-live/lead-chat/meeting/say');
    expect(last().body).toEqual({
      agentId: expect.stringMatching(/^agent-/),
      text: 'Who is it for?',
    });
    expect(out).toEqual({ said: true, played: true });
  });

  it('answers, rather than fails, when no meeting runs or the caller is not the lead', async () => {
    const quiet = payload(await call('say_in_meeting', { workspaceId: 'w-quiet', text: 'Hi.' }));
    expect(quiet).toMatchObject({ said: false, reason: 'no-meeting' });
    const other = payload(await call('say_in_meeting', { workspaceId: 'w-other', text: 'Hi.' }));
    expect(other).toMatchObject({ said: false, reason: 'not-lead' });
  });

  it('refuses empty text and a missing board before anything leaves the process', async () => {
    const before = sayPosts().length;
    expect(
      (await call('say_in_meeting', { workspaceId: 'w-live', text: ' ' })).result?.isError,
    ).toBe(true);
    expect((await call('say_in_meeting', { text: 'Hi.' })).result?.isError).toBe(true);
    expect(sayPosts().length).toBe(before);
  });
});
