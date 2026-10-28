/**
 * The GitHub relay's config: the broker it reads, and each remote board it
 * pushes to.
 *
 * **The file holds no secret.** It names, per board, the Keychain service
 * that holds the board's push key (`gp1`, `auth/github-push-key.ts`) and,
 * when the board sits behind Cloudflare Access, the service token's client
 * id and the Keychain service holding its secret. The values are read from
 * the Keychain at start and live only in the process. The file is still
 * refused when anyone but its owner can WRITE it, because a changed
 * `baseUrl` would send a push key to another host.
 *
 * ```json
 * {"broker": "http://127.0.0.1:7902",
 *  "boards": {"<name>": {
 *    "baseUrl": "https://<project>-workspaces.<zone>",
 *    "workspaceId": "<the board's id on that server>",
 *    "pushKeyService": "<Keychain service holding the gp1>",
 *    "serviceToken": {"clientId": "<…>.access", "secretService": "<Keychain service>"}}}}
 * ```
 *
 * `broker` must be plain http on a loopback host: the broker answers on this
 * machine only. A board's `baseUrl` may be plain http only on a loopback
 * host (a co-located server, or a test); anything else is https. Fails
 * closed: one bad part refuses the whole file.
 */
import { readFileSync, statSync } from 'node:fs';

export interface GithubRelayBoard {
  name: string;
  /** A bare origin, no trailing slash. */
  baseUrl: string;
  workspaceId: string;
  pushKey: string;
  serviceToken: { clientId: string; clientSecret: string } | null;
}

export interface GithubRelayConfig {
  broker: string;
  boards: GithubRelayBoard[];
}

/** Reads one Keychain service's value, or throws naming the service only. */
export type SecretReader = (service: string) => string;

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SERVICE = /^[A-Za-z0-9._-]{1,128}$/;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,256}$/;
const PUSH_KEY = /^gp1\.[A-Za-z0-9._-]{1,512}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function origin(raw: unknown, what: string, loopbackOnly: boolean): string {
  if (typeof raw !== 'string') throw new Error(`${what} must be a URL`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${what} is not a URL`);
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(`${what} must be a bare origin`);
  }
  const loopback = LOOPBACK.has(url.hostname);
  if (loopbackOnly && !(loopback && url.protocol === 'http:')) {
    throw new Error(`${what} must be http on a loopback host`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${what} must be https unless it is on a loopback host`);
  }
  return url.origin;
}

/** The config from its JSON text, with each secret read through `secret`. */
export function parseGithubRelayConfig(
  text: string,
  secret: SecretReader,
): GithubRelayConfig | { error: string } {
  try {
    const raw = JSON.parse(text) as { broker?: unknown; boards?: unknown };
    const broker = origin(raw.broker ?? 'http://127.0.0.1:7902', 'broker', true);
    if (!raw.boards || typeof raw.boards !== 'object' || Array.isArray(raw.boards)) {
      throw new Error('boards must be an object of name → board');
    }
    const boards: GithubRelayBoard[] = [];
    for (const [name, b] of Object.entries(raw.boards as Record<string, unknown>)) {
      if (!NAME.test(name))
        throw new Error(`board name "${name.slice(0, 64)}" is not [A-Za-z0-9_-]`);
      const r = (b ?? {}) as Record<string, unknown>;
      const baseUrl = origin(r.baseUrl, `${name}.baseUrl`, false);
      if (typeof r.workspaceId !== 'string' || !BOARD_ID.test(r.workspaceId)) {
        throw new Error(`${name}.workspaceId is not a board id`);
      }
      if (typeof r.pushKeyService !== 'string' || !SERVICE.test(r.pushKeyService)) {
        throw new Error(`${name}.pushKeyService must name a Keychain service`);
      }
      const pushKey = secret(r.pushKeyService).trim();
      if (!PUSH_KEY.test(pushKey)) {
        throw new Error(`${name}: the Keychain entry ${r.pushKeyService} is not a gp1 push key`);
      }
      let serviceToken: GithubRelayBoard['serviceToken'] = null;
      if (r.serviceToken !== undefined) {
        const t = (r.serviceToken ?? {}) as Record<string, unknown>;
        if (typeof t.clientId !== 'string' || !CLIENT_ID.test(t.clientId)) {
          throw new Error(`${name}.serviceToken.clientId is not a client id`);
        }
        if (typeof t.secretService !== 'string' || !SERVICE.test(t.secretService)) {
          throw new Error(`${name}.serviceToken.secretService must name a Keychain service`);
        }
        serviceToken = { clientId: t.clientId, clientSecret: secret(t.secretService).trim() };
      } else if (!baseUrl.startsWith('http://')) {
        throw new Error(`${name} is not on loopback, so it needs a serviceToken`);
      }
      boards.push({ name, baseUrl, workspaceId: r.workspaceId, pushKey, serviceToken });
    }
    return { broker, boards };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read and parse the file, refusing one that anyone but its owner can write. */
export function loadGithubRelayConfig(
  path: string,
  secret: SecretReader,
): GithubRelayConfig | { error: string } {
  let text: string;
  try {
    if ((statSync(path).mode & 0o022) !== 0) {
      return { error: `${path} is writable by group or others; chmod 600 it` };
    }
    text = readFileSync(path, 'utf8');
  } catch {
    return { error: `cannot read ${path}` };
  }
  return parseGithubRelayConfig(text, secret);
}
