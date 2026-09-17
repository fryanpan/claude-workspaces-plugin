/**
 * The supervisor's memory: how often it may restart, what the ledger carries
 * from one process to the next, and what a never-bound restart buys the boot
 * after it.
 *
 * The watchdog that consults all three is `supervisor-health.test.ts`. These
 * are the pieces, driven on their own so a failure names which one moved.
 *
 * Fixtures are synthetic timestamps; nothing here reads a wall clock.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  FIRST_BIND_GRACE_MAX_MS,
  FIRST_BIND_GRACE_MS,
  fileRestartLedger,
  firstBindGraceFor,
  restartDecision,
} from '../src/supervisor-restarts.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/**
 * A ledger path one level BELOW a directory that exists — the `nested`
 * segment is the coverage, not tidiness. `restartLedgerPath` puts the ledger
 * directly in the data dir, and the case where that parent is missing is a
 * first boot against a fresh `CW_DATA_DIR`: `bun run staging`, and a new prod
 * install. If `fileRestartLedger`'s `mkdirSync` were ever dropped, that boot's
 * first restart would fail to record itself, the catch would log "restarting
 * anyway", and the 3-per-hour limiter would never accumulate — on the box
 * where it matters most. Writing into the mkdtemp dir directly makes that
 * `mkdirSync` a no-op in every case and the regression invisible.
 */
function tempLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'restart-ledger-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'nested', 'supervisor-restarts.json');
}

/**
 * Plant a ledger file by hand, for the cases whose subject is what the LOADER
 * makes of a given file's bytes. They are the cases that cannot go through
 * `save`, so they create the parent themselves rather than borrowing the
 * `mkdirSync` the save path is here to exercise.
 */
function plantLedger(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

const MIN = 60_000;
const POLICY = { max: 3, windowMs: 60 * MIN };

describe('restartDecision: at most `max` restarts in any window', () => {
  it('allows three in an hour and refuses the fourth until the first ages out', () => {
    let history: number[] = [];
    for (const t of [0, 2 * MIN, 4 * MIN]) {
      const d = restartDecision(history, t, POLICY);
      if (!d.allowed) throw new Error(`restart at ${t} refused`);
      history = d.history;
    }
    expect(restartDecision(history, 6 * MIN, POLICY)).toEqual({
      allowed: false,
      recent: 3,
      retryAt: 60 * MIN,
    });
    expect(restartDecision(history, 60 * MIN - 1, POLICY).allowed).toBe(false);
    expect(restartDecision(history, 60 * MIN, POLICY)).toEqual({
      allowed: true,
      history: [2 * MIN, 4 * MIN, 60 * MIN],
    });
  });

  it('does not trust a timestamp from the future (a clock that stepped back)', () => {
    const d = restartDecision([10 * MIN, 11 * MIN, 12 * MIN], 5 * MIN, POLICY);
    expect(d).toEqual({ allowed: true, history: [5 * MIN] });
  });
});

describe('the ledger file', () => {
  it('carries restarts, and which of them were never-bound, to the next supervisor', () => {
    const path = tempLedgerPath();
    fileRestartLedger(path).save({ restarts: [1, 2, 3], unbound: [2, 3] });
    expect(fileRestartLedger(path).load()).toEqual({ restarts: [1, 2, 3], unbound: [2, 3] });
  });

  it('reads a missing or corrupt file as empty, so the watchdog can still act', () => {
    const path = tempLedgerPath();
    expect(fileRestartLedger(path).load()).toEqual({ restarts: [], unbound: [] });
    plantLedger(path, '{ not json');
    expect(fileRestartLedger(path).load()).toEqual({ restarts: [], unbound: [] });
  });

  it('reads a file written before `unbound` existed as no never-bound restarts', () => {
    // Prod is writing this shape right now, so the first supervisor to run
    // the new code reads one. It must count every restart for the limit and
    // start the backoff at its base, rather than refusing to read the file.
    const path = tempLedgerPath();
    plantLedger(path, JSON.stringify({ restarts: [10, 20] }));
    expect(fileRestartLedger(path).load()).toEqual({ restarts: [10, 20], unbound: [] });
    expect(firstBindGraceFor([], 30, { windowMs: 1_000 }).graceMs).toBe(FIRST_BIND_GRACE_MS);
  });

  it('refuses an `unbound` entry that names a restart `restarts` does not', () => {
    // The count only means something while `unbound` is a subset. A file
    // hand-edited into naming restarts that never happened would otherwise
    // buy a boot an arbitrarily long grace.
    const path = tempLedgerPath();
    plantLedger(path, JSON.stringify({ restarts: [10], unbound: [10, 20, 30] }));
    expect(fileRestartLedger(path).load()).toEqual({ restarts: [10], unbound: [10] });
  });

  it('keeps the file readable by a supervisor that only knows about `restarts`', () => {
    const path = tempLedgerPath();
    fileRestartLedger(path).save({ restarts: [5, 6], unbound: [6] });
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { restarts: number[] };
    expect(raw.restarts).toEqual([5, 6]);
  });
});

describe('firstBindGraceFor: repeated never-bound restarts back off', () => {
  const NOW = 100 * MIN;
  const opts = { windowMs: POLICY.windowMs };

  it('gives the base grace when nothing has been restarted', () => {
    expect(firstBindGraceFor([], NOW, opts)).toEqual({
      graceMs: FIRST_BIND_GRACE_MS,
      priorUnboundRestarts: 0,
    });
  });

  it('doubles per never-bound restart, then holds at the ceiling', () => {
    const at = (n: number) => Array.from({ length: n }, (_, i) => NOW - (i + 1) * MIN);
    expect(firstBindGraceFor(at(1), NOW, opts).graceMs).toBe(2 * FIRST_BIND_GRACE_MS);
    expect(firstBindGraceFor(at(2), NOW, opts).graceMs).toBe(4 * FIRST_BIND_GRACE_MS);
    expect(firstBindGraceFor(at(2), NOW, opts).graceMs).toBe(FIRST_BIND_GRACE_MAX_MS);
    // Saturated: a fourth and a tenth buy nothing more.
    expect(firstBindGraceFor(at(4), NOW, opts).graceMs).toBe(FIRST_BIND_GRACE_MAX_MS);
    expect(firstBindGraceFor(at(10), NOW, opts).graceMs).toBe(FIRST_BIND_GRACE_MAX_MS);
  });

  it('clears the backoff once the restarts age out of the window', () => {
    const old = [NOW - POLICY.windowMs - 1, NOW - 2 * POLICY.windowMs];
    expect(firstBindGraceFor(old, NOW, opts)).toEqual({
      graceMs: FIRST_BIND_GRACE_MS,
      priorUnboundRestarts: 0,
    });
  });

  it('ignores a timestamp from the future, like the restart limit does', () => {
    expect(firstBindGraceFor([NOW + MIN], NOW, opts).priorUnboundRestarts).toBe(0);
  });

  it('keeps a grace of 0 at 0 however bad the history is', () => {
    // `firstBindGraceMs: 0` is how a caller turns the grace OFF. History must
    // not be able to turn it back on.
    const many = Array.from({ length: 5 }, (_, i) => NOW - (i + 1) * MIN);
    expect(firstBindGraceFor(many, NOW, { ...opts, base: 0 }).graceMs).toBe(0);
  });

  it('never returns less than the base, whatever ceiling it is given', () => {
    // A misconfigured ceiling below the base would otherwise SHORTEN the
    // grace — the one direction this function must never move.
    const grace = firstBindGraceFor([NOW - MIN], NOW, { ...opts, maxMs: 1 });
    expect(grace.graceMs).toBe(FIRST_BIND_GRACE_MS);
  });

  it('clears the 109.9s boot at every step, which is the floor it exists for', () => {
    // The largest boot prod has on record that COMPLETED, and it is
    // right-censored: three more were killed at ~75s with no `servingAt`, so
    // the true maximum is unobserved above that. Every grace this function
    // can return has to clear the observed one with room.
    const LARGEST_OBSERVED_BOOT_MS = 109_900;
    for (const prior of [0, 1, 2, 3]) {
      const unbound = Array.from({ length: prior }, (_, i) => NOW - (i + 1) * MIN);
      expect(firstBindGraceFor(unbound, NOW, opts).graceMs).toBeGreaterThan(
        LARGEST_OBSERVED_BOOT_MS,
      );
    }
  });
});
