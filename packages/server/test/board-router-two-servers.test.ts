/**
 * The one address over two real board servers. Two servers run on loopback
 * ports, each configured as a cloud board server would be: the one address
 * as its proxied hostname, the one Access application's audience, and its own
 * check of the stamp. The board router Worker's handler places each request;
 * a stand-in for the tunnel carries it to the chosen server with the Host
 * header unchanged and the `cf-ray` Cloudflare adds.
 *
 * What this proves: a board on the second server is reached through the one
 * address with a valid stamp; that server refuses the same request with no
 * stamp or a forged one; an unknown board stops at the Worker; and the second
 * server's loopback callers are unaffected. Every one of those runs with the
 * project subdomains configured, so the board paths of today are shown
 * unchanged by them, and the second server is also reached on its own
 * subdomain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { handleBoardRequest } from '../../../infra/board-router-worker/worker.js';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'board-router-kid';
const APP_AUD = 'aud-one-address-app';
const ONE_HOST = 'workspaces.harborlight.test';
const OWNER_EMAIL = 'owner@harborlight.test';
const MAC_ORIGIN = 'mac-origin.harborlight.test';
const CLOUD_ORIGIN = 'riverbend-origin.harborlight.test';
const CLOUD_HOST = `riverbend.${ONE_HOST}`;
const MAC_HOST = `harborlight.${ONE_HOST}`;

type Sign = (opts?: { aud?: string; email?: string }) => Promise<string>;
let jwks: JSONWebKeySet;
let sign: Sign;
let forge: Sign;

const signer = async (kid: string): Promise<{ jwk: JWK; sign: Sign }> => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = (await exportJWK(publicKey)) as JWK;
  jwk.kid = kid;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  return {
    jwk,
    sign: ({ aud = APP_AUD, email = OWNER_EMAIL } = {}) =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(`https://${TEAM_DOMAIN}`)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .setSubject('cf-access-visitor')
        .sign(privateKey),
  };
};

beforeAll(async () => {
  const real = await signer(KID);
  jwks = { keys: [real.jwk] };
  sign = real.sign;
  // Same kid, same claims, a key Cloudflare never published.
  forge = (await signer(KID)).sign;
});

describe('the one address routes a board to the server that holds it', () => {
  const dataDirs: string[] = [];
  let mac: ServerHandle;
  let cloud: ServerHandle;
  let macBoard: string;
  let cloudBoard: string;
  let config: string;
  const reached: string[] = [];

  const boot = (ownHost: string) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'board-router-'));
    dataDirs.push(dataDir);
    return createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: APP_AUD, jwks },
      // Each server answers the one address and its own project subdomain.
      proxiedTrustedHosts: [ONE_HOST, ownHost],
      proxiedTrustedEmails: [OWNER_EMAIL],
      // Sharing wired, as on every deployed server. Without it the server
      // runs in legacy whole-server mode, where loopback needs a stamp too.
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    });
  };
  const local = (handle: ServerHandle, path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${handle.port}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const makeBoard = async (handle: ServerHandle, name: string) => {
    const res = await local(handle, '/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { workspace: { id: string } }).workspace.id;
  };

  /**
   * The tunnel stand-in: the origin hostname picks a loopback port, the Host
   * header stays the one address, and the edge's `cf-ray` is added, which is
   * what a request through a real tunnel carries.
   */
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
    });
  };
  const via = (host: string, path: string, headers: Record<string, string> = {}) =>
    handleBoardRequest(
      new Request(`https://${host}${path}`, { headers }),
      {
        ONE_ADDRESS: ONE_HOST,
        BOARD_ORIGINS: config,
        PROJECT_ORIGINS: JSON.stringify({ harborlight: MAC_ORIGIN, riverbend: CLOUD_ORIGIN }),
      },
      tunnel,
    );
  const viaOneAddress = (path: string, headers: Record<string, string> = {}) =>
    via(ONE_HOST, path, headers);
  const boardJson = (id: string) => `/workspaces/${id}?format=json`;

  beforeAll(async () => {
    mac = boot(MAC_HOST);
    cloud = boot(CLOUD_HOST);
    macBoard = await makeBoard(mac, 'Harborlight board');
    cloudBoard = await makeBoard(cloud, 'Riverbend board');
    config = JSON.stringify({ [MAC_ORIGIN]: [macBoard], [CLOUD_ORIGIN]: [cloudBoard] });
  });

  afterAll(async () => {
    await mac.stop();
    await cloud.stop();
    for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('reaches the board on the second server with a valid stamp', async () => {
    reached.length = 0;
    const res = await viaOneAddress(boardJson(cloudBoard), {
      'cf-access-jwt-assertion': await sign(),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Riverbend board');
    expect(reached).toEqual([CLOUD_ORIGIN]);
  });

  it('reaches the first server for its own board', async () => {
    reached.length = 0;
    const res = await viaOneAddress(boardJson(macBoard), {
      'cf-access-jwt-assertion': await sign(),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Harborlight board');
    expect(reached).toEqual([MAC_ORIGIN]);
  });

  it('CONTROL: the first server does not hold the second board', async () => {
    // So the 200 above came from the second server and nowhere else.
    const res = await tunnel(
      new Request(`https://${ONE_HOST}${boardJson(cloudBoard)}`, {
        headers: { 'cf-access-jwt-assertion': await sign() },
      }),
      { cf: { resolveOverride: MAC_ORIGIN } },
    );
    expect(res.status).not.toBe(200);
  });

  it('the second server refuses the routed request with no stamp', async () => {
    const res = await viaOneAddress(boardJson(cloudBoard));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('Riverbend board');
  });

  it('the second server refuses a stamp signed by a key Cloudflare never published', async () => {
    const res = await viaOneAddress(boardJson(cloudBoard), {
      'cf-access-jwt-assertion': await forge(),
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('Riverbend board');
  });

  it('the second server refuses a valid stamp for another Access application', async () => {
    const res = await viaOneAddress(boardJson(cloudBoard), {
      'cf-access-jwt-assertion': await sign({ aud: 'aud-some-other-app' }),
    });
    expect(res.status).toBe(401);
  });

  it('an unknown board stops at the Worker and reaches neither server', async () => {
    reached.length = 0;
    const res = await viaOneAddress(boardJson('w-unlisted'), {
      'cf-access-jwt-assertion': await sign(),
    });
    expect(res.status).toBe(404);
    expect(reached).toEqual([]);
  });

  it('loads the board page itself through the one address', async () => {
    reached.length = 0;
    const res = await viaOneAddress(`/workspaces/${cloudBoard}`, {
      'cf-access-jwt-assertion': await sign(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(reached).toEqual([CLOUD_ORIGIN]);
  });

  it("reaches the second server's board on that project's subdomain", async () => {
    reached.length = 0;
    const res = await via(CLOUD_HOST, boardJson(cloudBoard), {
      'cf-access-jwt-assertion': await sign(),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Riverbend board');
    expect(reached).toEqual([CLOUD_ORIGIN]);
  });

  it("CONTROL: the first project's subdomain reaches the first server, which lacks that board", async () => {
    reached.length = 0;
    const res = await via(MAC_HOST, boardJson(cloudBoard), {
      'cf-access-jwt-assertion': await sign(),
    });
    expect(reached).toEqual([MAC_ORIGIN]);
    // A 404 from the board lookup, not a refused host: the first server
    // answers its own subdomain, as the next case shows.
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('workspace not found');
    const own = await via(MAC_HOST, boardJson(macBoard), {
      'cf-access-jwt-assertion': await sign(),
    });
    expect(own.status).toBe(200);
  });

  it('an unknown project subdomain stops at the Worker and reaches neither server', async () => {
    reached.length = 0;
    const res = await via(`saltmarsh.${ONE_HOST}`, boardJson(cloudBoard), {
      'cf-access-jwt-assertion': await sign(),
    });
    expect(res.status).toBe(404);
    expect(reached).toEqual([]);
  });

  it('the second server refuses its subdomain with no stamp', async () => {
    const res = await via(CLOUD_HOST, boardJson(cloudBoard));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('Riverbend board');
  });

  it('loopback on the second server is unchanged: no stamp, and it reads the board', async () => {
    const res = await local(cloud, boardJson(cloudBoard));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Riverbend board');
  });
});
