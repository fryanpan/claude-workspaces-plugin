/**
 * Home's feed and the relay on the board's agent token (plan step 7): the
 * `access-per-project` feed and relay cases, with Cloudflare Access taken
 * away. Riverbend runs `CW_SIGNIN=better-auth` with its guard open, so no
 * Access stamp reaches it; the Mac pulls Riverbend's feed and the relay
 * reads Riverbend's board with an `at2` minted for that one board, through
 * the board router Worker at Riverbend's own address.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleBoardRequest } from '../../../infra/board-router-worker/worker.js';
import { OWNER_SIGNIN_FILE } from '../src/auth/owner-signin-record.ts';
import { type FetchLike, createHomeRemotes, parseHomeRemotesConfig } from '../src/home-remotes.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

const ONE_HOST = 'workspaces.harborlight.test';
const CLOUD_HOST = 'riverbend-workspaces.harborlight.test';
const MAC_ORIGIN = 'mac-origin.harborlight.test';
const CLOUD_ORIGIN = 'riverbend-origin.harborlight.test';
const OWNER = 'owner@harborlight.test';

describe('the feed and the relay on the board agent token, with no Access', () => {
  const dataDirs: string[] = [];
  let cloud: ServerHandle;
  let cloudBoard: string;
  let otherBoard: string;
  let env: Record<string, string>;

  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'signin-feed-relay-'));
    dataDirs.push(d);
    return d;
  };
  const local = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${cloud.port}${path}`, {
      ...init,
      headers: {
        host: `localhost:${cloud.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const makeBoard = async (name: string) => {
    const res = await local('/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
    expect(res.status).toBe(200);
    return ((await res.json()) as { workspace: { id: string } }).workspace.id;
  };
  const mint = async (boardId: string, agentId: string) => {
    const res = await local('/api/board-tokens', {
      method: 'POST',
      body: JSON.stringify({ agentId, boardId, label: agentId }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { token: string }).token;
  };

  /** The tunnel: origin hostname to Riverbend's port, Host kept, `cf-ray` added. */
  const tunnel = async (
    request: Request,
    init: { redirect?: 'manual'; cf: { resolveOverride: string } },
  ) => {
    if (init.cf.resolveOverride !== CLOUD_ORIGIN) throw new Error('no tunnel');
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set('host', url.host);
    headers.set('cf-ray', '8a1b2c3d4e5f-SJC');
    headers.set('x-forwarded-proto', 'https');
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    return fetch(`http://127.0.0.1:${cloud.port}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      redirect: 'manual',
      ...(hasBody ? { body: await request.arrayBuffer() } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  };
  /** The internet, as the Mac's outbound fetch sees it: the Worker, no Access. */
  const internet: FetchLike = (input, init = {}) =>
    handleBoardRequest(new Request(input, init), env, tunnel);
  const at = (path: string, headers: Record<string, string> = {}) =>
    internet(`https://${CLOUD_HOST}${path}`, { headers });

  beforeAll(async () => {
    const dataDir = tmp();
    // The owner signed in here once already: the lock-out guard is open, so
    // `better-auth` is in force and no Access stamp counts.
    writeFileSync(
      join(dataDir, OWNER_SIGNIN_FILE),
      JSON.stringify({ email: OWNER, at: '2026-11-19T10:00:00.000Z' }),
      { mode: 0o600 },
    );
    cloud = createServer({
      port: 0,
      dataDir,
      proxiedTrustedHosts: [CLOUD_HOST],
      proxiedTrustedEmails: [OWNER],
      signIn: {
        mode: 'better-auth',
        origin: `https://${CLOUD_HOST}`,
        google: { clientId: 'shared-client', clientSecret: 'stub-secret' },
      },
    });
    cloudBoard = await makeBoard('Riverbend board');
    otherBoard = await makeBoard('Saltmarsh board');
    env = {
      ONE_ADDRESS: ONE_HOST,
      ONE_ADDRESS_ORIGIN: MAC_ORIGIN,
      PROJECT_ORIGINS: JSON.stringify({ harborlight: MAC_ORIGIN, riverbend: CLOUD_ORIGIN }),
      BOARD_ORIGINS: JSON.stringify({ [CLOUD_ORIGIN]: [cloudBoard, otherBoard] }),
    };
  });

  afterAll(async () => {
    await cloud.stop();
    for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  });

  describe("Home's feed", () => {
    const feedPath = () => `/workspaces/${cloudBoard}/home-feed`;

    it('admits a board token for that board, with no Access stamp', async () => {
      const token = await mint(cloudBoard, 'home-feed');
      const res = await at(feedPath(), { authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { boardName: string }).boardName).toBe('Riverbend board');
    });

    it('refuses no token, and a token for another board', async () => {
      expect((await at(feedPath())).status).toBe(403);
      const other = await mint(otherBoard, 'home-feed-other');
      expect((await at(feedPath(), { authorization: `Bearer ${other}` })).status).toBe(403);
      // CONTROL: that token opens its own board's feed.
      const own = await at(`/workspaces/${otherBoard}/home-feed`, {
        authorization: `Bearer ${other}`,
      });
      expect(own.status).toBe(200);
    });

    const remotes = (
      boardTokens: Record<string, string>,
      stateFile?: string,
      now?: () => number,
    ) => {
      const config = parseHomeRemotesConfig(
        JSON.stringify({
          address: `https://${ONE_HOST}`,
          self: MAC_ORIGIN,
          boardOrigins: { [CLOUD_ORIGIN]: [cloudBoard] },
          boardTokens,
          addresses: { [CLOUD_ORIGIN]: `https://${CLOUD_HOST}` },
        }),
      );
      if ('error' in config) throw new Error(config.error);
      return createHomeRemotes({
        config,
        fetch: internet,
        onChange: () => {},
        retryMs: 50,
        ...(stateFile ? { stateFile } : {}),
        ...(now ? { now } : {}),
      });
    };

    it("Home pulls the feed at Riverbend's own address on the board token", async () => {
      const home = remotes({ [cloudBoard]: await mint(cloudBoard, 'home-pull') });
      try {
        home.start();
        const view = await waitFor(() => home.boards().find((b) => b.reached !== null), {
          describe: 'the first read of the remote feed',
        });
        expect(view.reached).toBe(true);
        expect(view.boardName).toBe('Riverbend board');
      } finally {
        home.dispose();
      }
    });

    it('CONTROL: with a token for another board, the feed is not reached', async () => {
      const home = remotes({ [cloudBoard]: await mint(otherBoard, 'home-wrong') });
      try {
        home.start();
        const view = await waitFor(() => home.boards().find((b) => b.reached !== null), {
          describe: 'the first read of the remote feed',
        });
        expect(view.reached).toBe(false);
      } finally {
        home.dispose();
      }
    });

    it('renews a token past half its life, and keeps the new value mode 600', async () => {
      const first = await mint(cloudBoard, 'home-renew');
      const stateFile = join(tmp(), 'home-feed-bearers.json');
      // Six days on: past half of the seven-day life, still before expiry.
      const sixDays = 6 * 24 * 60 * 60 * 1000;
      const home = remotes({ [cloudBoard]: first }, stateFile, () => Date.now() + sixDays);
      try {
        home.start();
        const saved = await waitFor(
          () => {
            try {
              return JSON.parse(readFileSync(stateFile, 'utf8')) as Record<
                string,
                { value: string }
              >;
            } catch {
              return null;
            }
          },
          { describe: 'the renewed token, saved' },
        );
        const renewed = saved[cloudBoard]?.value ?? '';
        expect(renewed.startsWith('at2.')).toBe(true);
        expect(renewed).not.toBe(first);
        expect(statSync(stateFile).mode & 0o777).toBe(0o600);
        // The renewed value opens the feed.
        expect((await at(feedPath(), { authorization: `Bearer ${renewed}` })).status).toBe(200);
      } finally {
        home.dispose();
      }
    });
  });

  describe("the relay's board token", () => {
    it('opens its board with no Access stamp', async () => {
      const token = await mint(cloudBoard, 'agent-relay');
      const res = await at(`/workspaces/${cloudBoard}?format=json`, {
        authorization: `Bearer ${token}`,
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Riverbend board');
    });

    it('opens no other board, and a forged token opens nothing', async () => {
      const token = await mint(cloudBoard, 'agent-relay-scope');
      const other = await at(`/workspaces/${otherBoard}?format=json`, {
        authorization: `Bearer ${token}`,
      });
      expect(other.status).toBe(403);
      const forged = `${token.slice(0, -4)}AAAA`;
      const res = await at(`/workspaces/${cloudBoard}?format=json`, {
        authorization: `Bearer ${forged}`,
      });
      expect(res.status).toBe(401);
    });

    it('renews itself through the edge with no Access stamp', async () => {
      const token = await mint(cloudBoard, 'agent-relay-renew');
      const res = await internet(`https://${CLOUD_HOST}/api/board-tokens/refresh`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { token: string }).token.startsWith('at2.')).toBe(true);
    });
  });
});
