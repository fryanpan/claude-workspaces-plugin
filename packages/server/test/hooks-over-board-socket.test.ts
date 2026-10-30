/**
 * Every plugin hook that calls the server, run as its real script, against a
 * real unix-socket listener with the board server's TCP port unreachable.
 *
 * `board-socket-hooks.test.ts` proves the Stop hook under the real wall, but
 * only where `sandbox-exec` exists, so a Linux runner never runs it and it
 * covers one hook of three. Here no sandbox is needed: the port the session
 * would otherwise dial is closed, so a request that arrives on the socket
 * could not have taken the TCP path. The control is an unwalled session with
 * no socket, whose requests reach a listening port and never the socket.
 *
 * The two hooks that make no server call, SessionStart and the two
 * auto-approvers, are not here: they read only local files.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOKS = resolve(import.meta.dir, '../../plugin/hooks');
const AGENT = 'Harborlight Lead';
const BOARD = 'w-harbor';

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
    path: `/workspaces/${BOARD}/agents/${encodeURIComponent(AGENT)}/notes`,
  },
  {
    hook: 'permission-denied-note.ts',
    stdin: { session_id: 's-1', tool_name: 'WebFetch' },
    path: `/workspaces/${BOARD}/agents/${encodeURIComponent(AGENT)}/notes`,
  },
  {
    hook: 'prompt-mark.ts',
    stdin: { session_id: 's-1', prompt: 'chart the Riverbend berths' },
    path: `/workspaces/${BOARD}/agents/${encodeURIComponent(AGENT)}/prompts`,
  },
] as const;

/** Run a hook script as Claude Code does, and wait for it to exit. */
async function runHook(hook: string, stdin: unknown, env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn([process.execPath, join(HOOKS, hook)], {
    stdin: new Blob([JSON.stringify(stdin)]),
    stdout: 'ignore',
    stderr: 'ignore',
    // HOME is a throwaway, so no discovery file names a port.
    env: { PATH: '/usr/bin:/bin', HOME: homeDir, CW_AGENT_NAME: AGENT, ...env },
  });
  return proc.exited;
}

let homeDir: string;
let socketDir: string;

beforeAll(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'hooks-sock-home-'));
  // Short, so the socket path fits sun_path on macOS.
  socketDir = mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'hs-'));
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
        expect(await runHook(c.hook, c.stdin, env)).toBe(0);
        expect(listener.hits).toEqual([{ method: 'POST', path: c.path }]);
      } finally {
        listener.stop();
      }
    }, 20_000);
  }
});

describe('control: an unwalled session’s hooks', () => {
  for (const c of CASES) {
    it(`${c.hook} dials the port and never the socket`, async () => {
      const socket = join(socketDir, `${BOARD}.sock`);
      const onSocket = recorder({ unix: socket });
      const onPort = recorder({ port: 0 });
      try {
        const env = { CW_BASE_URL: `http://127.0.0.1:${onPort.port}`, CW_WORKSPACE_ID: BOARD };
        expect(await runHook(c.hook, c.stdin, env)).toBe(0);
        expect(onPort.hits).toEqual([{ method: 'POST', path: c.path }]);
        expect(onSocket.hits).toEqual([]);
      } finally {
        onSocket.stop();
        onPort.stop();
      }
    }, 20_000);
  }
});
