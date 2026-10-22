/**
 * Each server signs with a key of its own, and refuses every token another
 * server signed.
 *
 * Two real servers, Harborlight and Riverbend, each booted on a fresh data
 * dir, so each makes its own `share-cookie.key` on first start. For every
 * token type a server mints, the token is minted on Harborlight and
 * presented to both: Harborlight accepts it (the positive control, without
 * which a refusal proves nothing) and Riverbend refuses it. Where a token
 * also needs state beyond its signature — a roster row, a record file — that
 * state is put on Riverbend as well, so the key is the only thing that
 * differs.
 *
 * Over HTTP for everything a request presents. The app-voice token rides a
 * websocket and the share cookie's surface is retired, so those two are
 * verified against each server's own key file directly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emailIdentityId } from '@claude-workspaces/core';
import { appVoiceTokenKey, checkAppVoiceToken, mintAppVoiceToken } from '../src/app-voice/token.ts';
import { agentTokenKey, mintAgentToken } from '../src/auth/agent-token.ts';
import { boardTokensPath } from '../src/auth/board-agent-token.ts';
import { SESSION_COOKIE } from '../src/auth/session.ts';
import { mintBoardWidgetToken, widgetTokenKey } from '../src/auth/widget-token.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { loadCookieKey, signSession, verifySession } from '../src/share/link-session.ts';

// The log sender masks the code unless this is set (`auth/code-sender.ts`).
process.env.CW_LOG_LOGIN_CODES = '1';

const EMAIL = 'alice@example.com';
const DEV_ORIGIN = 'http://127.0.0.1:5173';
const AGENT = 'agent-saltmarsh';

const codes: string[] = [];
const originalLog = console.log;

interface Server {
  name: string;
  handle: ServerHandle;
  dataDir: string;
  base: string;
  board: string;
  cookie: string;
}

let harborlight: Server;
let riverbend: Server;

async function post(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function boot(name: string, beforeStart?: (dataDir: string) => void): Promise<Server> {
  const dataDir = mkdtempSync(join(tmpdir(), `key-${name.toLowerCase()}-`));
  beforeStart?.(dataDir);
  const handle = createServer({
    port: 0,
    dataDir,
    emailCodeSignIn: true,
    // So a token Access minted is accepted on either server for the same
    // person: the board membership half of its check is the same on both.
    proxiedTrustedEmails: [EMAIL],
  });
  const base = `http://127.0.0.1:${handle.port}`;
  const board = handle.tasks.createWorkspace(name).id;
  const before = codes.length;
  expect((await post(base, '/api/auth/start', { email: EMAIL })).status).toBe(200);
  expect(codes.length).toBe(before + 1);
  const verified = await post(base, '/api/auth/verify', { email: EMAIL, code: codes.at(-1) });
  expect(verified.status).toBe(200);
  const cookie = (verified.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  return { name, handle, dataDir, base, board, cookie };
}

beforeAll(async () => {
  console.log = (...args: unknown[]) => {
    const m = args
      .map(String)
      .join(' ')
      .match(/login code for \S+: (\d{6})/);
    if (m?.[1]) codes.push(m[1]);
    originalLog(...(args as []));
  };
  harborlight = await boot('Harborlight');
  riverbend = await boot('Riverbend');
});

afterAll(async () => {
  console.log = originalLog;
  for (const s of [harborlight, riverbend]) {
    await s.handle.stop();
    rmSync(s.dataDir, { recursive: true, force: true });
  }
});

describe('each server makes its own key', () => {
  it('on first start, mode 600, and different from the other server’s', () => {
    const keys = [harborlight, riverbend].map((s) => {
      expect(statSync(join(s.dataDir, 'share-cookie.key')).mode & 0o777).toBe(0o600);
      return loadCookieKey(s.dataDir);
    });
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe('a token signed by another server is refused, every type', () => {
  it('the session cookie', async () => {
    const asked = async (s: Server) => {
      const res = await fetch(`${s.base}/api/auth/session`, {
        headers: { cookie: harborlight.cookie },
      });
      return ((await res.json()) as { authenticated: boolean }).authenticated;
    };
    expect(await asked(harborlight)).toBe(true);
    expect(await asked(riverbend)).toBe(false);
  });

  it('the widget board token a session minted', async () => {
    const minted = await post(
      harborlight.base,
      '/api/auth/widget-token',
      { origin: DEV_ORIGIN, workspaceId: harborlight.board },
      { cookie: harborlight.cookie },
    );
    expect(minted.status, await minted.clone().text()).toBe(200);
    const { token } = (await minted.json()) as { token: string };
    const probe = (s: Server) =>
      fetch(`${s.base}/api/auth/widget-session`, {
        headers: { authorization: `Bearer ${token}`, origin: DEV_ORIGIN },
      });
    expect((await probe(harborlight)).status).toBe(200);
    expect((await probe(riverbend)).status).toBe(401);
  });

  it('the widget board token Access minted', async () => {
    // Minted with Harborlight's key exactly as its Access branch mints, for
    // the same person and board id on both servers.
    const token = mintBoardWidgetToken(
      { identityId: emailIdentityId(EMAIL), workspaceId: harborlight.board, origin: DEV_ORIGIN },
      widgetTokenKey(loadCookieKey(harborlight.dataDir)),
    );
    const probe = (s: Server) =>
      fetch(`${s.base}/api/auth/widget-session`, {
        headers: { authorization: `Bearer ${token}`, origin: DEV_ORIGIN },
      });
    expect((await probe(harborlight)).status).toBe(200);
    expect((await probe(riverbend)).status).toBe(401);
  });

  it('the agent token (at1)', async () => {
    const token = mintAgentToken(AGENT, agentTokenKey(loadCookieKey(harborlight.dataDir)));
    const watches = (s: Server) =>
      fetch(`${s.base}/api/agents/${AGENT}/watches`, {
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await watches(harborlight)).status).toBe(200);
    expect((await watches(riverbend)).status).toBe(403);
  });

  it('the board agent token (at2), with the same record on both servers', async () => {
    const minted = await post(harborlight.base, '/api/board-tokens', {
      agentId: AGENT,
      boardId: harborlight.board,
    });
    expect(minted.status, await minted.clone().text()).toBe(201);
    const { token } = (await minted.json()) as { token: string };
    // A third server holding Harborlight's record, but its own key — what a
    // copied data dir that left the key behind looks like.
    const copy = await boot('Saltmarsh', (dir) =>
      copyFileSync(boardTokensPath(harborlight.dataDir), boardTokensPath(dir)),
    );
    try {
      const refresh = (s: Server) =>
        fetch(`${s.base}/api/board-tokens/refresh`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        });
      expect((await refresh(harborlight)).status).toBe(200);
      expect((await refresh(copy)).status).toBe(401);
      expect((await refresh(riverbend)).status).toBe(401);
    } finally {
      await copy.handle.stop();
      rmSync(copy.dataDir, { recursive: true, force: true });
    }
  });

  it('the voice API token', async () => {
    const minted = await post(harborlight.base, '/api/voice/tokens', { label: 'phone' });
    expect(minted.status, await minted.clone().text()).toBe(201);
    const { token } = (await minted.json()) as { token: string };
    const models = (s: Server) =>
      fetch(`${s.base}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
    expect((await models(harborlight)).status).toBe(200);
    expect((await models(riverbend)).status).toBe(401);
  });

  it('the app-voice token, against each server’s own key file', () => {
    const { token } = mintAppVoiceToken(
      appVoiceTokenKey(loadCookieKey(harborlight.dataDir)),
      harborlight.board,
      'd-harbor',
    );
    const check = (s: Server) =>
      checkAppVoiceToken(
        appVoiceTokenKey(loadCookieKey(s.dataDir)),
        token,
        harborlight.board,
        'd-harbor',
      ).ok;
    expect(check(harborlight)).toBe(true);
    expect(check(riverbend)).toBe(false);
  });

  it('the share cookie (retired surface), against each server’s own key file', () => {
    const cookie = signSession('sh-harborlight', loadCookieKey(harborlight.dataDir));
    expect(verifySession(cookie, loadCookieKey(harborlight.dataDir))).toBe('sh-harborlight');
    expect(verifySession(cookie, loadCookieKey(riverbend.dataDir))).toBeNull();
  });
});
