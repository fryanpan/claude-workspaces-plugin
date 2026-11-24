/**
 * The external-access master switch covers the three families answered above
 * admission: the home feed, the GitHub relay and a project machine's board
 * import (`routes/hono-open-families.ts`).
 *
 * Each is driven through one real server whose caller would be admitted: an
 * Access service token through the tunnel, and for the relay the board's push
 * key as well. With the switch on each answers as it always did. With it off
 * each answers admission's `403 sharing_disabled` instead, the same answer a
 * request with no credential at all gets, while a process on this machine
 * still reads the home feed and the relay's list. Turning the switch back on
 * restores every answer.
 *
 * All fixtures synthetic; port 0; no request leaves the machine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'open-families-kid';
const AUD = 'aud-for-the-project-app';
const PROXIED_HOST = 'riverbend.example.com';
const SERVICE_CLIENT_ID = 'harborlight-service-token.access';
const IMPORT_BOARD = 'w-Harbor01';

let h: ServerHandle;
let dataDir: string;
let base = '';
let board = '';
let pushKey = '';
let serviceJwt = '';

const local = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      host: `localhost:${h.port}`,
      'content-type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
/** Through the tunnel: the edge adds cf-ray, Access adds its stamp. */
const tunnel = (path: string, stamp: string | null, init: RequestInit = {}) =>
  local(path, {
    ...init,
    headers: {
      host: PROXIED_HOST,
      'cf-ray': '8a1b2c3d4e5f-SJC',
      ...(stamp ? { 'cf-access-jwt-assertion': stamp } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
const keyed = () => ({ headers: { authorization: `Bearer ${pushKey}` } });

/**
 * Off is the route a caller on this machine uses; on is set directly, because
 * only the owner may turn it back on and these requests prove nobody.
 */
async function setSwitch(enabled: boolean): Promise<void> {
  if (enabled) {
    h.sharingGate.setEnabled(true);
    return;
  }
  const res = await local('/api/share/enabled', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

/** Status and error code, the two things a caller can tell apart. */
async function answer(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return `${res.status}${body.error ? ` ${body.error}` : ''}`;
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = (await exportJWK(publicKey)) as JWK;
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const jwks: JSONWebKeySet = { keys: [jwk] };
  serviceJwt = await new SignJWT({ common_name: SERVICE_CLIENT_ID })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(`https://${TEAM_DOMAIN}`)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
    .sign(privateKey);
  dataDir = mkdtempSync(join(tmpdir(), 'open-families-switch-'));
  h = createServer({
    port: 0,
    dataDir,
    cfAccess: { teamDomain: TEAM_DOMAIN, audience: AUD, jwks },
    share: { config: { publicHostname: 'links.example.com' } },
    proxiedTrustedHosts: [PROXIED_HOST],
    homeFeedClientId: SERVICE_CLIENT_ID,
    boardImport: { dir: join(dataDir, 'imports'), boards: [IMPORT_BOARD] },
  });
  base = `http://127.0.0.1:${h.port}`;
  const made = await local('/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name: 'Riverbend board' }),
  });
  board = ((await made.json()) as { workspace: { id: string } }).workspace.id;
  const minted = await local('/api/github-push-keys', {
    method: 'POST',
    body: JSON.stringify({ workspaceId: board }),
  });
  pushKey = ((await minted.json()) as { key: string }).key;
});

afterAll(async () => {
  await h?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the families above admission obey the external-access switch', () => {
  const feed = () => `/workspaces/${board}/home-feed`;
  const relay = () => `/workspaces/${board}/github/subscriptions`;
  const imported = `/api/board-import/${IMPORT_BOARD}`;

  it('answer an admitted tunnel caller while the switch is on', async () => {
    expect(await answer(await tunnel(feed(), serviceJwt))).toBe('200');
    expect(await answer(await tunnel(relay(), serviceJwt, keyed()))).toBe('200');
    expect(await answer(await tunnel(imported, serviceJwt))).toBe('200');
    // And refuse a caller with no stamp as they always did.
    expect(await answer(await tunnel(feed(), null))).toBe('403 forbidden');
    expect(await answer(await tunnel(imported, null))).toBe('403 forbidden');
  });

  it('refuse every tunnel caller with sharing_disabled while it is off, stamp or not', async () => {
    await setSwitch(false);
    try {
      for (const stamp of [serviceJwt, null]) {
        expect(await answer(await tunnel(feed(), stamp))).toBe('403 sharing_disabled');
        expect(await answer(await tunnel(`${feed()}/events:stream`, stamp))).toBe(
          '403 sharing_disabled',
        );
        expect(await answer(await tunnel(relay(), stamp, keyed()))).toBe('403 sharing_disabled');
        expect(
          await answer(
            await tunnel(`/workspaces/${board}/github/events`, stamp, {
              method: 'POST',
              ...keyed(),
              body: '{}',
            }),
          ),
        ).toBe('403 sharing_disabled');
        expect(await answer(await tunnel(imported, stamp))).toBe('403 sharing_disabled');
      }
      // A process on this machine is not external reach.
      expect(await answer(await local(feed()))).toBe('200');
      expect(await answer(await local(relay(), keyed()))).toBe('200');
    } finally {
      await setSwitch(true);
    }
  });

  it('answer exactly as before once the switch is back on', async () => {
    expect(await answer(await tunnel(feed(), serviceJwt))).toBe('200');
    expect(await answer(await tunnel(relay(), serviceJwt, keyed()))).toBe('200');
    expect(await answer(await tunnel(imported, serviceJwt))).toBe('200');
  });
});
