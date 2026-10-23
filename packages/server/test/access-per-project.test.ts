/**
 * One Cloudflare Access application per project, over two real servers and
 * the board router Worker's own handler.
 *
 * Three applications, three audiences: the one address's (owned by the Mac),
 * the Mac's own subdomain's, and Riverbend's. The Mac answers the one address
 * and its subdomain, each checked against its own application
 * (`CfAccessOptions.hostAudiences`); Riverbend answers only its subdomain. The
 * Worker runs with `ONE_ADDRESS_ORIGIN`, so the one address forwards only to
 * the Mac.
 *
 * What this proves: Bryan's stamp as Riverbend's server receives it, replayed
 * through the router to the Mac on either of its hosts, is refused, while the
 * Mac's own stamps are admitted; the one address never forwards a stamp to
 * Riverbend; and the home feed's service token and the relay's board token
 * are admitted on Riverbend only with Riverbend's audience, with Home pulling
 * the feed at Riverbend's own address.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { handleBoardRequest } from '../../../infra/board-router-worker/worker.js';
import { type FetchLike, createHomeRemotes, parseHomeRemotesConfig } from '../src/home-remotes.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { waitFor } from './wait-for.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'per-project-kid';
const ONE_HOST = 'workspaces.harborlight.test';
const MAC_HOST = `harborlight.${ONE_HOST}`;
const CLOUD_HOST = `riverbend.${ONE_HOST}`;
const MAC_ORIGIN = 'mac-origin.harborlight.test';
const CLOUD_ORIGIN = 'riverbend-origin.harborlight.test';
const OWNER_EMAIL = 'owner@harborlight.test';
const AUD = { one: 'aud-one-address-app', mac: 'aud-harborlight-app', cloud: 'aud-riverbend-app' };
/** The application Access puts in front of each host. */
const APP_OF_HOST: Record<string, string> = {
  [ONE_HOST]: AUD.one,
  [MAC_HOST]: AUD.mac,
  [CLOUD_HOST]: AUD.cloud,
};
const FEED_TOKEN = { clientId: 'test-client-riverbend.access', clientSecret: crypto.randomUUID() };

type Sign = (aud: string, claims?: Record<string, unknown>) => Promise<string>;
let sign: Sign;
let jwks: JSONWebKeySet;

const person = (aud: string) => sign(aud, { email: OWNER_EMAIL });
const service = (aud: string) => sign(aud, { common_name: FEED_TOKEN.clientId });

describe('one Access application per project', () => {
  const dataDirs: string[] = [];
  let mac: ServerHandle;
  let cloud: ServerHandle;
  let macBoard: string;
  let cloudBoard: string;
  let env: Record<string, string>;
  const reached: string[] = [];

  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'access-per-project-'));
    dataDirs.push(d);
    return d;
  };
  const local = (handle: ServerHandle, path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${handle.port}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const makeBoard = async (handle: ServerHandle, name: string) => {
    const res = await local(handle, '/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { workspace: { id: string } }).workspace.id;
  };

  /** The tunnel: origin hostname to a loopback port, Host kept, `cf-ray` added. */
  const tunnel = async (
    request: Request,
    init: { redirect?: 'manual'; cf: { resolveOverride: string } },
  ) => {
    const origin = init.cf.resolveOverride;
    reached.push(origin);
    const port = origin === MAC_ORIGIN ? mac.port : origin === CLOUD_ORIGIN ? cloud.port : null;
    if (port === null) throw new Error(`no tunnel for ${origin}`);
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set('host', url.host);
    headers.set('cf-ray', '8a1b2c3d4e5f-SJC');
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      redirect: 'manual',
      ...(request.signal ? { signal: request.signal } : {}),
    });
  };
  /** Through the Worker with the stamp given, as a replayed copy would arrive. */
  const via = (host: string, path: string, headers: Record<string, string> = {}) =>
    handleBoardRequest(new Request(`https://${host}${path}`, { headers }), env, tunnel);

  /**
   * Access in front of every host, for a service token: a token it knows
   * becomes a stamp from the application in front of the host asked, naming
   * that token's client id; the secret goes no further. Then the Worker.
   */
  const edge: FetchLike = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    const id = headers.get('cf-access-client-id');
    const secret = headers.get('cf-access-client-secret');
    if (id !== FEED_TOKEN.clientId || secret !== FEED_TOKEN.clientSecret) {
      return new Response('Forbidden', { status: 403 });
    }
    const aud = APP_OF_HOST[new URL(input).hostname];
    if (!aud) return new Response('Not found', { status: 404 });
    headers.delete('cf-access-client-id');
    headers.delete('cf-access-client-secret');
    headers.set('cf-access-jwt-assertion', await service(aud));
    const request = new Request(input, {
      headers,
      ...(init.signal ? { signal: init.signal } : {}),
    });
    return handleBoardRequest(request, env, tunnel);
  };

  const boardJson = (id: string) => `/workspaces/${id}?format=json`;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = (await exportJWK(publicKey)) as JWK;
    jwk.kid = KID;
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    jwks = { keys: [jwk] };
    sign = (aud, claims = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(`https://${TEAM_DOMAIN}`)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .sign(privateKey);

    mac = createServer({
      port: 0,
      dataDir: tmp(),
      cfAccess: {
        teamDomain: TEAM_DOMAIN,
        audience: AUD.one,
        hostAudiences: new Map([[MAC_HOST, AUD.mac]]),
        jwks,
      },
      proxiedTrustedHosts: [ONE_HOST, MAC_HOST],
      proxiedTrustedEmails: [OWNER_EMAIL],
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    });
    cloud = createServer({
      port: 0,
      dataDir: tmp(),
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: AUD.cloud, jwks },
      proxiedTrustedHosts: [CLOUD_HOST],
      proxiedTrustedEmails: [OWNER_EMAIL],
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
      homeFeedClientId: FEED_TOKEN.clientId,
    });
    macBoard = await makeBoard(mac, 'Harborlight board');
    cloudBoard = await makeBoard(cloud, 'Riverbend board');
    env = {
      ONE_ADDRESS: ONE_HOST,
      ONE_ADDRESS_ORIGIN: MAC_ORIGIN,
      PROJECT_ORIGINS: JSON.stringify({ harborlight: MAC_ORIGIN, riverbend: CLOUD_ORIGIN }),
      BOARD_ORIGINS: JSON.stringify({ [MAC_ORIGIN]: [macBoard], [CLOUD_ORIGIN]: [cloudBoard] }),
    };
  });

  afterAll(async () => {
    await mac.stop();
    await cloud.stop();
    for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  });

  describe("Riverbend's copy of Bryan's stamp, replayed to the Mac", () => {
    it('CONTROL: Riverbend admits Bryan on its own stamp', async () => {
      const res = await via(CLOUD_HOST, boardJson(cloudBoard), {
        'cf-access-jwt-assertion': await person(AUD.cloud),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Riverbend board');
    });

    it("is refused on the Mac's subdomain, after reaching the Mac", async () => {
      reached.length = 0;
      const res = await via(MAC_HOST, boardJson(macBoard), {
        'cf-access-jwt-assertion': await person(AUD.cloud),
      });
      expect(reached).toEqual([MAC_ORIGIN]);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain('Harborlight board');
    });

    it('is refused on the one address, after reaching the Mac', async () => {
      reached.length = 0;
      const res = await via(ONE_HOST, boardJson(macBoard), {
        'cf-access-jwt-assertion': await person(AUD.cloud),
      });
      expect(reached).toEqual([MAC_ORIGIN]);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain('Harborlight board');
    });

    it("CONTROL: the Mac admits Bryan on each host's own application's stamp", async () => {
      const sub = await via(MAC_HOST, boardJson(macBoard), {
        'cf-access-jwt-assertion': await person(AUD.mac),
      });
      expect(sub.status).toBe(200);
      expect(await sub.text()).toContain('Harborlight board');
      const one = await via(ONE_HOST, boardJson(macBoard), {
        'cf-access-jwt-assertion': await person(AUD.one),
      });
      expect(one.status).toBe(200);
    });

    it("the Mac's two applications do not stand in for each other", async () => {
      const oneOnSub = await via(MAC_HOST, boardJson(macBoard), {
        'cf-access-jwt-assertion': await person(AUD.one),
      });
      expect(oneOnSub.status).toBe(401);
      const subOnOne = await via(ONE_HOST, boardJson(macBoard), {
        'cf-access-jwt-assertion': await person(AUD.mac),
      });
      expect(subOnOne.status).toBe(401);
    });

    it("Riverbend refuses both of the Mac's stamps", async () => {
      for (const aud of [AUD.one, AUD.mac]) {
        const res = await via(CLOUD_HOST, boardJson(cloudBoard), {
          'cf-access-jwt-assertion': await person(aud),
        });
        expect(res.status).toBe(401);
      }
    });
  });

  describe('the one address keeps its stamp on the Mac', () => {
    it("redirects Riverbend's board to Riverbend's subdomain and forwards nothing", async () => {
      reached.length = 0;
      const res = await via(ONE_HOST, boardJson(cloudBoard), {
        'cf-access-jwt-assertion': await person(AUD.one),
      });
      expect(res.status).toBe(308);
      expect(res.headers.get('location')).toBe(`https://${CLOUD_HOST}${boardJson(cloudBoard)}`);
      expect(reached).toEqual([]);
    });

    it('CONTROL: without ONE_ADDRESS_ORIGIN the same request is forwarded to Riverbend', async () => {
      reached.length = 0;
      const { ONE_ADDRESS_ORIGIN: _home, ...open } = env;
      const res = await handleBoardRequest(
        new Request(`https://${ONE_HOST}${boardJson(cloudBoard)}`, {
          headers: { 'cf-access-jwt-assertion': await person(AUD.one) },
        }),
        open,
        tunnel,
      );
      // Riverbend now holds a copy of the one address's stamp. It answers
      // nothing for it (the one address is on none of its lists), but the
      // copy is what the Mac would accept, which is why the Worker redirects.
      expect(reached).toEqual([CLOUD_ORIGIN]);
      expect(res.status).toBe(403);
    });
  });

  describe('the feed and relay tokens, per audience', () => {
    const feedPath = () => `/workspaces/${cloudBoard}/home-feed`;

    it("admits the feed's service token with Riverbend's audience", async () => {
      const res = await via(CLOUD_HOST, feedPath(), {
        'cf-access-jwt-assertion': await service(AUD.cloud),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { boardName: string }).boardName).toBe('Riverbend board');
    });

    it("refuses the same service token stamped by the one address's application", async () => {
      const res = await via(CLOUD_HOST, feedPath(), {
        'cf-access-jwt-assertion': await service(AUD.one),
      });
      expect(res.status).toBe(403);
    });

    const remotes = (addresses?: Record<string, string>) => {
      const config = parseHomeRemotesConfig(
        JSON.stringify({
          address: `https://${ONE_HOST}`,
          self: MAC_ORIGIN,
          boardOrigins: { [MAC_ORIGIN]: [macBoard], [CLOUD_ORIGIN]: [cloudBoard] },
          serviceTokens: { [CLOUD_ORIGIN]: FEED_TOKEN },
          ...(addresses ? { addresses } : {}),
        }),
      );
      if ('error' in config) throw new Error(config.error);
      return createHomeRemotes({ config, fetch: edge, onChange: () => {}, retryMs: 50 });
    };

    it("Home pulls the feed at Riverbend's own address", async () => {
      const home = remotes({ [CLOUD_ORIGIN]: `https://${CLOUD_HOST}` });
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

    it('CONTROL: pulled at the one address, the feed is not reached', async () => {
      const home = remotes();
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

    it("admits the relay's board token only under Riverbend's audience", async () => {
      const minted = await local(cloud, '/api/board-tokens', {
        method: 'POST',
        body: JSON.stringify({ agentId: 'agent-relay', boardId: cloudBoard, label: 'relay' }),
      });
      expect(minted.status).toBe(201);
      const { token } = (await minted.json()) as { token: string };
      const as = async (aud: string) =>
        via(CLOUD_HOST, `/workspaces/${cloudBoard}`, {
          'cf-access-jwt-assertion': await service(aud),
          authorization: `Bearer ${token}`,
        });
      expect((await as(AUD.cloud)).status).toBe(200);
      expect((await as(AUD.one)).status).toBe(401);
    });
  });
});
