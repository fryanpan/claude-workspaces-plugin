/**
 * A board token works its own board's tasks, and no other board's.
 *
 * A. A walled lead, driven over its board's socket as the node relay drives
 *    it. Its REST calls carry the board token the server holds for the
 *    session, so they go through `board-agent-door.ts` as a lead. Every
 *    task-write verb the MCP child calls succeeds on a Harborlight task and
 *    is refused (403) on a Riverbend task.
 * B. An operator-minted token for Harborlight over loopback TCP: the same
 *    routes, both ways, plus the owner-only board verbs it must still be
 *    refused.
 *
 * All fixtures synthetic; port 0; a short socket folder.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardSocketPath } from '../src/board-sockets.ts';
import { boardTaskWriteAllows } from '../src/middleware/board-task-scope.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const AGENT = 'Harborlight Lead';
const OPERATOR = { id: 'known-operator', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const DECISION = {
  shape: 'decision',
  headline: 'Which tide table the chart reads',
  detail: 'The harbour table is hourly. The coast table is every ten minutes.',
  options: [
    { id: 'o-1', label: 'Harbour table' },
    { id: 'o-2', label: 'Coast table' },
  ],
};

let h: ServerHandle;
let dataDir: string;
let workDir: string;
let socketRoot: string;
let socketDir: string;
let base: string;

const json = { 'content-type': 'application/json' };

const tcp = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { ...json, host: `localhost:${h.port}`, ...(init.headers ?? {}) },
  });

const on = (board: string, path: string, init: RequestInit = {}) =>
  fetch(`http://board${path}`, {
    ...init,
    unix: boardSocketPath(socketDir, board),
    headers: { ...json, ...(init.headers ?? {}) },
  } as RequestInit);

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await tcp(path, { method: 'POST', body: JSON.stringify(body) });
  expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200);
  return (await res.json()) as T;
}

interface Fixture {
  board: string;
  /** A task with one done-when line, its line, and an open review item on it. */
  task: string;
  line: string;
  item: string;
  /** A second task, for the dependency and the rewrite. */
  other: string;
  /** A third task's review item, for the withdraw. */
  withdrawTask: string;
  withdrawItem: string;
  /** A goal band on the board. */
  goal: string;
}

async function fixture(name: string, onBoard?: string): Promise<Fixture> {
  const board =
    onBoard ?? (await post<{ workspace: { id: string } }>('/workspaces', { name })).workspace.id;
  const { goal } = await post<{ goal: { id: string } }>(`/workspaces/${board}/goals/add`, {
    title: '1. Charts',
    author: OPERATOR,
  });
  const make = async (title: string) => {
    const { task } = await post<{ task: { id: string } }>(`/workspaces/${board}/tasks`, {
      author: OPERATOR,
      title,
      doneWhen: [{ text: 'the chart route answers 200' }],
    });
    return task.id;
  };
  const item = async (taskId: string) =>
    (
      await post<{ item: { id: string } }>(`/workspaces/${board}/tasks/${taskId}/review-items`, {
        review: DECISION,
        author: OPERATOR,
      })
    ).item.id;
  const task = await make(`${name} reader can read the tide chart`);
  const other = await make(`${name} reader can read the wind chart`);
  const withdrawTask = await make(`${name} reader can read the swell chart`);
  const detail = await tcp(`/workspaces/${board}/tasks/${task}/detail`);
  const lines = ((await detail.json()) as { task: { doneWhen?: Array<{ id: string }> } }).task
    .doneWhen;
  return {
    board,
    task,
    line: lines?.[0]?.id ?? '',
    item: await item(task),
    other,
    withdrawTask,
    withdrawItem: await item(withdrawTask),
    goal: goal.id,
  };
}

let harbor: Fixture;
let river: Fixture;

/** An MCP session opened on `boardId`'s socket, as the node relay opens one. */
async function session(boardId: string) {
  const headers = {
    ...json,
    accept: 'application/json, text/event-stream',
    'x-cw-agent': AGENT,
    'x-cw-cwd': workDir,
  };
  const init = await on(boardId, '/mcp', {
    method: 'POST',
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
  });
  expect(init.status, await init.clone().text()).toBe(200);
  const sid = init.headers.get('mcp-session-id') ?? '';
  let id = 1;
  return async (name: string, args: Record<string, unknown>) => {
    id += 1;
    const res = await on(boardId, '/mcp', {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sid },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    const text = (body.result?.content ?? []).map((c) => c.text ?? '').join('\n');
    return { isError: body.result?.isError === true, text };
  };
}

/** Each task-write verb, as the MCP child calls it, on one board's fixture. */
const VERBS: Array<[string, (f: Fixture) => Record<string, unknown>]> = [
  ['declare_wait', (f) => ({ taskId: f.task, waitingOn: 'the harbour release', hours: 1 })],
  [
    'report_done_when',
    (f) => ({
      taskId: f.task,
      lines: [{ id: f.line, verdict: 'not-met', proof: [{ text: 'the route answered 404' }] }],
    }),
  ],
  ['task_transition', (f) => ({ taskId: f.task, to: 'in-progress' })],
  [
    'rewrite_task',
    (f) => ({
      taskId: f.other,
      title: 'Reader can read the wind chart on a phone',
      body: 'The chart page.',
      doneWhen: [{ text: 'the wind route answers 200' }],
    }),
  ],
  ['set_task_dependencies', (f) => ({ taskId: f.other, after: [f.task] })],
  ['set_task_goal', (f) => ({ taskId: f.other, goal: f.goal })],
  ['set_task_schedule', (f) => ({ taskId: f.other, rule: null })],
  ['create_tasks', () => ({ tasks: [{ title: 'Reader can read the moon chart', body: 'x' }] })],
  ['link_refs', (f) => ({ taskId: f.task, ref: { kind: 'url', url: 'https://example.com/a' } })],
  ['add_review_item', (f) => ({ taskId: f.other, review: DECISION })],
  [
    'revise_review_item',
    (f) => ({ taskId: f.task, reviewItemId: f.item, headline: 'Which tide table to read' }),
  ],
  ['withdraw_review_item', (f) => ({ taskId: f.withdrawTask, reviewItemId: f.withdrawItem })],
];

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'board-token-tasks-'));
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'board-token-tasks-work-')));
  socketRoot = mkdtempSync(
    process.platform === 'darwin' ? '/private/tmp/btt-' : join(tmpdir(), 'btt-'),
  );
  socketDir = join(socketRoot, 'boards');
  h = createServer({ port: 0, dataDir, boardSocketDir: socketDir });
  base = `http://127.0.0.1:${h.port}`;
  harbor = await fixture('Harborlight');
  river = await fixture('Riverbend');
});

afterAll(async () => {
  await h.stop();
  for (const d of [dataDir, workDir, socketRoot]) rmSync(d, { recursive: true, force: true });
});

describe('A. a walled lead works its own board’s tasks over its socket', () => {
  for (const [verb, args] of VERBS) {
    it(`${verb} succeeds on its own board’s task`, async () => {
      const call = await session(harbor.board);
      const own = await call(verb, { workspaceId: harbor.board, ...args(harbor) });
      expect(own.isError, own.text).toBe(false);
    }, 30_000);

    it(`${verb} is refused on another board’s task`, async () => {
      const call = await session(harbor.board);
      const other = await call(verb, { workspaceId: river.board, ...args(river) });
      expect(other.isError, other.text).toBe(true);
      expect(other.text).toContain('403');
    }, 30_000);
  }
});

describe('B. an operator-minted board token, not a lead', () => {
  let token: string;
  let mineHarbor: Fixture;
  let mineRiver: Fixture;
  beforeAll(async () => {
    const res = await tcp('/api/board-tokens', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'agent-harbor', boardId: harbor.board, label: 'test' }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    token = ((await res.json()) as { token: string }).token;
    // Fresh rows on the token's own board and on the other board.
    mineHarbor = await fixture('Harborlight', harbor.board);
    mineRiver = await fixture('Riverbend', river.board);
  });
  const author = { id: 'agent-harbor', name: 'Harbor agent', kind: 'agent', color: '#888888' };
  const post = (path: string, body: unknown, method = 'POST') =>
    tcp(path, {
      method,
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}` },
    });

  /** The five routes board-task-scope.ts adds, on one board's fixture. */
  const ROUTES: Array<[string, (f: Fixture) => [string, unknown]]> = [
    [
      'wait',
      (f) => [
        `/workspaces/${f.board}/tasks/${f.other}/wait`,
        { what: 'a release', hours: 1, author },
      ],
    ],
    [
      'done-when',
      (f) => [
        `/workspaces/${f.board}/tasks/${f.withdrawTask}/done-when`,
        { lines: [{ text: 'the swell route answers 200' }], author },
      ],
    ],
    [
      'done-when/report',
      (f) => [
        `/workspaces/${f.board}/tasks/${f.task}/done-when/report`,
        { lines: [{ id: f.line, verdict: 'not-met', proof: [{ text: 'still 404' }] }], author },
      ],
    ],
    [
      'schedule',
      (f) => [`/workspaces/${f.board}/tasks/${f.other}/schedule`, { rule: null, author }],
    ],
    [
      'tasks/batch',
      (f) => [
        `/workspaces/${f.board}/tasks/batch`,
        { tasks: [{ title: 'Reader can read the fog chart', body: 'x' }], author },
      ],
    ],
  ];

  for (const [name, route] of ROUTES) {
    it(`${name} answers on its own board and 403 on another`, async () => {
      const [ownPath, ownBody] = route(mineHarbor);
      const own = await post(ownPath, ownBody);
      expect(own.status, await own.clone().text()).toBe(200);
      const [otherPath, otherBody] = route(mineRiver);
      expect((await post(otherPath, otherBody)).status).toBe(403);
    });
  }

  it('is still refused every owner-only board verb', async () => {
    const b = harbor.board;
    const owner: Array<[string, string, unknown]> = [
      ['PUT', `/workspaces/${b}/goals`, { goals: [{ id: harbor.goal, title: '1. Renamed' }] }],
      ['PUT', `/workspaces/${b}/parallelism-cap`, { cap: 9 }],
      ['PUT', `/workspaces/${b}/lead`, { leadAgentId: 'agent-harbor' }],
      ['POST', `/workspaces/${b}/rename`, { name: 'Taken over' }],
      ['POST', '/api/share/enabled', { enabled: true, workspaceId: b }],
      ['POST', '/api/share/workspace', { workspaceId: b }],
    ];
    for (const [method, path, body] of owner) {
      const res = await post(path, { ...(body as object), author }, method);
      expect(res.status, `${method} ${path}: ${await res.clone().text()}`).toBe(403);
    }
  });
});

describe('C. the task-write scope rule itself', () => {
  const owners: Record<string, string[]> = {
    'task:t-harbor': ['w-harbor'],
    'task:t-river': ['w-river'],
  };
  const of = (id: string) => owners[id] ?? [];
  const allows = (path: string, method = 'POST') =>
    boardTaskWriteAllows(path, method, 'w-harbor', of);

  it('admits each verb on its own board’s task, POST only', () => {
    for (const verb of ['wait', 'done-when', 'done-when/report', 'schedule']) {
      expect(allows(`/workspaces/w-harbor/tasks/t-harbor/${verb}`), verb).toBe(true);
      expect(allows(`/workspaces/w-harbor/tasks/t-harbor/${verb}`, 'DELETE'), verb).toBe(false);
    }
    expect(allows('/workspaces/w-harbor/tasks/batch')).toBe(true);
  });

  it('refuses another board’s task, under either board’s id', () => {
    expect(allows('/workspaces/w-river/tasks/t-river/wait')).toBe(false);
    expect(allows('/workspaces/w-harbor/tasks/t-river/wait')).toBe(false);
    expect(allows('/workspaces/w-river/tasks/batch')).toBe(false);
  });

  it('refuses a verb it does not name, and the bare row', () => {
    expect(allows('/workspaces/w-harbor/tasks/t-harbor/archive-forever')).toBe(false);
    expect(allows('/workspaces/w-harbor/tasks/t-harbor')).toBe(false);
    expect(allows('/workspaces/w-harbor/goals')).toBe(false);
  });
});
