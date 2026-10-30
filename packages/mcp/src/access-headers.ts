/**
 * The Cloudflare Access service token on every request this process makes
 * to the server.
 *
 * A board that moved to a project machine is behind Access, which refuses a
 * request without `cf-access-client-id` and `cf-access-client-secret` before
 * the server sees it. The bound-file sync already sends them
 * (`server/src/bound-file-sync/sync-config.ts`); this is the same pair for
 * the session's own child, the full child and the node relay alike. Each
 * wraps the ONE fetch it hands everything else, so the REST calls, the token
 * mint and the event stream cannot differ. The compiled relay does not read
 * Keychain, so the launcher skips it when `CW_ACCESS_CLIENT_ID` is set.
 *
 *   CW_ACCESS_CLIENT_ID       the service token's client id (`….access`)
 *   CW_ACCESS_SECRET_SERVICE  the Keychain service holding its secret
 *
 * Neither set: no headers, as before. One without the other is refused and
 * said once; the requests then go without, and Access answers them 403.
 * There is no plain-env secret, as there is none for the sync: the secret
 * lives in Keychain, read once at start.
 *
 * Neither value is ever logged, thrown or returned in a tool result: every
 * message below names the variable, never what it holds. The headers go only
 * to an https origin or to loopback, so a misconfigured `CW_BASE_URL` cannot
 * send the secret in clear across a network.
 */
import { spawnSync } from 'node:child_process';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The secret stored under one Keychain service; throws when it cannot. */
export type SecretReader = (service: string) => string;

export interface AccessToken {
  clientId: string;
  clientSecret: string;
}

const CLIENT_ID = /^[A-Za-z0-9._-]{1,256}\.access$/;
const SERVICE = /^[A-Za-z0-9._-]{1,128}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** `security find-generic-password -s <service> -w`, as the sync reads it. */
export function readKeychainSecret(service: string): string {
  const r = spawnSync('security', ['find-generic-password', '-s', service, '-w'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.status !== 0) throw new Error(`no Keychain entry for the service ${service}`);
  return r.stdout.trim();
}

/** The token the environment names, `null` when it names none, or why not. */
export function accessTokenFrom(
  env: Record<string, string | undefined>,
  readSecret: SecretReader,
): AccessToken | null | { error: string } {
  const clientId = env.CW_ACCESS_CLIENT_ID?.trim() ?? '';
  const service = env.CW_ACCESS_SECRET_SERVICE?.trim() ?? '';
  if (!clientId && !service) return null;
  if (!clientId) return { error: 'CW_ACCESS_SECRET_SERVICE is set without CW_ACCESS_CLIENT_ID' };
  if (!service) return { error: 'CW_ACCESS_CLIENT_ID is set without CW_ACCESS_SECRET_SERVICE' };
  if (!CLIENT_ID.test(clientId)) return { error: 'CW_ACCESS_CLIENT_ID is not an Access client id' };
  if (!SERVICE.test(service)) {
    return { error: 'CW_ACCESS_SECRET_SERVICE must name a Keychain service' };
  }
  let clientSecret: string;
  try {
    clientSecret = readSecret(service).trim();
  } catch {
    return { error: `the Keychain service ${service} could not be read` };
  }
  if (!clientSecret) return { error: `the Keychain service ${service} holds an empty value` };
  return { clientId, clientSecret };
}

function reachesAccess(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
  } catch {
    return false;
  }
}

/** `fetch`, with the token's two headers on every request it may carry them on. */
export function withAccessHeaders(fetch: Fetch, token: AccessToken | null): Fetch {
  if (!token) return fetch;
  return (url, init) => {
    if (!reachesAccess(url)) return fetch(url, init);
    const headers = new Headers(init?.headers);
    headers.set('cf-access-client-id', token.clientId);
    headers.set('cf-access-client-secret', token.clientSecret);
    return fetch(url, { ...init, headers });
  };
}

/** The fetch a child hands everything that talks to the server. */
export function serverFetch(
  env: Record<string, string | undefined>,
  fetch: Fetch,
  log: (line: string) => void,
  readSecret: SecretReader = readKeychainSecret,
): Fetch {
  const token = accessTokenFrom(env, readSecret);
  if (token === null) return fetch;
  if ('error' in token) {
    log(`Access headers off: ${token.error}`);
    return fetch;
  }
  log('sending the Access service token on every request to the server');
  return withAccessHeaders(fetch, token);
}
