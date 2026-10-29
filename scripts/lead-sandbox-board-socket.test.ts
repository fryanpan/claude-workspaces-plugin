/**
 * A walled lead's launch: its MCP relay is pointed at its own board's
 * socket, and its environment carries no board server token. Driven through
 * `main` with a fake keychain reader and a fake spawn: nothing here reads the
 * real keychain or starts a sandboxed `claude`. That the relay then reaches
 * its board over the socket, under the real sandbox-exec, is
 * packages/server/test/board-socket-relay.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_ENV, TOKEN_SERVICE } from './lead-sandbox-token.ts';
import { type LaunchDeps, main, withoutBoardBearers } from './lead-sandbox.ts';

const root = mkdtempSync(join(tmpdir(), 'lead-sandbox-sock-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const SOCKETS = '/private/tmp/cw-test-boards';
const STORED = `${Buffer.from('sk-ant-oat01-test-harborlight-0000').toString('base64')}\n`;

function configFile(boardWall: boolean): string {
  const project = join(root, 'dev', 'harborlight');
  mkdirSync(project, { recursive: true });
  const file = join(root, `config-${boardWall}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      boardSocketDir: SOCKETS,
      leads: [{ name: 'harborlight-lead', projects: [project], boardWall, boardId: 'w-harbor' }],
    }),
  );
  return file;
}

function launch(boardWall: boolean) {
  const spawned: { env: NodeJS.ProcessEnv }[] = [];
  const lines: string[] = [];
  const deps: LaunchDeps = {
    platform: 'darwin',
    say: (line) => lines.push(line),
    readToken: (service) => (service === TOKEN_SERVICE ? STORED : null),
    spawn: (_file, _args, opts) => {
      spawned.push({ env: opts.env });
      return 0;
    },
  };
  const argv = ['--config', configFile(boardWall), '--profiles', join(root, 'profiles')];
  const code = main([...argv, '--lead', 'harborlight-lead', '--', 'claude'], deps);
  return { code, env: spawned[0]?.env ?? {}, said: lines.join('\n') };
}

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  // A board bearer in the launcher's own shell, which the lead must not inherit.
  vi.stubEnv('CW_TEST_STRAY_BEARER', 'at1.agent-harborlight.c2lnbmF0dXJl');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('launching a walled lead', () => {
  it('points its relay at its own board’s socket, with that board as its default', () => {
    const r = launch(true);
    expect(r.code).toBe(0);
    expect(r.env.CW_BOARD_SOCKET).toBe(`${SOCKETS}/w-harbor.sock`);
    expect(r.env.CW_WORKSPACE_ID).toBe('w-harbor');
    expect(r.said).toContain('hooks');
  });

  it('hands it no board server token', () => {
    const r = launch(true);
    // The control: this is the lead's environment, and it does carry the
    // Claude sign-in the launcher is meant to hand over.
    expect(r.env[TOKEN_ENV]).toBe('sk-ant-oat01-test-harborlight-0000');
    const values = Object.values(r.env).join('\n');
    expect(values).not.toMatch(/\bat[12]\./);
    expect(r.env.CW_TEST_STRAY_BEARER).toBeUndefined();
  });

  it('leaves an unwalled lead without a socket', () => {
    const r = launch(false);
    expect(r.code).toBe(0);
    expect(r.env.CW_BOARD_SOCKET).toBeUndefined();
  });
});

describe('withoutBoardBearers', () => {
  it('drops a value that is a board bearer and keeps everything else', () => {
    const env = { A: 'at2.abc.def', B: 'Bearer at1.x.y', C: 'that2.0', D: '/usr/bin' };
    expect(withoutBoardBearers(env)).toEqual({ C: 'that2.0', D: '/usr/bin' });
  });
});
