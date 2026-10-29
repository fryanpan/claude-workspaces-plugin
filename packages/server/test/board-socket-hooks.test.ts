/**
 * The plugin's Stop hook, run as a walled lead runs it: the real script,
 * under the real `sandbox-exec`, with a profile that refuses this server's
 * port and every board socket but the lead's own (`boardWallRules`).
 *
 * With `CW_BOARD_SOCKET` set the note lands on the lead's board. The
 * control is the same hook under the same profile dialling TCP, which posts
 * nothing: without it, a note that arrived could have come over the port.
 * The hook's transport on its own is `packages/plugin/test/agent-notes.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { boardWallRules } from '../../../scripts/lead-sandbox-wall.ts';
import { boardSocketPath } from '../src/board-sockets.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const STOP_HOOK = resolve(import.meta.dir, '../../plugin/hooks/stop-note.ts');
const AGENT = 'Harborlight Lead';
const CAN_SANDBOX = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
if (!CAN_SANDBOX) console.warn(`[board-socket-hooks] skipped: no ${SANDBOX_EXEC} here`);

let h: ServerHandle;
let dataDir: string;
let homeDir: string;
let socketRoot: string;
let socketDir: string;
let base: string;
let harborlight: string;
let riverbend: string;
let profile: string;

async function board(name: string): Promise<string> {
  const res = await fetch(`${base}/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

/** The turn notes the board holds for the lead, read over TCP from outside. */
async function notesOn(ws: string): Promise<string[]> {
  const res = await fetch(`${base}/workspaces/${ws}/agents/${encodeURIComponent(AGENT)}/notes`);
  const body = (await res.json()) as { notes?: Array<{ text: string }> };
  return (body.notes ?? []).map((n) => n.text);
}

/** Run the Stop hook inside the wall with `env`, a closing message on stdin. */
function stopHook(env: Record<string, string>, message: string): number | null {
  const r = spawnSync(SANDBOX_EXEC, ['-f', profile, process.execPath, STOP_HOOK], {
    input: JSON.stringify({ session_id: 's-1', last_assistant_message: message }),
    // HOME is a throwaway, so the hook finds no discovery file and writes its
    // one-time marker there.
    env: { PATH: '/usr/bin:/bin', HOME: homeDir, CW_AGENT_NAME: AGENT, ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return r.status;
}

beforeAll(async () => {
  if (!CAN_SANDBOX) return;
  dataDir = mkdtempSync(join(tmpdir(), 'board-sock-hooks-'));
  homeDir = mkdtempSync(join(tmpdir(), 'board-sock-hooks-home-'));
  socketRoot = mkdtempSync('/private/tmp/bsh-');
  socketDir = join(socketRoot, 'boards');
  h = createServer({ port: 0, dataDir, boardSocketDir: socketDir });
  base = `http://127.0.0.1:${h.port}`;
  harborlight = await board('Harborlight');
  riverbend = await board('Riverbend');
  // The wall's port list names 8787 to 8790; this server is on a spare one.
  const rules = [
    '(version 1)',
    '(allow default)',
    `(deny network-outbound (remote ip "*:${h.port}"))`,
    ...boardWallRules({ boardWall: true, boardId: harborlight }, socketDir, realpathSync),
  ];
  profile = join(socketRoot, 'harborlight.sb');
  writeFileSync(profile, `${rules.join('\n')}\n`);
});

afterAll(async () => {
  if (!CAN_SANDBOX) return;
  await h.stop();
  for (const d of [dataDir, homeDir, socketRoot]) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!CAN_SANDBOX)('the Stop hook behind the board wall', () => {
  it('posts its turn note over the lead’s board socket', async () => {
    const own = boardSocketPath(socketDir, harborlight);
    expect(stopHook({ CW_BOARD_SOCKET: own }, 'Walled turn ended.')).toBe(0);
    await waitFor(async () => (await notesOn(harborlight)).includes('Walled turn ended.'), {
      timeout: 10_000,
      describe: 'the walled note on Harborlight',
    });
  }, 30_000);

  it('control: the same hook dialling TCP inside the wall posts nothing', async () => {
    expect(stopHook({ CW_BASE_URL: base, CW_WORKSPACE_ID: harborlight }, 'Dialled TCP.')).toBe(0);
    // A note sent after it on the socket arrives; the TCP one, sent first,
    // would be in the ring by then had it been delivered.
    const own = boardSocketPath(socketDir, harborlight);
    expect(stopHook({ CW_BOARD_SOCKET: own }, 'Sent after.')).toBe(0);
    await waitFor(async () => (await notesOn(harborlight)).includes('Sent after.'), {
      timeout: 10_000,
      describe: 'the second socket note',
    });
    expect(await notesOn(harborlight)).not.toContain('Dialled TCP.');
  }, 30_000);

  it('cannot post to another board, by its id or by its socket', async () => {
    const own = boardSocketPath(socketDir, harborlight);
    const other = boardSocketPath(socketDir, riverbend);
    expect(stopHook({ CW_BOARD_SOCKET: own, CW_WORKSPACE_ID: riverbend }, 'By id.')).toBe(0);
    expect(stopHook({ CW_BOARD_SOCKET: other }, 'By socket.')).toBe(0);
    expect(stopHook({ CW_BOARD_SOCKET: own }, 'Then own.')).toBe(0);
    await waitFor(async () => (await notesOn(harborlight)).includes('Then own.'), {
      timeout: 10_000,
      describe: 'the closing own-board note',
    });
    const onRiverbend = await notesOn(riverbend);
    expect(onRiverbend).not.toContain('By id.');
    expect(onRiverbend).not.toContain('By socket.');
  }, 30_000);
});
