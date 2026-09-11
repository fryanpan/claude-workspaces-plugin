/**
 * The install runner, and the gate the supervisor holds prod behind.
 *
 * The runner is driven for real against a throwaway project whose only
 * dependencies are local `file:` packages and whose registry is a dead
 * address, so it proves bun's own behaviour without touching the network.
 *
 * The gate runs on an injected clock. What it has to prove is a count: how
 * many times `bun install` runs while a failure never clears. Under launchd a
 * supervisor that simply exited would be relaunched every 10 seconds, ~360
 * installs an hour; the gate's answer is six, and one per relaunch storm.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INSTALL_BACKOFF,
  type InstallFailure,
  type InstallGateDeps,
  type InstallLedger,
  type InstallResult,
  fileInstallLedger,
  installBeforeBoot,
  lockFingerprint,
  spawnBunInstall,
} from '../src/dependency-install.ts';

const scratch: string[] = [];
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A project bun can install with no network: `file:` dependencies, and a
 * bunfig pointing the registry at a port nothing listens on, so an attempt
 * to reach it would fail rather than quietly succeed.
 */
function offlineProject(): string {
  const dir = tempDir('dep-install-');
  for (const name of ['alpha-pkg', 'beta-pkg']) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
  writeFileSync(
    join(dir, 'bunfig.toml'),
    `[install]\nregistry = "http://127.0.0.1:9/"\n[install.cache]\ndir = "${join(dir, '.cache')}"\n`,
  );
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'app',
      private: true,
      dependencies: { 'alpha-pkg': 'file:./alpha-pkg' },
    }),
  );
  // Write the lockfile the way a merge would carry it, then drop what it
  // installed: node_modules is now behind bun.lock.
  const locked = Bun.spawnSync(['bun', 'install'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  if (locked.exitCode !== 0) throw new Error(`fixture install failed: ${locked.stderr.toString()}`);
  rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
  return dir;
}

describe('spawnBunInstall', () => {
  it('brings node_modules up to bun.lock', () => {
    const dir = offlineProject();
    expect(existsSync(join(dir, 'node_modules', 'alpha-pkg', 'package.json'))).toBe(false);

    expect(spawnBunInstall(dir)()).toEqual({ ok: true });
    expect(existsSync(join(dir, 'node_modules', 'alpha-pkg', 'package.json'))).toBe(true);
  });

  it('refuses a bun.lock that no longer matches package.json, and leaves it alone', () => {
    const dir = offlineProject();
    const lockBefore = readFileSync(join(dir, 'bun.lock'), 'utf8');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'app',
        private: true,
        dependencies: { 'alpha-pkg': 'file:./alpha-pkg', 'beta-pkg': 'file:./beta-pkg' },
      }),
    );

    const result = spawnBunInstall(dir)();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('lockfile is frozen');
    expect(readFileSync(join(dir, 'bun.lock'), 'utf8')).toBe(lockBefore);
  });
});

/** An in-memory ledger shared between "relaunches" of the gate. */
function memoryLedger(): InstallLedger & { entry: InstallFailure | null } {
  const l = {
    entry: null as InstallFailure | null,
    load: () => l.entry,
    save: (f: InstallFailure | null) => {
      l.entry = f;
    },
  };
  return l;
}

interface Harness {
  deps: InstallGateDeps;
  clock: { t: number };
  installs: number[];
  lines: string[];
}

/**
 * A gate on a fake clock. `sleep` advances the clock and resolves at once, so
 * a whole hour of backoff runs in microseconds; `outcome` decides each
 * install by the clock. A runaway loop is capped rather than left to hang.
 */
function harness(opts: {
  ledger: InstallLedger;
  clock?: { t: number };
  fingerprint?: () => string;
  outcome: (t: number) => InstallResult;
  sleep?: (ms: number) => Promise<void>;
}): Harness {
  const clock = opts.clock ?? { t: 0 };
  const installs: number[] = [];
  const lines: string[] = [];
  return {
    clock,
    installs,
    lines,
    deps: {
      install: () => {
        installs.push(clock.t);
        if (installs.length > 100) throw new Error('install ran more than 100 times');
        return opts.outcome(clock.t);
      },
      fingerprint: opts.fingerprint ?? (() => 'lock-a'),
      ledger: opts.ledger,
      ledgerPath: '/data/supervisor-install-failure.json',
      now: () => clock.t,
      sleep:
        opts.sleep ??
        (async (ms) => {
          clock.t += ms;
        }),
      log: (l) => lines.push(l),
    },
  };
}

const HOUR = 3_600_000;
const frozen: InstallResult = {
  ok: false,
  detail: 'Resolving dependencies\nerror: lockfile had changes, but lockfile is frozen',
};

describe('installBeforeBoot', () => {
  it('returns after one install when it succeeds, and says nothing', async () => {
    const h = harness({ ledger: memoryLedger(), outcome: () => ({ ok: true }) });
    await installBeforeBoot(h.deps);
    expect(h.installs).toEqual([0]);
    expect(h.lines).toEqual([]);
  });

  it('runs bun install six times in the first hour of a failure that never clears', async () => {
    // Fails until an hour has passed, then succeeds so the gate returns.
    const h = harness({
      ledger: memoryLedger(),
      outcome: (t) => (t >= HOUR ? { ok: true } : frozen),
    });
    await installBeforeBoot(h.deps);

    const inFirstHour = h.installs.filter((t) => t < HOUR);
    expect(inFirstHour.map((t) => t / 60_000)).toEqual([0, 1, 3, 7, 15, 31]);
    // Every failed attempt said so, once, on one dated-able line.
    const failures = h.lines.filter((l) => l.includes('bun install --frozen-lockfile FAILED'));
    expect(failures).toHaveLength(6);
    for (const l of failures) expect(l).not.toContain('\n');
    expect(failures[0]).toContain('lockfile had changes, but lockfile is frozen');
    // The backoff never grows past its cap.
    const gaps = h.installs.slice(1).map((t, i) => t - (h.installs[i] ?? 0));
    expect(Math.max(...gaps)).toBe(INSTALL_BACKOFF.capMs);
  });

  it('runs bun install once across relaunches every 10s against the same failing lock', () => {
    // What launchd does to a supervisor that exits: start it again, ten
    // seconds later, for as long as it keeps failing. Each relaunch is a new
    // gate over the same ledger; none of them may re-run the install until
    // the backoff expires.
    const ledger = memoryLedger();
    const clock = { t: 0 };
    const installs: number[] = [];
    const lines: string[] = [];
    for (let relaunch = 0; relaunch < 6; relaunch++) {
      const h = harness({
        ledger,
        clock,
        outcome: () => frozen,
        // A gate that waits never wakes inside this test, the way a killed
        // process never does.
        sleep: () => new Promise(() => {}),
      });
      void installBeforeBoot(h.deps);
      installs.push(...h.installs);
      lines.push(...h.lines);
      clock.t += 10_000;
    }
    expect(installs).toEqual([0]);
    const holding = lines.filter((l) => l.includes('not re-running bun install yet'));
    expect(holding).toHaveLength(5);
    expect(holding[0]).toContain('failed 1 time(s) against this exact bun.lock');

    // Past the backoff, the next relaunch tries again — once.
    clock.t = INSTALL_BACKOFF.baseMs;
    const late = harness({
      ledger,
      clock,
      outcome: () => frozen,
      sleep: () => new Promise(() => {}),
    });
    void installBeforeBoot(late.deps);
    expect(late.installs).toEqual([INSTALL_BACKOFF.baseMs]);
    expect(ledger.entry?.failures).toBe(2);
  });

  it('retries at once when bun.lock changes, without waiting out the backoff', async () => {
    let lock = 'lock-a';
    const h = harness({
      ledger: memoryLedger(),
      fingerprint: () => lock,
      outcome: () => (lock === 'lock-b' ? { ok: true } : frozen),
      sleep: async (ms) => {
        h.clock.t += ms;
        lock = 'lock-b'; // the pull that fixes it lands during the first wait
      },
    });
    await installBeforeBoot(h.deps);
    expect(h.installs).toEqual([0, INSTALL_BACKOFF.pollMs]);
  });

  it('retries at once when a person deletes the ledger, as the log says they may', async () => {
    const ledger = memoryLedger();
    const h = harness({
      ledger,
      outcome: (t) => (t === 0 ? frozen : { ok: true }),
      sleep: async (ms) => {
        h.clock.t += ms;
        ledger.entry = null; // `rm supervisor-install-failure.json` during the first wait
      },
    });
    await installBeforeBoot(h.deps);
    expect(h.installs).toEqual([0, INSTALL_BACKOFF.pollMs]);
    expect(h.lines.some((l) => l.includes('was deleted — retrying bun install now'))).toBe(true);
  });

  it('still waits out the backoff when the ledger cannot be written at all', async () => {
    // Reads as deleted on every poll; that must not become an install per poll.
    const h = harness({
      ledger: { load: () => null, save: () => {} },
      outcome: (t) => (t === 0 ? frozen : { ok: true }),
    });
    await installBeforeBoot(h.deps);
    expect(h.installs).toEqual([0, INSTALL_BACKOFF.baseMs]);
  });

  it('clears the recorded failure once an install succeeds', async () => {
    const ledger = memoryLedger();
    ledger.entry = { fingerprint: 'lock-old', failures: 3, lastAttemptAt: 0, detail: 'x' };
    const h = harness({ ledger, outcome: () => ({ ok: true }) });
    await installBeforeBoot(h.deps);
    expect(h.installs).toEqual([0]);
    expect(ledger.entry).toBeNull();
  });
});

describe('fileInstallLedger', () => {
  it('round-trips a failure, clears it, and reads garbage as nothing', () => {
    const path = join(tempDir('install-ledger-'), 'data', 'supervisor-install-failure.json');
    const ledger = fileInstallLedger(path);
    expect(ledger.load()).toBeNull();

    const failure = { fingerprint: 'abc', failures: 2, lastAttemptAt: 42, detail: 'frozen' };
    ledger.save(failure);
    expect(ledger.load()).toEqual(failure);

    ledger.save(null);
    expect(existsSync(path)).toBe(false);

    writeFileSync(path, 'not json');
    expect(ledger.load()).toBeNull();
  });
});

describe('lockFingerprint', () => {
  it('moves with bun.lock and with any workspace manifest, and only with them', () => {
    const dir = tempDir('lock-fingerprint-');
    mkdirSync(join(dir, 'packages', 'one'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    writeFileSync(join(dir, 'packages', 'one', 'package.json'), '{"name":"one"}');
    writeFileSync(join(dir, 'bun.lock'), 'v1');
    const first = lockFingerprint(dir);

    writeFileSync(join(dir, 'README.md'), 'unrelated');
    expect(lockFingerprint(dir)).toBe(first);

    writeFileSync(join(dir, 'packages', 'one', 'package.json'), '{"name":"one","version":"2"}');
    const second = lockFingerprint(dir);
    expect(second).not.toBe(first);

    writeFileSync(join(dir, 'bun.lock'), 'v2');
    expect(lockFingerprint(dir)).not.toBe(second);
  });
});
