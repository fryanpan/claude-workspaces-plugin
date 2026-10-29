/**
 * Bryan's Home across two real board servers.
 *
 * Two servers run on loopback ports: the Mac, which pulls, and a project
 * server, which holds a board and answers the home feed. Nothing calls the
 * Mac; the Mac's pull goes out through a stand-in for the edge that plays
 * Cloudflare's three parts in order — Access turns the service token into a
 * signed stamp, the board router Worker's own handler picks the server from
 * the same table the Mac reads, and the tunnel carries the request with the
 * Host unchanged and `cf-ray` added. A third origin in the table answers
 * planted rows, standing in for a compromised project server.
 *
 * What this proves: an item filed on the project server shows on the Mac's
 * Home, an open Home hears about it and about its answer without a reload,
 * the project server refuses every caller but the Mac's service token and a
 * loopback peer, and the planted rows render as plain text with their bad
 * links removed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { handleBoardRequest } from '../../../infra/board-router-worker/worker.js';
import { type FetchLike, parseHomeRemotesConfig } from '../src/home-remotes.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { landingFrames } from './landing-frames.ts';
import { signedInPerson } from './signed-in-person.ts';
import { waitFor } from './wait-for.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'home-across-kid';
const APP_AUD = 'aud-one-address-app';
const ONE_HOST = 'workspaces.harborlight.test';
const MAC_ORIGIN = 'mac-origin.harborlight.test';
const CLOUD_ORIGIN = 'riverbend-origin.harborlight.test';
const PLANTED_ORIGIN = 'saltmarsh-origin.harborlight.test';
const PLANTED_BOARD = 'w-salt';
const AGENT = { id: 'agent-riverbend', name: 'Riverbend', kind: 'agent' };
/** Bryan, signed in on the project server's page: set once that server is up. */
let PERSON: { id: string; name: string } = { id: '', name: 'Bryan' };
/** What his browser sends with a press, keyed by the server it is signed in on. */
const PROOF = new Map<ServerHandle, Record<string, string>>();

/** Fake service tokens, made here and nowhere else. */
const fakeToken = (origin: string) => ({
  clientId: `test-client-${origin.split('.')[0]}.access`,
  clientSecret: `test-secret-${crypto.randomUUID()}`,
});

type Sign = (claims: Record<string, unknown>, aud?: string) => Promise<string>;

const signer = async (): Promise<{ jwk: JWK; sign: Sign }> => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = (await exportJWK(publicKey)) as JWK;
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  return {
    jwk,
    sign: (claims, aud = APP_AUD) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(`https://${TEAM_DOMAIN}`)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .setSubject('cf-access-service-token')
        .sign(privateKey),
  };
};

describe('Home on the Mac shows the project server’s review items', () => {
  const dataDirs: string[] = [];
  let mac: ServerHandle;
  let cloud: ServerHandle;
  let cloudBoard: string;
  let sign: Sign;
  let forge: Sign;
  let jwks: JSONWebKeySet;
  const tokens = {
    [CLOUD_ORIGIN]: fakeToken(CLOUD_ORIGIN),
    [PLANTED_ORIGIN]: fakeToken(PLANTED_ORIGIN),
  };
  /** Every origin the edge carried a request to, in order. */
  const carried: string[] = [];
  let table = '';

  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'home-across-'));
    dataDirs.push(dir);
    return dir;
  };
  const local = (handle: ServerHandle, path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${handle.port}${path}`, {
      ...init,
      headers: { host: `localhost:${handle.port}`, ...((init.headers as object) ?? {}) },
    });
  const post = async (handle: ServerHandle, path: string, body: unknown) => {
    const mine = (body as { author?: { id?: string } }).author?.id === PERSON.id;
    const res = await local(handle, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(mine ? PROOF.get(handle) : {}) },
      body: JSON.stringify(body),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  const home = async () => {
    const page = await (await local(mac, '/')).text();
    const start = page.indexOf('<div id="landing-review">');
    const end = page.indexOf('<div id="landing-boards">');
    expect(start).toBeGreaterThanOrEqual(0);
    return page.slice(start, end);
  };

  /** A planted row's answer, from a project server somebody else controls. */
  const now = Date.now();
  const planted = () => ({
    v: 1,
    boardId: PLANTED_BOARD,
    boardName: 'Saltmarsh <b>board</b>',
    html: '<script>top-level-field</script>',
    rows: [
      {
        key: 'planted-script',
        kind: 'task-review',
        title: '<script>alert(1)</script>Saltmarsh release',
        ask: '<img src=x onerror=alert(2)> [open](javascript:alert(3)) **now**',
        askedBy: 'Saltmarsh lead',
        since: now,
        href: 'javascript:alert(4)',
        onclick: 'alert(5)',
      },
      {
        key: 'planted-other-board',
        kind: 'task-review',
        title: 'Points at a board this server does not hold',
        ask: 'Open it',
        askedBy: 'Saltmarsh lead',
        since: now,
        href: `/workspaces/${cloudBoard}?task=x-planted`,
      },
      {
        key: 'planted-other-host',
        kind: 'doc-thread',
        title: 'Points off this origin',
        ask: 'Open it',
        askedBy: 'Saltmarsh lead',
        since: now,
        href: `//evil.harborlight.test/workspaces/${PLANTED_BOARD}`,
      },
      {
        key: 'planted-own-board',
        kind: 'task-review',
        title: 'Points at its own board',
        ask: 'Open it',
        askedBy: 'Saltmarsh lead',
        since: now,
        href: `/workspaces/${PLANTED_BOARD}?task=t-planted`,
      },
      { key: 'planted-bad-kind', kind: 'script', title: 'x', ask: 'x', askedBy: 'x', since: now },
      { key: 7, kind: 'task-review', title: 'x', ask: 'x', askedBy: 'x', since: now },
    ],
  });

  /** The tunnel: origin hostname to a loopback port, Host kept, `cf-ray` added. */
  const tunnel = async (
    request: Request,
    init: { redirect?: 'manual'; cf: { resolveOverride: string } },
  ): Promise<Response> => {
    const origin = init.cf.resolveOverride;
    carried.push(origin);
    const url = new URL(request.url);
    if (origin === PLANTED_ORIGIN) {
      if (url.pathname.endsWith('/events:stream')) {
        // Open and silent: the Mac reads the feed once when it opens.
        return new Response(new ReadableStream({ start() {} }), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return Response.json(planted());
    }
    if (origin !== CLOUD_ORIGIN) throw new Error(`no tunnel for ${origin}`);
    const headers = new Headers(request.headers);
    headers.set('host', url.host);
    headers.set('cf-ray', '8a1b2c3d4e5f-SJC');
    return fetch(`http://127.0.0.1:${cloud.port}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      redirect: 'manual',
      signal: request.signal,
    });
  };

  /**
   * The edge the Mac calls out through. Access first: a request carrying a
   * service token Access knows becomes one with a stamp naming that token's
   * client id, and its secret goes no further. Then the Worker routes.
   */
  const edge: FetchLike = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    const id = headers.get('cf-access-client-id');
    const secret = headers.get('cf-access-client-secret');
    const known = Object.values(tokens).find((t) => t.clientId === id && t.clientSecret === secret);
    if (!known) return new Response('Forbidden', { status: 403 });
    headers.delete('cf-access-client-id');
    headers.delete('cf-access-client-secret');
    headers.set('cf-access-jwt-assertion', await sign({ common_name: known.clientId }));
    const request = new Request(input, {
      headers,
      ...(init.signal ? { signal: init.signal } : {}),
    });
    return handleBoardRequest(request, { BOARD_ORIGINS: table }, tunnel);
  };

  /** A request through the tunnel straight to the project server. */
  const viaTunnel = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    handleBoardRequest(
      new Request(`https://${ONE_HOST}${path}`, { method, headers }),
      { BOARD_ORIGINS: table },
      tunnel,
    );

  beforeAll(async () => {
    const real = await signer();
    jwks = { keys: [real.jwk] };
    sign = real.sign;
    // Same kid and claims, a key Cloudflare never published.
    forge = (await signer()).sign;

    const cloudDir = tmp();
    cloud = createServer({
      port: 0,
      dataDir: cloudDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: APP_AUD, jwks },
      // Sharing wired, as on every deployed server; without it loopback
      // would need a stamp too.
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
      homeFeedClientId: tokens[CLOUD_ORIGIN].clientId,
    });
    const bryan = signedInPerson(cloud, cloudDir, `localhost:${cloud.port}`, {
      email: 'owner@riverbend.example',
      name: 'Bryan',
    });
    PERSON = bryan.user;
    PROOF.set(cloud, bryan.headers);
    cloudBoard = (
      (await post(cloud, '/workspaces', { name: 'Riverbend board', author: AGENT })) as {
        workspace: { id: string };
      }
    ).workspace.id;

    const boardOrigins = {
      [MAC_ORIGIN]: ['w-harbor'],
      [CLOUD_ORIGIN]: [cloudBoard],
      [PLANTED_ORIGIN]: [PLANTED_BOARD],
    };
    table = JSON.stringify(boardOrigins);
    const config = parseHomeRemotesConfig(
      JSON.stringify({
        address: `https://${ONE_HOST}`,
        self: MAC_ORIGIN,
        boardOrigins,
        serviceTokens: tokens,
      }),
    );
    if ('error' in config) throw new Error(config.error);
    mac = createServer({
      port: 0,
      dataDir: tmp(),
      homeRemotes: { config, fetch: edge, retryMs: 50 },
    });
  });

  afterAll(async () => {
    await mac.stop();
    await cloud.stop();
    for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('an item filed on the project server reaches an open Home, and so does its answer', async () => {
    const feed = landingFrames(await local(mac, '/landing/events:stream'));
    try {
      const { task } = (await post(cloud, `/workspaces/${cloudBoard}/tasks`, {
        title: 'Riverbend release notes',
        body: 'Bryan can pick the Riverbend release date so that the notes go out on time.',
        author: AGENT,
      })) as { task: { id: string } };
      const frames = feed.count();
      const { item } = (await post(
        cloud,
        `/workspaces/${cloudBoard}/tasks/${task.id}/review-items`,
        {
          review: {
            shape: 'decision',
            headline: 'Ship the Riverbend notes Friday or Monday?',
            options: [
              { id: 'fri', label: 'Friday' },
              { id: 'mon', label: 'Monday' },
            ],
          },
          author: AGENT,
        },
      )) as { item: { id: string } };

      // The open page is told, and the re-read it makes shows the item.
      await waitFor(() => feed.count() > frames, { describe: 'a frame for the remote item' });
      const shown = await waitFor(
        async () => {
          const h = await home();
          return h.includes('Ship the Riverbend notes Friday or Monday?') ? h : undefined;
        },
        { describe: 'the remote item on Home' },
      );
      expect(shown).toContain('Riverbend board');
      expect(shown).toContain(
        `href="/workspaces/${encodeURIComponent(cloudBoard)}?task=${encodeURIComponent(task.id)}"`,
      );
      // The project server never called the Mac: every request went out.
      expect(carried).toContain(CLOUD_ORIGIN);
      expect(carried).not.toContain(MAC_ORIGIN);

      const before = feed.count();
      await post(
        cloud,
        `/workspaces/${cloudBoard}/tasks/${task.id}/review-items/${item.id}/answer`,
        {
          text: 'Friday.',
          answeredWith: 'fri',
          author: PERSON,
        },
      );
      await waitFor(() => feed.count() > before, { describe: 'a frame for the answer' });
      await waitFor(
        async () => !(await home()).includes('Ship the Riverbend notes Friday or Monday?'),
        { describe: 'the answered item off Home' },
      );
    } finally {
      feed.stop();
    }
  });

  it('renders planted rows as plain text and refuses their bad links', async () => {
    const h = await waitFor(
      async () => {
        const page = await home();
        return page.includes('Points at its own board') ? page : undefined;
      },
      { describe: 'the planted rows on Home' },
    );
    // Every field is text: the markup arrives escaped, never as markup.
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;Saltmarsh release');
    expect(h).toContain('&lt;img src=x onerror=alert(2)&gt; [open](javascript:alert(3)) **now**');
    expect(h).toContain('Saltmarsh &lt;b&gt;board&lt;/b&gt;');
    expect(h).not.toContain('<script');
    expect(h).not.toContain('<img');
    expect(h).not.toContain('<b>');
    // Unknown fields are dropped, not drawn.
    expect(h).not.toContain('top-level-field');
    expect(h).not.toContain('alert(5)');
    // Links: only the one to the planted server's own board survives.
    expect(h).toContain(`href="/workspaces/${PLANTED_BOARD}?task=t-planted"`);
    expect(h).not.toContain('href="javascript:');
    expect(h).not.toContain('x-planted');
    expect(h).not.toContain('evil.harborlight.test');
    expect(h).toContain('Points at a board this server does not hold');
    // The refusals are counted where Bryan can see them.
    expect(h).toContain('2 items refused.');
    expect(h).toContain('3 links removed.');
  });

  describe('the project server answers the feed to the Mac and to nobody else', () => {
    const path = () => `/workspaces/${cloudBoard}/home-feed`;

    it('answers the Mac’s service token through the tunnel', async () => {
      const res = await viaTunnel(path(), {
        'cf-access-jwt-assertion': await sign({ common_name: tokens[CLOUD_ORIGIN].clientId }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { v: number; boardId: string };
      expect(body).toMatchObject({ v: 1, boardId: cloudBoard });
    });

    it('answers a loopback caller with no cf-ray', async () => {
      expect((await local(cloud, path())).status).toBe(200);
    });

    it('refuses the tunnel with no stamp', async () => {
      expect((await viaTunnel(path())).status).toBe(403);
    });

    it('refuses a stamp from a key Cloudflare never published', async () => {
      const res = await viaTunnel(path(), {
        'cf-access-jwt-assertion': await forge({ common_name: tokens[CLOUD_ORIGIN].clientId }),
      });
      expect(res.status).toBe(403);
    });

    it('refuses another service token, and the planted server’s', async () => {
      const res = await viaTunnel(path(), {
        'cf-access-jwt-assertion': await sign({ common_name: tokens[PLANTED_ORIGIN].clientId }),
      });
      expect(res.status).toBe(403);
    });

    it('refuses a person’s stamp, even one carrying the client id', async () => {
      const res = await viaTunnel(path(), {
        'cf-access-jwt-assertion': await sign({
          email: 'member-1',
          common_name: tokens[CLOUD_ORIGIN].clientId,
        }),
      });
      expect(res.status).toBe(403);
    });

    it('refuses a stamp for another Access application', async () => {
      const res = await viaTunnel(path(), {
        'cf-access-jwt-assertion': await sign(
          { common_name: tokens[CLOUD_ORIGIN].clientId },
          'aud-some-other-app',
        ),
      });
      expect(res.status).toBe(403);
    });

    it('answers only GET, and 404 for a board it does not hold', async () => {
      const stamp = {
        'cf-access-jwt-assertion': await sign({ common_name: tokens[CLOUD_ORIGIN].clientId }),
      };
      expect((await local(cloud, path(), { method: 'POST' })).status).toBe(405);
      expect((await local(cloud, '/workspaces/w-unheld/home-feed')).status).toBe(404);
      const stream = await viaTunnel(`${path()}/events:stream`, stamp, 'GET');
      expect(stream.status).toBe(200);
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      await stream.body?.cancel();
    });
  });
});
