/**
 * How `relay:install` talks to each board server: the Mac's at its loopback,
 * a project machine's at ITS loopback through `fly ssh console`, run as `cw`
 * (the uid the server's loopback door admits), the same way the
 * github-push-keys step in `docs/process/project-machine.md` does.
 *
 * Every call here is one a loopback caller makes: listing boards and tasks,
 * filing a task, and minting, listing or revoking a board token
 * (`routes/board-tokens.ts`, which refuses anything not on loopback). A
 * request body goes to the machine base64-encoded on the command line; it
 * never carries a secret, and the minted token comes back on stdout.
 */
import { asCw, machineShell } from '../../packages/server/src/provisioning/move-steps.ts';
import { MAC_BASE_URL, type ServerPlan } from './install-plan.ts';

export interface Answer {
  status: number;
  body: unknown;
}

export type BoardCall = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<Answer>;

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface ApiIo {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** `fly <args>`, its output returned and never shown. */
  fly: (args: string[], input?: string) => RunResult | Promise<RunResult>;
}

const SAFE_PATH = /^\/[A-Za-z0-9_:./?=&-]*$/;

/** The `curl` a machine runs for one call; the status is curl's last line. */
export function machineCurl(method: 'GET' | 'POST', path: string, body?: unknown): string {
  if (!SAFE_PATH.test(path)) throw new Error(`refusing to send the path ${path}`);
  const data =
    body === undefined
      ? ''
      : `printf %s ${Buffer.from(JSON.stringify(body)).toString('base64')} | base64 -d | `;
  return [
    `${data}curl -s -w '\\n%{http_code}' -X ${method}`,
    `-H 'host: localhost:8787' -H 'content-type: application/json'`,
    ...(body === undefined ? [] : ['--data-binary @-']),
    `'http://127.0.0.1:8787${path}'`,
  ].join(' ');
}

/** curl's output: the answer's last line, then the status on its own line. */
export function parseCurlOutput(stdout: string): Answer {
  const lines = stdout.trimEnd().split('\n');
  const status = Number(lines.pop());
  const text = lines.pop() ?? '';
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: Number.isInteger(status) ? status : 0, body };
}

/** The calls for one server. */
export function boardCall(server: ServerPlan, io: ApiIo): BoardCall {
  if (!server.app) {
    return async (method, path, body) => {
      const res = await io.fetch(`${MAC_BASE_URL}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed };
    };
  }
  const app = server.app;
  return async (method, path, body) => {
    const r = await io.fly([
      'ssh',
      'console',
      '--app',
      app,
      '--command',
      machineShell(asCw(machineCurl(method, path, body))),
    ]);
    if (r.status !== 0) {
      throw new Error(`fly ssh console --app ${app} failed: ${r.stderr.trim().split('\n').pop()}`);
    }
    return parseCurlOutput(r.stdout);
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The one live board on a server whose lead is `agentId`, or why not. */
export async function leadBoard(
  call: BoardCall,
  agentId: string,
): Promise<{ board: string } | { error: string }> {
  const list = await call('GET', '/workspaces');
  const boards =
    isObject(list.body) && Array.isArray(list.body.boardWorkspaces)
      ? list.body.boardWorkspaces
      : [];
  if (list.status !== 200) return { error: `GET /workspaces answered ${list.status}` };
  const found: string[] = [];
  for (const b of boards) {
    if (!isObject(b) || typeof b.id !== 'string' || b.retired === true) continue;
    const read = await call('GET', `/workspaces/${encodeURIComponent(b.id)}?format=json`);
    const ws = isObject(read.body) && isObject(read.body.workspace) ? read.body.workspace : null;
    if (ws?.leadAgentId === agentId) found.push(b.id);
  }
  if (found.length === 1) return { board: found[0] as string };
  return {
    error:
      found.length === 0
        ? `no board there is led by ${agentId}`
        : `${found.length} boards there are led by ${agentId} (${found.join(', ')})`,
  };
}

/** The id of the open task titled `title`, or null. */
export async function taskTitled(
  call: BoardCall,
  board: string,
  title: string,
): Promise<string | null> {
  const res = await call('GET', `/workspaces/${encodeURIComponent(board)}/tasks?format=json`);
  if (res.status !== 200) throw new Error(`listing tasks on ${board} answered ${res.status}`);
  const tasks = isObject(res.body) && Array.isArray(res.body.tasks) ? res.body.tasks : [];
  for (const t of tasks) {
    if (isObject(t) && t.title === title && typeof t.id === 'string') return t.id;
  }
  return null;
}

/** File the task and answer its id. */
export async function fileTask(
  call: BoardCall,
  board: string,
  task: { title: string; body: string; assignee: string; author: string },
): Promise<string> {
  const res = await call('POST', `/workspaces/${encodeURIComponent(board)}/tasks`, {
    title: task.title,
    body: task.body,
    assignee: task.assignee,
    assigneeKind: 'agent',
    author: { id: task.author, name: 'Relay', kind: 'agent' },
  });
  const id = isObject(res.body) && isObject(res.body.task) ? res.body.task.id : undefined;
  if (res.status !== 200 || typeof id !== 'string') {
    throw new Error(`filing "${task.title}" on ${board} answered ${res.status}`);
  }
  return id;
}

export interface TokenRecord {
  id: string;
  agentId: string;
  boardId: string;
  revokedAt?: number;
}

export async function tokenRecords(call: BoardCall): Promise<TokenRecord[]> {
  const res = await call('GET', '/api/board-tokens');
  if (res.status !== 200) throw new Error(`GET /api/board-tokens answered ${res.status}`);
  const rows = isObject(res.body) && Array.isArray(res.body.tokens) ? res.body.tokens : [];
  return rows.filter(
    (r): r is TokenRecord =>
      isObject(r) &&
      typeof r.id === 'string' &&
      typeof r.agentId === 'string' &&
      typeof r.boardId === 'string',
  );
}

/** A new `at2` for the relay on one board. The value is in the answer only. */
export async function mintToken(
  call: BoardCall,
  agentId: string,
  boardId: string,
): Promise<string> {
  const res = await call('POST', '/api/board-tokens', { agentId, boardId, label: 'org relay' });
  const token = isObject(res.body) ? res.body.token : undefined;
  if (res.status !== 201 || typeof token !== 'string') {
    throw new Error(`minting the relay's token on ${boardId} answered ${res.status}`);
  }
  return token;
}

export async function revokeToken(call: BoardCall, id: string): Promise<void> {
  const res = await call('POST', `/api/board-tokens/${encodeURIComponent(id)}/revoke`);
  if (res.status !== 200) throw new Error(`revoking token record ${id} answered ${res.status}`);
}
