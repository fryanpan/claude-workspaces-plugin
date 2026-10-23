/**
 * The keeper's loopback port, chosen once at install and kept in its store.
 *
 * The approval page's origin is `http://localhost:<port>`. A browser keeps a
 * service worker or a cached page per origin, so an agent that could serve
 * on that origin before the keeper's port job held it could leave one there
 * to show one request while the tap approves another. A fixed port tells the
 * agent which origin to plant on. A port drawn at random from 41,000 at
 * install, and written only into the keeper's mode-700 store and the two
 * root-owned plists, does not: a plant made before install has to guess.
 */
import { randomInt } from 'node:crypto';
import type { KeeperStore } from './keeper-store.ts';

/** The range a port is drawn from: above the usual dev servers, below the ephemeral range. */
export const KEEPER_PORTS = { min: 20000, max: 60999 };
const TRIES = 50;

/** Whether `port` can be bound on both loopback addresses right now. */
export function portIsFree(port: number): boolean {
  for (const hostname of ['127.0.0.1', '::1']) {
    try {
      Bun.listen({ hostname, port, socket: { data() {} } }).stop(true);
    } catch {
      return false;
    }
  }
  return true;
}

/** A random port in `KEEPER_PORTS` that `isFree` accepts. */
export function chooseKeeperPort(
  isFree: (port: number) => boolean = portIsFree,
  draw: (span: number) => number = (span) => randomInt(span),
): number {
  const span = KEEPER_PORTS.max - KEEPER_PORTS.min + 1;
  for (let i = 0; i < TRIES; i++) {
    const port = KEEPER_PORTS.min + draw(span);
    if (isFree(port)) return port;
  }
  throw new Error(`no free port found in ${TRIES} tries`);
}

/**
 * The port the keeper and its plists use: `CW_KEEPER_PORT` when set (tests),
 * else the one in the store, else a new one, saved.
 */
export function keeperPort(
  store: KeeperStore,
  env: Record<string, string | undefined>,
  choose: () => number = chooseKeeperPort,
): number {
  const set = Number(env.CW_KEEPER_PORT);
  if (Number.isInteger(set) && set > 0 && set < 65536) return set;
  const saved = store.port();
  if (saved !== null) return saved;
  const port = choose();
  store.savePort(port);
  return port;
}
