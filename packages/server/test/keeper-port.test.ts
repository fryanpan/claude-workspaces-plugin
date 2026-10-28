/**
 * The keeper's port is chosen once, at install, at random, and kept in its
 * store, so a page or worker planted on `localhost` before install has no
 * port to be planted on.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEEPER_PORTS, chooseKeeperPort, keeperPort } from '../src/keeper/keeper-port.ts';
import { openKeeperStore } from '../src/keeper/keeper-store.ts';

const tmp = mkdtempSync(join(tmpdir(), 'keeper-port-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const openStore = () => {
  const s = openKeeperStore(mkdtempSync(join(tmp, `s${n++}-`)));
  if ('error' in s) throw new Error(s.error);
  return s;
};

describe('keeper port', () => {
  it('chooses a port in the range that is free, skipping taken ones', () => {
    const tried: number[] = [];
    const draws = [0, 1, 2];
    const port = chooseKeeperPort(
      (p) => {
        tried.push(p);
        return tried.length === 3;
      },
      () => draws.shift() ?? 0,
    );
    expect(tried).toEqual([KEEPER_PORTS.min, KEEPER_PORTS.min + 1, KEEPER_PORTS.min + 2]);
    expect(port).toBe(KEEPER_PORTS.min + 2);
  });

  it('gives up rather than loop when nothing is free', () => {
    expect(() => chooseKeeperPort(() => false)).toThrow('no free port');
  });

  it('is chosen once, saved mode 600 in the store, and read back after', () => {
    const store = openStore();
    const first = keeperPort(store, {});
    expect(first).toBeGreaterThanOrEqual(KEEPER_PORTS.min);
    expect(first).toBeLessThanOrEqual(KEEPER_PORTS.max);
    expect(statSync(join(store.dir, 'config.json')).mode & 0o777).toBe(0o600);
    expect(keeperPort(store, {})).toBe(first);
    // A new store chooses again, so the port is not a constant an agent knows.
    const others = new Set([first, keeperPort(openStore(), {}), keeperPort(openStore(), {})]);
    expect(others.size).toBeGreaterThan(1);
  });

  it('CW_KEEPER_PORT wins, for tests, and saves nothing', () => {
    const store = openStore();
    expect(keeperPort(store, { CW_KEEPER_PORT: '18797' })).toBe(18797);
    expect(store.port()).toBeNull();
  });
});
