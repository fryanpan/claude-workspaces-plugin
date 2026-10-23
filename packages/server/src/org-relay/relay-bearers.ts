/**
 * Keeping the relay's board tokens alive.
 *
 * Each `at2` the relay holds expires (`auth/board-agent-token.ts`, seven
 * days), and nobody on the project server's machine should have to mint a new
 * one by hand. So before a pass the relay renews every token with less than
 * half its life left, or with no expiry at all (a value minted before the
 * expiry existed), by presenting it to `POST /api/board-tokens/refresh` on its
 * own server. A revoked token renews nothing, so revocation still ends it.
 *
 * Renewed values are written to `bearers.json` in the relay's state directory
 * (mode 600; the directory is the relay's own and the leads cannot write it),
 * because the config file is what a person edits and the relay never writes
 * it. Each saved value records a hash of the config value it was renewed
 * from. At start a saved value wins only while the config still holds that
 * same value, so a restart after a renewal does not fall back to the expired
 * value in the config, and a person who puts a new token in the config gets
 * that token even when the saved one expires later.
 *
 * The expiry is read from the token's own last dot-field before the MAC. The
 * relay trusts it only to decide WHEN to ask; the server decides whether the
 * token still stands.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RelayFetch } from './relay-client.ts';
import type { RelayConfig, RelayServer } from './relay-config.ts';

const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN = /^at2\.[A-Za-z0-9._-]{1,512}$/;

/** ms epoch the token says it expires at, or null when it carries none. */
export function bearerExpiresAt(token: string): number | null {
  const fields = token.split('.');
  // at2 . id . agent . board [. expiresAt] . mac
  if (fields.length !== 6) return null;
  const raw = fields[4] ?? '';
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

/** Whether to renew now: no expiry, or less than half of `ttlMs` left. */
export function refreshDue(token: string, ttlMs: number, now: number): boolean {
  const expiresAt = bearerExpiresAt(token);
  return expiresAt === null || expiresAt - now < ttlMs / 2;
}

export function bearersPath(stateDir: string): string {
  return join(stateDir, 'bearers.json');
}

/** A renewed value, and a hash of the config value it was renewed from. */
interface SavedBearer {
  value: string;
  from: string;
}
/** A bare string is the shape written before `from` existed. */
type Saved = Record<string, Record<string, SavedBearer | string>>;

function readSaved(path: string): Saved {
  try {
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Saved) : {};
  } catch {
    return {};
  }
}

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Each server's bearers as the config gave them, before any renewal. */
const configValues = new WeakMap<RelayServer, Map<string, string>>();

function configValuesOf(server: RelayServer): Map<string, string> {
  let values = configValues.get(server);
  if (!values) {
    values = new Map(server.bearers);
    configValues.set(server, values);
  }
  return values;
}

/**
 * Put each saved value over the config's when it was renewed from the value
 * the config holds now. A saved value for a server or board the config no
 * longer names is ignored: the config decides what the relay reaches. A value
 * saved before `from` existed falls back to the older rule, the later expiry,
 * and its next save records `from`.
 */
export function applySavedBearers(config: RelayConfig, stateDir: string): void {
  const saved = readSaved(bearersPath(stateDir));
  for (const server of config.servers.values()) {
    configValuesOf(server);
    const boards = saved[server.id];
    if (!boards || typeof boards !== 'object') continue;
    for (const [board, entry] of Object.entries(boards)) {
      const current = server.bearers.get(board);
      if (current === undefined) continue;
      const value = typeof entry === 'string' ? entry : entry?.value;
      if (typeof value !== 'string' || !TOKEN.test(value)) continue;
      const wins =
        typeof entry === 'string'
          ? (bearerExpiresAt(value) ?? 0) > (bearerExpiresAt(current) ?? 0)
          : entry.from === hashOf(current);
      if (wins) server.bearers.set(board, value);
    }
  }
}

function save(config: RelayConfig, stateDir: string): void {
  const out: Saved = {};
  for (const server of config.servers.values()) {
    const from = configValuesOf(server);
    out[server.id] = Object.fromEntries(
      [...server.bearers].map(([board, value]) => [
        board,
        { value, from: hashOf(from.get(board) ?? value) },
      ]),
    );
  }
  const path = bearersPath(stateDir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

async function renewOne(
  fetchFn: RelayFetch,
  server: RelayServer,
  token: string,
): Promise<string | null> {
  try {
    const res = await fetchFn(`${server.baseUrl}/api/board-tokens/refresh`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(server.serviceToken
          ? {
              'cf-access-client-id': server.serviceToken.clientId,
              'cf-access-client-secret': server.serviceToken.clientSecret,
            }
          : {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: unknown };
    return typeof body.token === 'string' && TOKEN.test(body.token) ? body.token : null;
  } catch {
    return null;
  }
}

export interface BearerKeeperOptions {
  fetch: RelayFetch;
  config: RelayConfig;
  /** Where renewed values are kept, or null to keep them in memory only. */
  stateDir: string | null;
  ttlMs: number;
  now: () => number;
  log: (line: string) => void;
}

/** After a refused renewal, how long before the relay asks again. */
const RETRY_AFTER_MS = 60_000;

/**
 * `run` renews every token that is due and answers how many it renewed. A
 * board whose renewal failed is asked again a minute later rather than on
 * every pass, and is logged once until it succeeds.
 */
export function createBearerKeeper(opts: BearerKeeperOptions): { run(): Promise<number> } {
  const retryAt = new Map<string, number>();
  for (const server of opts.config.servers.values()) configValuesOf(server);
  return {
    async run() {
      let renewed = 0;
      for (const server of opts.config.servers.values()) {
        for (const [board, token] of server.bearers) {
          const key = `${server.id}/${board}`;
          if (!refreshDue(token, opts.ttlMs, opts.now())) continue;
          if ((retryAt.get(key) ?? 0) > opts.now()) continue;
          const fresh = await renewOne(opts.fetch, server, token);
          if (!fresh) {
            if (!retryAt.has(key)) opts.log(`[relay] could not renew the board token for ${key}`);
            retryAt.set(key, opts.now() + RETRY_AFTER_MS);
            continue;
          }
          retryAt.delete(key);
          server.bearers.set(board, fresh);
          renewed++;
        }
      }
      if (renewed > 0 && opts.stateDir) save(opts.config, opts.stateDir);
      return renewed;
    },
  };
}
