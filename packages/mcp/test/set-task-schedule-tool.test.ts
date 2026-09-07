/**
 * `set_task_schedule` — the one MCP door onto `POST .../tasks/:id/schedule`.
 *
 * It exists because the first peer to arm real rules (2026-09-07) found no
 * verb and had to go to HTTP, which is the surface the board's own agents
 * are steered away from. What this file asserts is the pair nothing else
 * checks: the ROUTE and the BODY the tool sends — the rule as the route
 * reads it, untouched, with `null` meaning clear — and that the reply is the
 * stored schedule read back with its next firing, not an echo of the ask.
 *
 * Driven from source, on the harness `block-task-tool.test.ts` uses.
 * Fixtures are synthetic; the agent name is fictional.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isBackgroundRequest } from './harness/background-requests.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = join(HERE, '../src/mcp.ts');
const AGENT = 'Beacon Bot';
const WS = 'w-board';

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

/** A fixed "now" the stub arms rules at, so the next firing is computable. */
const ARMED_AT = Date.UTC(2026, 8, 7, 12, 0, 0);

/**
 * The store's answer: the schedule as STORED — with an `armedAt` and
 * `armedBy` the caller never sent — so a reply that echoed the request
 * would be caught. `rule: null` answers with no schedule at all; a rule the
 * server refuses answers 400 in the route's own words.
 */
function replyFor(path: string, body: Record<string, unknown>): { status: number; json: unknown } {
  if (!/^\/workspaces\/[^/]+\/tasks\/[^/]+\/schedule$/.test(path)) {
    return { status: 200, json: { ok: true } };
  }
  const task = { id: 't-1', title: 'Weekly digest', status: 'todo' };
  if (body.rule === null) return { status: 200, json: { ok: true, task, changed: true } };
  const rule = body.rule as { kind?: string } | undefined;
  if (rule?.kind !== 'calendar' && rule?.kind !== 'every') {
    return { status: 400, json: { error: 'rule.kind must be one of once | every | calendar' } };
  }
  const schedule = {
    rule: body.rule,
    ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
    ...(body.onMissed !== undefined ? { onMissed: body.onMissed } : {}),
    armedAt: ARMED_AT,
    armedBy: 'stored-by-the-store',
  };
  return { status: 200, json: { ok: true, task: { ...task, schedule }, schedule } };
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

function schedulePosts(): Recorded[] {
  return seen.filter((r) => r.method === 'POST' && /\/schedule$/.test(r.path));
}

function last(): Recorded {
  const r = schedulePosts().at(-1);
  expect(r, 'the stub server received no schedule POST at all').toBeTruthy();
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
      const { status, json } = replyFor(path, body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
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
    clientInfo: { name: 'set-task-schedule-tool-test', version: '0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}, 30_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => stub?.close(() => r()));
});

describe('set_task_schedule — the rule for when a row starts', () => {
  it('is advertised', async () => {
    const reply = (await rpc('tools/list', {})) as unknown as {
      result: { tools: Array<{ name: string; inputSchema: { required: string[] } }> };
    };
    const tool = reply.result.tools.find((t) => t.name === 'set_task_schedule');
    expect(tool).toBeTruthy();
    expect(tool?.inputSchema.required).toEqual(['workspaceId', 'taskId', 'rule']);
  });

  it('sends the rule to the schedule route as given, and reads the stored schedule back', async () => {
    const rule = { kind: 'calendar', times: [{ hour: 6, minute: 47 }], weekdays: [1] };
    const out = payload(
      await call('set_task_schedule', {
        workspaceId: WS,
        taskId: 't-1',
        rule,
        timezone: 'America/Los_Angeles',
        onMissed: 'skip',
      }),
    );
    expect(last().path).toBe(`/workspaces/${WS}/tasks/t-1/schedule`);
    expect(last().body.rule).toEqual(rule);
    expect(last().body.timezone).toBe('America/Los_Angeles');
    expect(last().body.onMissed).toBe('skip');
    expect(last().body).not.toHaveProperty('until');
    expect((last().body.author as { name: string }).name).toBe(AGENT);
    // The STORED schedule — armedBy is the store's word, not the caller's.
    expect(out.schedule).toMatchObject({ rule, timezone: 'America/Los_Angeles', onMissed: 'skip' });
    expect((out.schedule as { armedBy: string }).armedBy).toBe('stored-by-the-store');
    // The next firing: the arming day is itself a Monday, so the same day
    // at 06:47 Los Angeles time (13:47 UTC under daylight saving) — computed
    // from the stored schedule, not asserted by the stub.
    expect(out.nextAtIso).toBe('2026-09-07T13:47:00.000Z');
    expect(out.nextAt).toBe(Date.parse('2026-09-07T13:47:00.000Z'));
  });

  it('clears with rule: null and reports no next firing', async () => {
    const out = payload(
      await call('set_task_schedule', { workspaceId: WS, taskId: 't-1', rule: null }),
    );
    expect(last().body.rule).toBeNull();
    expect(out.schedule).toBeNull();
    expect(out.nextAt).toBeNull();
  });

  it('refuses an absent rule without calling the server — silence is not a clear', async () => {
    const before = schedulePosts().length;
    const reply = await call('set_task_schedule', { workspaceId: WS, taskId: 't-1' });
    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.content?.[0]?.text).toMatch(/rule required/);
    expect(schedulePosts().length).toBe(before);
  });

  it("relays the route's refusal in the route's own words", async () => {
    const reply = await call('set_task_schedule', {
      workspaceId: WS,
      taskId: 't-1',
      rule: { kind: 'fortnightly' },
    });
    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.content?.[0]?.text).toMatch(/rule\.kind must be one of/);
  });
});
