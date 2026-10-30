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
 * A failed read is tried again after RETRY_AFTER_MS; only a success is kept.
 *
 * Neither value is ever logged, thrown or returned in a tool result: every
 * message below names a variable or the Keychain service, never a value.
 *
 * Where the headers go: only to the origin of the configured base URL, and
 * only when that origin is https or loopback. A redirect is followed here,
 * hop by hop, so a hop to any other origin goes without them, and without
 * the caller's `authorization`, `cookie` and `proxy-authorization`.
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
/** What native fetch strips on a redirect to another origin, plus the pair. */
const CREDENTIAL_HEADERS = [
  'authorization',
  'cookie',
  'proxy-authorization',
  ID_HEADER,
  SECRET_HEADER,
];
/** How long a failed read waits before the next request tries again. */
export const RETRY_AFTER_MS = 60_000;
const MAX_REDIRECTS = 5;
/** How long a Keychain read may take before it counts as unreadable. */
export const KEYCHAIN_TIMEOUT_MS = 10_000;

/** Why a Keychain read failed. Carries the service name, never a value. */
export class KeychainReadError extends Error {
  constructor(
    readonly kind: 'missing' | 'timed-out',
    service: string,
  ) {
    super(
      kind === 'timed-out'
        ? `the Keychain read for the service ${service} timed out or was killed`
        : `no Keychain entry for the service ${service}`,
    );
  }
}

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
  // A timeout kills the read: no status, a signal, and ETIMEDOUT on r.error.
  const code = (r.error as { code?: unknown } | undefined)?.code;
  if (r.signal !== null || code === 'ETIMEDOUT') throw new KeychainReadError('timed-out', service);
  if (r.status !== 0) throw new KeychainReadError('missing', service);
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
  } catch (e) {
    // Only this module's own errors are worded; an injected reader's message
    // is never repeated, since it could hold anything.
    if (e instanceof KeychainReadError && e.kind === 'timed-out') {
      return { error: `the Keychain service ${service} timed out` };
    }
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
  /** One hop's request. Off the start origin it carries no credential at all,
   *  the caller's bearer and cookies included, as native fetch would do. */
  const once = (init: RequestInit | undefined, sameOrigin: boolean) => {
    const headers = new Headers(init?.headers);
    const t = sameOrigin ? token() : null;
    if (!sameOrigin) {
      for (const h of CREDENTIAL_HEADERS) headers.delete(h);
    } else if (t) {
      headers.set(ID_HEADER, t.clientId);
      headers.set(SECRET_HEADER, t.clientSecret);
    }
    return { ...init, headers };
  };
  return async (url, init) => {
    if (!carries(url)) return fetch(url, init);
    // A caller that chose its own redirect mode gets exactly that, on one hop.
    if (init?.redirect !== undefined && init.redirect !== 'follow') {
      return fetch(url, once(init, true));
    }
    const start = new URL(url).origin;
    let current = url;
    let req: RequestInit = init ?? {};
    for (let hop = 0; ; hop++) {
      const res = await fetch(current, {
        ...once(req, new URL(current).origin === start),
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
  now: () => number = Date.now,
): Fetch {
  if (!env.CW_ACCESS_CLIENT_ID?.trim() && !env.CW_ACCESS_SECRET_SERVICE?.trim()) return fetch;
  // Only a token is kept. A failure (a dialog nobody answered, a locked
  // Keychain) is tried again once RETRY_AFTER_MS has passed, and each kind
  // of failure is said once rather than at every retry.
  let held: AccessToken | null = null;
  let retryAt = 0;
  const said = new Set<string>();
  const token = (): AccessToken | null => {
    if (held || now() < retryAt) return held;
    const t = accessTokenFrom(env, readSecret);
    if (t === null) return null;
    if ('error' in t) {
      retryAt = now() + RETRY_AFTER_MS;
      if (!said.has(t.error)) {
        said.add(t.error);
        log(`Access headers off: ${t.error}`);
      }
      return null;
    }
    log('sending the Access service token on requests to the server');
    held = t;
    return held;
  };
  return withAccessHeaders(fetch, token, baseUrl, log);
}
