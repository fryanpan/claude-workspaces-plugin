/**
 * A real server behind a Cloudflare Access fixture, with the three callers
 * the access rules tell apart: an agent on loopback (no proof), the owner's
 * own browser on the owner hostname (Access proves the owner email, the
 * browser says same-origin), and a share visitor on the share hostname.
 *
 * Lifted from `task-grants-door.test.ts`'s setup, which proves the owner the
 * way prod does. Every name and address is invented; the repo is public.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'share-proof-kid';
const SHARE_AUD = 'aud-share-app';
const OWNER_AUD = 'aud-owner-app';
export const SHARE_HOST = 'share.harborlight.test';
export const OWNER_HOST = 'workspaces.harborlight.test';
export const OWNER_EMAIL = 'owner@harborlight.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

/** What the board's own page sends with a press of a button. */
export const SAME_ORIGIN = { origin: `https://${OWNER_HOST}`, 'sec-fetch-site': 'same-origin' };

export const AGENT = { id: 'agent-riverbend', name: 'Riverbend Bot', kind: 'agent' as const };

export interface ShareProofServer {
  handle: ServerHandle;
  board: string;
  /** `/workspaces/<board>`. */
  scope: string;
  /** An agent, or anything else on this machine: loopback, no proof. */
  local: (path: string, init?: RequestInit) => Promise<Response>;
  /** The owner's own browser. `browser` replaces the same-origin headers. */
  owner: (path: string, init?: RequestInit, browser?: Record<string, string>) => Promise<Response>;
  /** A share visitor holding a token from the share application. */
  visitor: (email: string, path: string, init?: RequestInit) => Promise<Response>;
  /** Mint a link as an agent and redeem it as `email`; the redeem's status. */
  join: (email: string) => Promise<number>;
  stop: () => Promise<void>;
}

export const post = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * `legacyMint` leaves the share hostname out, which is the one deployment
 * where `POST /api/share/link` still mints a per-share Access application.
 */
export async function startShareProofServer(
  name: string,
  opts: { legacyMint?: boolean } = {},
): Promise<ShareProofServer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const jwks: JSONWebKeySet = { keys: [publicJwk] };
  const signJwt = (aud: string, email: string) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-share-proof')
      .sign(privateKey);

  const root = mkdtempSync(join(tmpdir(), 'share-proof-'));
  const handle = createServer({
    port: 0,
    dataDir: join(root, 'data'),
    cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
    ...(opts.legacyMint ? {} : { shareLinkHosts: [SHARE_HOST], shareLinkAudience: SHARE_AUD }),
    proxiedTrustedHosts: [OWNER_HOST],
    proxiedTrustedEmails: [OWNER_EMAIL],
    ownerEmail: OWNER_EMAIL,
    share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
  });
  const base = `http://127.0.0.1:${handle.port}`;
  const req = (path: string, host: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
    });
  const local = (path: string, init: RequestInit = {}) =>
    req(path, `localhost:${handle.port}`, init);
  const owner = async (
    path: string,
    init: RequestInit = {},
    browser: Record<string, string> = SAME_ORIGIN,
  ) =>
    req(path, OWNER_HOST, {
      ...init,
      headers: {
        ...((init.headers as Record<string, string>) ?? {}),
        ...CF_RAY,
        'x-forwarded-proto': 'https',
        'cf-access-jwt-assertion': await signJwt(OWNER_AUD, OWNER_EMAIL),
        ...browser,
      },
    });
  const visitor = async (email: string, path: string, init: RequestInit = {}) =>
    req(path, SHARE_HOST, {
      ...init,
      headers: {
        ...((init.headers as Record<string, string>) ?? {}),
        ...CF_RAY,
        'cf-access-jwt-assertion': await signJwt(SHARE_AUD, email),
      },
    });

  const made = await readJson<{ workspace: { id: string } }>(
    await local('/workspaces', post({ name }, 'POST')),
  );
  const board = made.workspace.id;
  const scope = `/workspaces/${encodeURIComponent(board)}`;
  const joinBoard = async (email: string): Promise<number> => {
    const link = await readJson<{ link: { linkId: string } }>(
      await local('/api/share/workspace', post({ workspaceId: board })),
    );
    return (await visitor(email, `/s/${link.link.linkId}`)).status;
  };
  return {
    handle,
    board,
    scope,
    local,
    owner,
    visitor,
    join: joinBoard,
    stop: async () => {
      await handle.stop();
      rmSync(root, { recursive: true, force: true });
      resetOwnerIdentities();
    },
  };
}
