/**
 * The server flag for board sockets (`resolveBoardSocketDir` in
 * server-config.ts, passed by bin.ts): off unless asked, and on it opens one
 * socket per board.
 *
 * Driven through `resolveServerConfig` and `createServer` with the config
 * handed over the way bin.ts hands it, rather than by booting bin.ts, which
 * writes this machine's discovery file. The default folder is asked for with
 * an invented uid and never opened, so no test touches a folder a real
 * server could be using.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ArgReader,
  resolveBoardSocketDir,
  resolveServerConfig,
} from '../src/server-config.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const noArgs: ArgReader = (_name, fallback) => fallback;
const argsFrom =
  (pairs: Record<string, string>): ArgReader =>
  (name, fallback) =>
    pairs[name] ?? fallback;
const FAKE_UID = 4_242_424;

const cleanup: string[] = [];
let handle: ServerHandle | null = null;

afterEach(async () => {
  await handle?.stop();
  handle = null;
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Boot from the config, passing the folder exactly as bin.ts does. */
async function boot(env: NodeJS.ProcessEnv, arg: ArgReader = noArgs) {
  const root = mkdtempSync(join(tmpdir(), 'bsf-'));
  cleanup.push(root);
  const dataDir = join(root, 'data');
  const cfg = resolveServerConfig({ env: { CW_DATA_DIR: dataDir, ...env }, repoRoot: root, arg });
  const { boardSocketDir } = cfg;
  handle = createServer({ port: 0, dataDir, ...(boardSocketDir ? { boardSocketDir } : {}) });
  const base = `http://127.0.0.1:${handle.port}`;
  for (const name of ['Harborlight', 'Riverbend']) {
    const res = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(200);
  }
  return { cfg, root };
}

describe('the board socket flag', () => {
  it('is off by default: no folder named, none made', async () => {
    expect(resolveBoardSocketDir({}, noArgs, FAKE_UID)).toBeUndefined();
    expect(resolveBoardSocketDir({ CW_BOARD_SOCKETS: '0' }, noArgs, FAKE_UID)).toBeUndefined();
    const { cfg, root } = await boot({});
    expect(cfg.boardSocketDir).toBeUndefined();
    // Nothing under the boot's own folder but the data it wrote.
    expect(readdirSync(root)).toEqual(['data']);
    expect(existsSync(`/private/tmp/cw-${FAKE_UID}-boards`)).toBe(false);
  }, 30_000);

  it('on, opens one socket per board in the folder named', async () => {
    // A short folder: macOS's tmpdir() is too long for a 104-byte socket path.
    const short = process.platform === 'darwin' ? '/private/tmp' : tmpdir();
    const dir = join(mkdtempSync(join(short, 'bsf-')), 'boards');
    cleanup.push(join(dir, '..'));
    const { cfg } = await boot({ CW_BOARD_SOCKET_DIR: dir });
    expect(cfg.boardSocketDir).toBe(dir);
    const sockets = readdirSync(dir).filter((n) => n.endsWith('.sock'));
    expect(sockets.length).toBe(2);
  }, 30_000);

  it('takes the folder from --board-socket-dir, and CW_BOARD_SOCKETS=1 takes the default', () => {
    expect(resolveBoardSocketDir({}, argsFrom({ 'board-socket-dir': '/private/tmp/cw-b' }))).toBe(
      '/private/tmp/cw-b',
    );
    expect(resolveBoardSocketDir({ CW_BOARD_SOCKETS: '1' }, noArgs, FAKE_UID)).toBe(
      `/private/tmp/cw-${FAKE_UID}-boards`,
    );
  });

  it('leaves the sockets off for a folder too long to hold them', () => {
    const long = `/private/tmp/${'x'.repeat(90)}`;
    expect(resolveBoardSocketDir({ CW_BOARD_SOCKET_DIR: long }, noArgs)).toBeUndefined();
    expect(
      resolveBoardSocketDir({ CW_BOARD_SOCKET_DIR: 'relative/boards' }, noArgs),
    ).toBeUndefined();
  });
});
