/**
 * The Cloudflare Access service token on the requests a session makes to its
 * board server.
 *
 * A board that moved to a project machine is behind Access, which refuses a
 * request without `cf-access-client-id` and `cf-access-client-secret` before
 * the server sees it. The bound-file sync already sends them
 * (`server/src/bound-file-sync/sync-config.ts`). This module sends the same
 * pair for the session: the full MCP child and the node relay
 * (`packages/mcp/src/access-headers.ts` re-exports it), and the plugin's
 * hooks. Each wraps the ONE fetch it hands everything else, so the REST
 * calls, the token mint, the event stream and the hook POSTs cannot differ.
 * It lives here because the hooks run from the installed plugin and can
 * import nothing from the monorepo; the MCP bundle inlines it. The compiled
 * relay does not read Keychain, so the launcher skips it when either
 * variable is set.
 *
 *   CW_ACCESS_CLIENT_ID       the service token's client id (`….access`)
 *   CW_ACCESS_SECRET_SERVICE  the Keychain service holding its secret
 *
 * Neither set: no headers, as before. One without the other is refused and
 * said once; the requests then go without, and Access answers them 403.
 * There is no plain-env secret, as there is none for the sync. The secret is
 * read from Keychain at the first request that would carry it, with a
 * timeout, so a consent dialog cannot hang a child's start or a hook's turn.
 *
 * Neither value is ever logged, thrown or returned in a tool result: every
 * message below names a variable or the Keychain service, never a value.
 *
 * Where the headers go: only to the origin of the configured base URL, and
 * only when that origin is https or loopback. A redirect is followed here,
 * hop by hop, so a hop to any other origin goes without them.
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
const ID_HEADER = 'cf-access-client-id';
const SECRET_HEADER = 'cf-access-client-secret';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
/** How long a Keychain read may take before it counts as unreadable. */
export const KEYCHAIN_TIMEOUT_MS = 10_000;

/** `security find-generic-password -s <service> -w`, as the sync reads it. */
export function readKeychainSecret(
  service: string,
  timeoutMs = KEYCHAIN_TIMEOUT_MS,
  bin = 'security',
): string {
  const r = spawnSync(bin, ['find-generic-password', '-s', service, '-w'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: timeoutMs,
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

function originOf(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Whether an origin may be sent the secret at all: https, or loopback. */
function safeOrigin(u: URL): boolean {
  return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
}

/** The request a redirect leads to, as fetch itself would make it. */
function redirected(init: RequestInit, status: number): RequestInit {
  const method = (init.method ?? 'GET').toUpperCase();
  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
    const { body: _body, ...rest } = init;
    return { ...rest, method: 'GET' };
  }
  return init;
}

/**
 * `fetch`, with the two headers on a request to `baseUrl()`'s origin and on
 * no other. `baseUrl` is asked per request, because the MCP child resolves
 * its server per request (http-client.ts); a base that cannot be resolved
 * carries nothing.
 */
export function withAccessHeaders(
  fetch: Fetch,
  token: () => AccessToken | null,
  baseUrl: () => string,
  log: (line: string) => void,
): Fetch {
  let saidPlain = false;
  const carries = (url: string): boolean => {
    let base: URL | null;
    try {
      base = originOf(baseUrl());
    } catch {
      return false;
    }
    const target = originOf(url);
    if (!base || !target || target.origin !== base.origin) return false;
    if (!safeOrigin(base)) {
      if (!saidPlain) {
        saidPlain = true;
        log('Access headers dropped: the base URL is plain http on a host that is not loopback');
      }
      return false;
    }
    return token() !== null;
  };
  const once = (init: RequestInit | undefined, carry: boolean) => {
    const headers = new Headers(init?.headers);
    const t = carry ? token() : null;
    if (t) {
      headers.set(ID_HEADER, t.clientId);
      headers.set(SECRET_HEADER, t.clientSecret);
    } else {
      headers.delete(ID_HEADER);
      headers.delete(SECRET_HEADER);
    }
    return { ...init, headers };
  };
  return async (url, init) => {
    if (!carries(url)) return fetch(url, init);
    // A caller that chose its own redirect mode gets exactly that, on one hop.
    if (init?.redirect !== undefined && init.redirect !== 'follow') {
      return fetch(url, once(init, true));
    }
    let current = url;
    let req: RequestInit = init ?? {};
    for (let hop = 0; ; hop++) {
      const res = await fetch(current, {
        ...once(req, carries(current)),
        redirect: 'manual',
      });
      const location = res.headers.get('location');
      if (!REDIRECTS.has(res.status) || !location) return res;
      if (hop >= MAX_REDIRECTS) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`more than ${MAX_REDIRECTS} redirects`);
      }
      await res.body?.cancel().catch(() => {});
      req = redirected(req, res.status);
      current = new URL(location, current).toString();
    }
  };
}

/** The fetch a child or a hook hands everything that talks to its server. */
export function serverFetch(
  env: Record<string, string | undefined>,
  fetch: Fetch,
  log: (line: string) => void,
  baseUrl: () => string,
  readSecret: SecretReader = (service) => readKeychainSecret(service),
): Fetch {
  if (!env.CW_ACCESS_CLIENT_ID?.trim() && !env.CW_ACCESS_SECRET_SERVICE?.trim()) return fetch;
  let resolved: AccessToken | null | undefined;
  const token = (): AccessToken | null => {
    if (resolved !== undefined) return resolved;
    const t = accessTokenFrom(env, readSecret);
    if (t !== null && 'error' in t) {
      log(`Access headers off: ${t.error}`);
      resolved = null;
    } else {
      if (t) log('sending the Access service token on requests to the server');
      resolved = t;
    }
    return resolved;
  };
  return withAccessHeaders(fetch, token, baseUrl, log);
}
