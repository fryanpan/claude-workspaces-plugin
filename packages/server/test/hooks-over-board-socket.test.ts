/**
 * Every plugin hook that calls the server, run as its real script, against a
 * real unix-socket listener with the board server's TCP port unreachable.
 *
 * `board-socket-hooks.test.ts` proves the Stop hook under the real wall, but
 * only where `sandbox-exec` exists, so a Linux runner never runs it and it
 * covers one hook of three. Here no sandbox is needed. The listener on the
 * socket records only what arrives on the socket, so a hit there is the
 * socket path taken; the port the session would otherwise dial is closed, so
 * the hook has no working TCP route to fall back on. The control is an
 * unwalled session, whose post reaches a listening port.
 *
 * The three hooks that make no server call, SessionStart and the two
 * auto-approvers, are not here: they read only local files.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOKS = resolve(import.meta.dir, '../../plugin/hooks');
const AGENT = 'Harborlight Lead';
const BOARD = 'w-harbor';
const OTHER = 'w-riverbend';
const agentPath = (board: string, verb: string) =>
  `/workspaces/${board}/agents/${encodeURIComponent(AGENT)}/${verb}`;

interface Hit {
  method: string;
  path: string;
}

/** A listener that records each request's path and answers as the server would. */
function recorder(opts: { unix: string } | { port: 0 }): {
  hits: Hit[];
  stop: () => void;
  port?: number;
} {
  const hits: Hit[] = [];
  const server = Bun.serve({
    ...opts,
    fetch(req) {
      hits.push({ method: req.method, path: new URL(req.url).pathname });
      return Response.json({ ok: true }, { status: 202 });
    },
  });
  return { hits, stop: () => server.stop(true), ...('port' in opts ? { port: server.port } : {}) };
}

/** A port nothing listens on: bind one, read it, close it. */
function closedPort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port;
  s.stop(true);
  if (port === undefined) throw new Error('no port');
  return port;
}

const CASES = [
  {
    hook: 'stop-note.ts',
    stdin: { session_id: 's-1', last_assistant_message: 'Charted the Harborlight berths.' },
    path: (board: string) => agentPath(board, 'notes'),
  },
  {
    hook: 'permission-denied-note.ts',
    stdin: { session_id: 's-1', tool_name: 'WebFetch' },
    path: (board: string) => agentPath(board, 'notes'),
  },
  {
    hook: 'prompt-mark.ts',
    stdin: { session_id: 's-1', prompt: 'chart the Riverbend berths' },
    path: (board: string) => agentPath(board, 'prompts'),
  },
] as const;

/** Run a hook script as Claude Code does, and wait for it to exit. Its exit
 *  code says nothing: `hookMain` exits 0 on every path. */
async function runHook(hook: string, stdin: unknown, env: Record<string, string>): Promise<void> {
  const proc = Bun.spawn([process.execPath, join(HOOKS, hook)], {
    stdin: new Blob([JSON.stringify(stdin)]),
    stdout: 'ignore',
    stderr: 'ignore',
    // HOME is a throwaway, so no discovery file names a port.
    env: { PATH: '/usr/bin:/bin', HOME: homeDir, CW_AGENT_NAME: AGENT, ...env },
  });
  await proc.exited;
}

let homeDir: string;
let socketDir: string;

beforeAll(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'hooks-sock-home-'));
  // Short, so the socket path fits sun_path on macOS.
  socketDir = mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : '/tmp', 'hs-'));
});

afterAll(() => {
  for (const d of [homeDir, socketDir]) rmSync(d, { recursive: true, force: true });
});

describe('a walled session’s hooks, with the board server’s port closed', () => {
  for (const c of CASES) {
    it(`${c.hook} posts to the socket’s board over the socket`, async () => {
      const socket = join(socketDir, `${BOARD}.sock`);
      const listener = recorder({ unix: socket });
      try {
        const env = { CW_BOARD_SOCKET: socket, CW_BASE_URL: `http://127.0.0.1:${closedPort()}` };
        await runHook(c.hook, c.stdin, env);
        expect(listener.hits).toEqual([{ method: 'POST', path: c.path(BOARD) }]);
      } finally {
        listener.stop();
      }
    }, 20_000);
  }

  // The launch's board wins over the socket's name (`boardOf`); the server,
  // not the hook, holds the request to the socket's board, which
  // `board-socket-hooks.test.ts` proves under the wall.
  it('names the launch’s board over the socket’s, and still sends it on the socket', async () => {
    const socket = join(socketDir, `${BOARD}.sock`);
    const listener = recorder({ unix: socket });
    try {
      const env = {
        CW_BOARD_SOCKET: socket,
        CW_WORKSPACE_ID: OTHER,
        CW_BASE_URL: `http://127.0.0.1:${closedPort()}`,
      };
      for (const c of CASES) await runHook(c.hook, c.stdin, env);
      expect(listener.hits).toEqual(CASES.map((c) => ({ method: 'POST', path: c.path(OTHER) })));
    } finally {
      listener.stop();
    }
  }, 30_000);
});

describe('control: an unwalled session’s hooks', () => {
  for (const c of CASES) {
    it(`${c.hook} posts over the port`, async () => {
      const onPort = recorder({ port: 0 });
      try {
        const env = { CW_BASE_URL: `http://127.0.0.1:${onPort.port}`, CW_WORKSPACE_ID: BOARD };
        await runHook(c.hook, c.stdin, env);
        expect(onPort.hits).toEqual([{ method: 'POST', path: c.path(BOARD) }]);
      } finally {
        onPort.stop();
      }
    }, 20_000);
  }
});
