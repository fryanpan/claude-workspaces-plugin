/**
 * Every server start leaves a record that says what caused it, and a day of
 * them reads as "N starts, M explained, K unexplained" — never as a quiet
 * zero when nothing was recorded at all.
 *
 * Fixtures are synthetic; every file lives in a scratch dir.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DeployResult, deployLogPath, writeDeployLog } from '../src/deploy-log.ts';
import { VERIFY_BOOT_TIMEOUT_MS } from '../src/deploy.ts';
import {
  HOST_BOOT_FALLBACK_WINDOW_MS,
  SERVER_STARTS_MAX_AGE_MS,
  SERVER_STARTS_MAX_ENTRIES,
  type ServerStart,
  classifyStart,
  formatStartsReport,
  markServerServing,
  pruneServerStarts,
  readServerStarts,
  recordServerStart,
  recordThisServerStart,
  serverStartsPath,
  summarizeStarts,
} from '../src/server-starts.ts';
import { restartLedgerPath } from '../src/supervisor-health.ts';

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60_000;
const BOOT = T0 - 5 * HOUR;

function withDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'server-starts-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function deploy(ranAt: number, over: Partial<DeployResult> = {}): DeployResult {
  return {
    ok: true,
    status: 'deployed',
    before: 'aaaaaaa',
    after: 'bbbbbbb',
    changed: true,
    behind: 1,
    ahead: 0,
    restartRequested: true,
    verification: { state: 'healthy', confirmedAt: ranAt + 30_000, detail: 'fixture' },
    message: 'fixture deploy',
    ranAt,
    ...over,
  };
}

describe('recordServerStart — the causes only the moment of starting can see', () => {
  it('attributes a start to the watchdog restart between it and the previous start', () => {
    withDir((dir) => {
      const file = serverStartsPath(dir);
      recordServerStart(file, { startedAt: T0, pid: 1, hostBootAt: BOOT }, []);
      const s = recordServerStart(
        file,
        { startedAt: T0 + 10 * 60_000, pid: 2, hostBootAt: BOOT },
        // One from before the previous start explained THAT start; the one
        // after it explains this one.
        [T0 - 60_000, T0 + 9 * 60_000],
      );
      expect(s.watchdogRestartAt).toBe(T0 + 9 * 60_000);
      expect(classifyStart(s)).toBe('watchdog');
    });
  });

  it('does not credit the watchdog with a restart that predates the previous start', () => {
    withDir((dir) => {
      const file = serverStartsPath(dir);
      recordServerStart(file, { startedAt: T0, pid: 1, hostBootAt: BOOT }, []);
      const s = recordServerStart(file, { startedAt: T0 + 10 * 60_000, pid: 2, hostBootAt: BOOT }, [
        T0 - 60_000,
      ]);
      expect(s.watchdogRestartAt).toBeUndefined();
      expect(classifyStart(s)).toBe('unexplained');
    });
  });

  it('credits a host reboot with the first start after it, and only that one', () => {
    withDir((dir) => {
      const file = serverStartsPath(dir);
      recordServerStart(file, { startedAt: BOOT - HOUR, pid: 1, hostBootAt: BOOT - 2 * HOUR }, []);
      // Login came three hours after the kernel booted: still the reboot's.
      const first = recordServerStart(
        file,
        { startedAt: BOOT + 3 * HOUR, pid: 2, hostBootAt: BOOT },
        [],
      );
      const second = recordServerStart(
        file,
        { startedAt: BOOT + 4 * HOUR, pid: 3, hostBootAt: BOOT },
        [],
      );
      expect(classifyStart(first)).toBe('host-reboot');
      expect(classifyStart(second)).toBe('unexplained');
    });
  });

  it('with no earlier record, credits the host boot only inside the fallback window', () => {
    withDir((dir) => {
      const near = recordServerStart(
        serverStartsPath(join(dir, 'a')),
        { startedAt: BOOT + HOST_BOOT_FALLBACK_WINDOW_MS - 1, pid: 1, hostBootAt: BOOT },
        [],
      );
      const far = recordServerStart(
        serverStartsPath(join(dir, 'b')),
        { startedAt: BOOT + HOST_BOOT_FALLBACK_WINDOW_MS + 1, pid: 1, hostBootAt: BOOT },
        [],
      );
      expect(classifyStart(near)).toBe('host-reboot');
      expect(classifyStart(far)).toBe('unexplained');
    });
  });

  it('marks the boot serving, and a confirmed deploy outranks every other cause', () => {
    withDir((dir) => {
      const file = serverStartsPath(dir);
      const start = recordServerStart(file, { startedAt: T0, pid: 7, hostBootAt: BOOT }, [T0 - 1]);
      markServerServing(file, start, { servingAt: T0 + 40_000, deployRanAt: T0 - 5_000 });
      const [onDisk] = readServerStarts(file);
      expect(onDisk?.servingAt).toBe(T0 + 40_000);
      expect(onDisk?.deployRanAt).toBe(T0 - 5_000);
      expect(onDisk && classifyStart(onDisk)).toBe('deploy');
    });
  });

  it('records this process with the watchdog ledger the supervisor wrote', () => {
    withDir((dir) => {
      const origin = Math.round(performance.timeOrigin);
      writeFileSync(restartLedgerPath(dir), JSON.stringify({ restarts: [origin - 1_000] }));
      const s = recordThisServerStart(dir);
      expect(s.pid).toBe(process.pid);
      expect(s.startedAt).toBe(origin);
      expect(s.watchdogRestartAt).toBe(origin - 1_000);
      expect(s.hostBootAt).toBeLessThanOrEqual(origin);
      expect(readServerStarts(serverStartsPath(dir))).toEqual([s]);
    });
  });
});

describe('server start record — bounded', () => {
  it('drops starts older than the age bound, measured from the newest', () => {
    const at = (startedAt: number): ServerStart => ({ startedAt, pid: 1 });
    const pruned = pruneServerStarts([
      at(T0),
      at(T0 + SERVER_STARTS_MAX_AGE_MS - HOUR),
      at(T0 + SERVER_STARTS_MAX_AGE_MS + 1),
    ]);
    expect(pruned.map((s) => s.startedAt)).toEqual([
      T0 + SERVER_STARTS_MAX_AGE_MS - HOUR,
      T0 + SERVER_STARTS_MAX_AGE_MS + 1,
    ]);
  });

  it('caps the count for a crash loop inside the age window', () => {
    const many = Array.from({ length: SERVER_STARTS_MAX_ENTRIES + 5 }, (_, i) => ({
      startedAt: T0 + i,
      pid: i,
    }));
    expect(pruneServerStarts(many)).toHaveLength(SERVER_STARTS_MAX_ENTRIES);
  });
});

describe('summarizeStarts — the health check reading', () => {
  const starts: ServerStart[] = [
    { startedAt: T0 - 30 * HOUR, pid: 1, servingAt: T0 - 30 * HOUR + 1 }, // outside the window
    { startedAt: T0 - 20 * HOUR, pid: 2, firstSinceHostBoot: true, servingAt: T0 - 20 * HOUR + 1 },
    {
      startedAt: T0 - 10 * HOUR,
      pid: 3,
      deployRanAt: T0 - 10 * HOUR - 5_000,
      servingAt: T0 - 10 * HOUR + 1,
    },
    { startedAt: T0 - 5 * HOUR, pid: 4, servingAt: T0 - 5 * HOUR + 1 },
    { startedAt: T0 - 4 * HOUR, pid: 5, watchdogRestartAt: T0 - 4 * HOUR - 60_000 },
    { startedAt: T0 - 3 * HOUR, pid: 6 }, // never served
  ];
  const deploys = [
    deploy(T0 - 30 * HOUR),
    deploy(T0 - 10 * HOUR - 5_000),
    deploy(T0 - 2 * HOUR, {
      restartRequested: false,
      verification: undefined,
      status: 'up-to-date',
    }),
    deploy(T0 - HOUR, {
      status: 'boot-failed',
      verification: { state: 'failed', failedAt: T0, detail: 'fixture', statusWas: 'deployed' },
    }),
    // Pending past its deadline: a failure nobody survived to write.
    deploy(T0 - 30 * 60_000, {
      verification: { state: 'pending', deadlineAt: T0 - 30 * 60_000 + VERIFY_BOOT_TIMEOUT_MS },
    }),
    deploy(T0 - 1_000, { verification: { state: 'pending', deadlineAt: T0 + 60_000 } }),
  ];
  const summary = summarizeStarts({ starts, deploys, since: T0 - 24 * HOUR, until: T0 });

  it('counts every start in the window by cause', () => {
    expect(summary.counts).toEqual({
      total: 5,
      deploy: 1,
      watchdog: 1,
      'host-reboot': 1,
      unexplained: 2,
    });
  });

  it('counts the deploys that restarted the server, by verdict', () => {
    expect(summary.deploys).toEqual({ restarts: 4, healthy: 1, failed: 2, pending: 1 });
  });

  it('names each unexplained start and whether it ever served', () => {
    const text = formatStartsReport(summary, '/fixture/server-starts.json');
    expect(text).toContain(
      ': 5 — 1 explained by deploys, 1 by the watchdog, 1 by a host reboot, 2 unexplained',
    );
    expect(text).toContain(`${new Date(T0 - 5 * HOUR).toISOString()}  pid 4  served`);
    expect(text).toContain(`${new Date(T0 - 3 * HOUR).toISOString()}  pid 6  never served`);
  });

  it('says so when the record begins inside the window', () => {
    const partial = summarizeStarts({
      starts: starts.slice(3),
      deploys: [],
      since: T0 - 24 * HOUR,
      until: T0,
    });
    expect(formatStartsReport(partial, 'f')).toContain('start records begin at');
  });

  it('reports an absent record as unknown, never as zero starts', () => {
    const none = summarizeStarts({ starts: [], deploys, since: T0 - 24 * HOUR, until: T0 });
    expect(none.recordedFrom).toBeNull();
    expect(formatStartsReport(none, '/fixture/server-starts.json')).toContain('this is not a zero');
  });
});

describe('scripts/server-starts.ts — the command the runbook names', () => {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'scripts',
    'server-starts.ts',
  );
  const run = (dir: string) =>
    spawnSync('bun', ['run', script, '--data-dir', dir], {
      encoding: 'utf8',
      env: { ...process.env },
    });

  it('prints the day over a data dir, and exits 2 on one with no record', () => {
    withDir((dir) => {
      const empty = run(dir);
      expect(empty.status).toBe(2);
      expect(empty.stdout).toContain('this is not a zero');

      const now = Date.now();
      writeDeployLog(deployLogPath(dir), deploy(now - HOUR));
      const file = serverStartsPath(dir);
      const s = recordServerStart(file, { startedAt: now - HOUR + 20_000, pid: 11 }, []);
      markServerServing(file, s, { servingAt: now - HOUR + 40_000, deployRanAt: now - HOUR });
      recordServerStart(file, { startedAt: now - 60_000, pid: 12 }, []);

      const day = run(dir);
      expect(day.status).toBe(0);
      expect(day.stdout).toContain(
        ': 2 — 1 explained by deploys, 0 by the watchdog, 0 by a host reboot, 1 unexplained',
      );
      expect(day.stdout).toContain('deploys that restarted the server: 1 — 1 healthy');
      expect(day.stdout).toContain('pid 12  never served');
    });
  });
});
