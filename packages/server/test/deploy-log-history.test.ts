/**
 * The deploy log is a history, not one record: a deploy no longer erases the
 * last one's verdict, the file an older server wrote is still read, and the
 * log stays bounded.
 *
 * Fixtures are synthetic; every file lives in a scratch dir.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEPLOY_LOG_MAX_AGE_MS,
  DEPLOY_LOG_MAX_ENTRIES,
  type DeployResult,
  confirmDeployBoot,
  deployLogPath,
  expireDeployVerification,
  pruneDeployLog,
  readDeployLog,
  readDeployLogEntries,
  writeDeployLog,
} from '../src/deploy-log.ts';
import { Deployer, VERIFY_BOOT_TIMEOUT_MS } from '../src/deploy.ts';

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60_000;

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
    installed: true,
    verification: { state: 'pending', deadlineAt: ranAt + VERIFY_BOOT_TIMEOUT_MS },
    message: 'fixture deploy',
    ranAt,
    ...over,
  };
}

function withLog(body: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-log-history-'));
  try {
    body(deployLogPath(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('deploy log — appended, not overwritten', () => {
  it('keeps the previous deploy and its verdict when the next one lands', () => {
    withLog((file) => {
      writeDeployLog(file, deploy(T0));
      confirmDeployBoot(file, () => T0 + 30_000);
      writeDeployLog(file, deploy(T0 + DAY));

      const entries = readDeployLogEntries(file);
      expect(entries.map((e) => e.ranAt)).toEqual([T0, T0 + DAY]);
      expect(entries[0]?.verification?.state).toBe('healthy');
      // The latest is what GET /api/deploy and the boot verification read.
      expect(readDeployLog(file)?.ranAt).toBe(T0 + DAY);
      expect(readDeployLog(file)?.verification?.state).toBe('pending');
    });
  });

  it('settles a verification in place rather than appending a second copy', () => {
    withLog((file) => {
      writeDeployLog(file, deploy(T0));
      confirmDeployBoot(file, () => T0 + 30_000);
      expect(readDeployLogEntries(file)).toHaveLength(1);

      writeDeployLog(file, deploy(T0 + DAY));
      expireDeployVerification(file, () => T0 + DAY + VERIFY_BOOT_TIMEOUT_MS + 1);
      const entries = readDeployLogEntries(file);
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.status)).toEqual(['deployed', 'boot-failed']);
    });
  });

  it('records refusals too, without touching the deploy before them', () => {
    withLog((file) => {
      writeDeployLog(file, deploy(T0));
      confirmDeployBoot(file, () => T0 + 30_000);
      writeDeployLog(
        file,
        deploy(T0 + 60_000, {
          ok: false,
          status: 'refuse-dirty',
          restartRequested: false,
          verification: undefined,
        }),
      );
      const entries = readDeployLogEntries(file);
      expect(entries.map((e) => e.status)).toEqual(['deployed', 'refuse-dirty']);
      expect(entries[0]?.verification?.state).toBe('healthy');
    });
  });
});

describe('deploy log — the single record an older server wrote', () => {
  it('is read as a history of one, and the restarted server confirms it', () => {
    // The deploy that ships this reader is performed by a server running the
    // OLD writer, so the first file the new code meets is one bare record.
    withLog((file) => {
      writeFileSync(file, `${JSON.stringify(deploy(T0), null, 2)}\n`);
      expect(readDeployLog(file)?.ranAt).toBe(T0);
      expect(readDeployLogEntries(file)).toHaveLength(1);

      const confirmed = confirmDeployBoot(file, () => T0 + 30_000);
      expect(confirmed?.verification?.state).toBe('healthy');
      const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { entries: DeployResult[] };
      expect(onDisk.entries).toHaveLength(1);
      expect(onDisk.entries[0]?.verification?.state).toBe('healthy');

      writeDeployLog(file, deploy(T0 + DAY));
      expect(readDeployLogEntries(file).map((e) => e.ranAt)).toEqual([T0, T0 + DAY]);
    });
  });

  it('expires into boot-failed through the watchdog the same way', () => {
    withLog((file) => {
      writeFileSync(file, JSON.stringify(deploy(T0)));
      const failed = expireDeployVerification(file, () => T0 + VERIFY_BOOT_TIMEOUT_MS + 1);
      expect(failed?.status).toBe('boot-failed');
      expect(readDeployLog(file)?.status).toBe('boot-failed');
    });
  });

  it('reads garbage and an absent file as no deploys', () => {
    withLog((file) => {
      expect(readDeployLog(file)).toBeNull();
      writeFileSync(file, '{ not json');
      expect(readDeployLogEntries(file)).toEqual([]);
      writeFileSync(file, JSON.stringify({ entries: [{ nope: 1 }, deploy(T0)] }));
      expect(readDeployLogEntries(file).map((e) => e.ranAt)).toEqual([T0]);
    });
  });
});

describe('deploy log — bounded', () => {
  it('drops entries older than the age bound, measured from the newest', () => {
    const old = deploy(T0);
    const kept = deploy(T0 + DEPLOY_LOG_MAX_AGE_MS - DAY);
    const newest = deploy(T0 + DEPLOY_LOG_MAX_AGE_MS + 1);
    expect(pruneDeployLog([old, kept, newest]).map((e) => e.ranAt)).toEqual([
      kept.ranAt,
      newest.ranAt,
    ]);
  });

  it('never drops the newest, even one with no usable ranAt, so GET /api/deploy still answers', () => {
    withLog((file) => {
      const partial = { ...deploy(T0), ranAt: undefined } as unknown as DeployResult;
      writeDeployLog(file, partial);
      expect(readDeployLog(file)?.status).toBe('deployed');
    });
  });

  it('caps the count for a deploy loop inside the age window', () => {
    const many = Array.from({ length: DEPLOY_LOG_MAX_ENTRIES + 20 }, (_, i) => deploy(T0 + i));
    const pruned = pruneDeployLog(many);
    expect(pruned).toHaveLength(DEPLOY_LOG_MAX_ENTRIES);
    expect(pruned.at(-1)?.ranAt).toBe(T0 + DEPLOY_LOG_MAX_ENTRIES + 19);
    expect(pruned[0]?.ranAt).toBe(T0 + 20);
  });
});

describe('Deployer over the history — GET /api/deploy answers with the latest', () => {
  it('reports the newest deploy and still derives boot-failed from its deadline', () => {
    withLog((file) => {
      writeDeployLog(file, deploy(T0));
      confirmDeployBoot(file, () => T0 + 30_000);
      writeDeployLog(file, deploy(T0 + DAY));
      const reader = (now: number) =>
        new Deployer({
          run: async () => deploy(now),
          loadLast: () => readDeployLog(file),
          now: () => now,
        });
      expect(reader(T0 + DAY + 1).last()?.verification?.state).toBe('pending');
      expect(reader(T0 + DAY + VERIFY_BOOT_TIMEOUT_MS).last()?.status).toBe('boot-failed');
      confirmDeployBoot(file, () => T0 + DAY + 60_000);
      expect(reader(T0 + DAY + 1).last()?.verification?.state).toBe('healthy');
    });
  });

  it('appends what the deployer persists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-log-history-'));
    try {
      const file = deployLogPath(dir);
      let now = T0;
      const d = new Deployer({
        run: async () => deploy(now, { restartRequested: false, verification: undefined }),
        persist: (r) => writeDeployLog(file, r),
        loadLast: () => readDeployLog(file),
      });
      await d.deploy();
      now = T0 + 1000;
      await d.deploy();
      expect(readDeployLogEntries(file).map((e) => e.ranAt)).toEqual([T0, T0 + 1000]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
