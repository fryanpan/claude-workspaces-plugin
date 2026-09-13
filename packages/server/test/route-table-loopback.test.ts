/**
 * The route table's `loopback-only` and `trusted-local` rows, checked against
 * the server rather than read off it.
 *
 * `route-table.test.ts` checks the gate column against `shareScopeAllows`,
 * which answers one question: can a share visitor reach this address? Both of
 * these gates answer no to that, so that test cannot tell them apart, and a
 * row filed under the wrong one passed it. Six had been: the deploy POST, the
 * agent token, the agent watch set (both verbs) and the agent event stream
 * were filed `trusted-local`, the push key was filed `loopback-only`, and the
 * plugin refresh listed only its read.
 *
 * A `loopback-only` route makes two refusals, and this file checks both.
 *
 * - **The peer address.** Every `trusted-local` and `loopback-only` row is
 *   dialled twice over real sockets, from this machine's loopback address and
 *   from one of its non-loopback addresses, with the same `Host` and body. A
 *   `loopback-only` route refuses the off-box caller and not the on-box one;
 *   a `trusted-local` route does not. That server runs with
 *   `accessOnlyBrowserHosts: false` and the dialled address listed as a
 *   trusted host, the only configuration in which the difference is
 *   reachable: with the default on, the host guard refuses a non-loopback
 *   peer before any route runs.
 * - **The edge.** cloudflared runs on this box, so a tunnelled request has a
 *   loopback peer and passes the address check. Only `cf-ray` says it crossed
 *   the edge. Every `loopback-only` row is also called as the operator
 *   through the tunnel (their Access-fronted hostname, a valid Access token,
 *   `cf-ray`) and must be refused. The same call without the hop must not be.
 *   The fixture is `deploy-proxied.test.ts`'s, because the operator's
 *   hostname is the only one a proxied request is admitted on. On any other,
 *   the host guard refuses it and the route is never tested.
 *
 * Every probe asserts the host guard let it through (`unknown_host` is its
 * refusal), so a refusal counted here is the route's.
 *
 * What it cannot see: the example ids name no real board, doc or task, so a
 * handler that looks something up before it checks the caller answers 404 to
 * every caller and reads `trusted-local`. Every address and edge check in the
 * server today runs before its lookups.
 *
 * Fake deployer and refresher: nothing here may pull, restart or update a
 * plugin cache.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { Deployer } from '../src/deploy.ts';
import { PluginRefresher } from '../src/plugin-refresh.ts';
import { ROUTE_TABLE } from '../src/routes/route-table-rows.ts';
import { type ServerHandle, type ServerOptions, createServer } from '../src/server.ts';

/** This machine's first non-loopback IPv4 address, if it has one. */
const offBoxAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

const ADDRESS_GATES = new Set(['trusted-local', 'loopback-only']);

interface Answer {
  status: number;
  error: string | undefined;
}

/** A deployer and refresher that record nothing and touch nothing. */
const fakeOps = (): Pick<ServerOptions, 'deployer' | 'pluginRefresher'> => ({
  deployer: new Deployer({
    run: async () => ({
      ok: true,
      status: 'deployed',
      changed: false,
      before: 'aaaaaaa',
      after: 'aaaaaaa',
      behind: 0,
      ahead: 0,
      message: 'fixture deploy',
      ranAt: 1,
      restartRequested: false,
    }),
    now: () => 1,
  }),
  pluginRefresher: new PluginRefresher({
    run: async () => ({
      ok: true,
      before: '0.0.1',
      after: '0.0.1',
      changed: false,
      message: 'fixture refresh',
      ranAt: 1,
    }),
    minIntervalMs: 0,
  }),
});

/** One call, reduced to what a gate decides. */
async function call(url: string, method: string, headers: Record<string, string>): Promise<Answer> {
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const res = await fetch(url, {
    method,
    redirect: 'manual',
    headers: { ...headers, ...(hasBody ? { 'content-type': 'application/json' } : {}) },
    ...(hasBody ? { body: '{}' } : {}),
  });
  let error: string | undefined;
  // A stream route answers 200 and never ends; only a refusal is read.
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    error = body?.error;
  } else {
    await res.body?.cancel();
  }
  return { status: res.status, error };
}

/**
 * Skipped when there is no non-loopback IPv4 to dial from (a sandboxed
 * container), because a probe that silently dials loopback twice would pass
 * every `trusted-local` row and fail every `loopback-only` one for a reason
 * that has nothing to do with the table.
 */
describe.if(Boolean(offBoxAddress))(
  'every address-gated row checks the peer address as filed',
  () => {
    let handle: ServerHandle;
    let dataDir: string;

    beforeAll(() => {
      dataDir = mkdtempSync(join(tmpdir(), 'route-table-loopback-'));
      handle = createServer({
        port: 0,
        // Every interface, as prod binds, so the off-box address can dial it.
        hostname: '::',
        dataDir,
        trustedHosts: [offBoxAddress as string],
        accessOnlyBrowserHosts: false,
        ...fakeOps(),
      });
    });

    afterAll(async () => {
      await handle.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    const from = (address: string, path: string, method: string): Promise<Answer> =>
      call(`http://${address}:${handle.port}${path}`, method, { host: `localhost:${handle.port}` });

    for (const entry of ROUTE_TABLE) {
      if (!ADDRESS_GATES.has(entry.gate)) continue;
      for (const method of entry.methods) {
        it(`${method} ${entry.pattern} — ${entry.gate}`, async () => {
          const offBox = await from(offBoxAddress as string, entry.example, method);
          const onBox = await from('127.0.0.1', entry.example, method);
          expect(offBox.error, 'the host guard refused the off-box probe').not.toBe('unknown_host');
          expect(onBox.error, 'the host guard refused the on-box probe').not.toBe('unknown_host');
          const refusedOffBoxOnly = offBox.status === 403 && onBox.status !== 403;
          expect(
            { refusedOffBoxOnly, offBox, onBox },
            `${method} ${entry.pattern} is filed ${entry.gate}`,
          ).toMatchObject({ refusedOffBoxOnly: entry.gate === 'loopback-only' });
        });
      }
    }

    it('reaches a trusted-local route from the off-box address (positive control)', async () => {
      const res = await fetch(`http://${offBoxAddress}:${handle.port}/workspaces`, {
        headers: { host: `localhost:${handle.port}` },
      });
      expect(res.status).toBe(200);
    });
  },
);

describe('every loopback-only row refuses a request through the edge', () => {
  const TEAM_DOMAIN = 'test.cloudflareaccess.com';
  const KID = 'route-table-edge-kid';
  const OPERATOR_AUD = 'aud-for-the-operator-app';
  const PROXIED_HOST = 'operator.example.com';
  const OPERATOR_EMAIL = 'operator@example.com';

  let handle: ServerHandle;
  let dataDir: string;
  let jwt: string;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const publicJwk = (await exportJWK(publicKey)) as JWK;
    publicJwk.kid = KID;
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    jwt = await new SignJWT({ email: OPERATOR_EMAIL })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(OPERATOR_AUD)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-operator-1')
      .sign(privateKey);
    dataDir = mkdtempSync(join(tmpdir(), 'route-table-edge-'));
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OPERATOR_AUD, jwks: { keys: [publicJwk] } },
      // With `shares` wired, Access gates only known hostnames and loopback
      // stays open, which is prod's shape (see deploy-proxied.test.ts).
      share: { config: { publicHostname: 'links.example.com' } },
      proxiedTrustedHosts: [PROXIED_HOST],
      proxiedTrustedEmails: [OPERATOR_EMAIL],
      ...fakeOps(),
    });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** The operator, through the tunnel: a loopback peer carrying the hop. */
  const viaEdge = (path: string, method: string): Promise<Answer> =>
    call(`http://127.0.0.1:${handle.port}${path}`, method, {
      host: PROXIED_HOST,
      'cf-ray': '8a1b2c3d4e5f-SJC',
      'cf-access-jwt-assertion': jwt,
    });
  const fromBox = (path: string, method: string): Promise<Answer> =>
    call(`http://127.0.0.1:${handle.port}${path}`, method, { host: `localhost:${handle.port}` });

  for (const entry of ROUTE_TABLE) {
    if (entry.gate !== 'loopback-only') continue;
    for (const method of entry.methods) {
      it(`${method} ${entry.pattern}`, async () => {
        const edge = await viaEdge(entry.example, method);
        const box = await fromBox(entry.example, method);
        expect(edge.error, 'the host guard refused the edge probe').not.toBe('unknown_host');
        // The refusal has to be the edge veto's, not any 403: every one of
        // them names the hop (`agent-stream-proxied`, "through the edge").
        expect({ edge, box }, `${method} ${entry.pattern} through the edge`).toMatchObject({
          edge: { status: 403, error: expect.stringMatching(/edge|proxied/i) },
        });
        expect(box.status, `${method} ${entry.pattern} from the box`).not.toBe(403);
      });
    }
  }

  it('reaches a trusted-local route through the edge (positive control)', async () => {
    const res = await viaEdge('/api/deploy', 'GET');
    expect(res.status).toBe(200);
  });
});
