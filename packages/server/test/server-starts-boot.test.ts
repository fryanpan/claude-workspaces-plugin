/**
 * The wiring nothing else exercises: a REAL spawned `bin.ts --deploy`, over a
 * data dir holding the single-record deploy log an older server wrote with
 * its restart still pending. That is exactly the state prod is in on the boot
 * after the deploy that ships the history — so this proves the migration,
 * the boot confirmation and the start record together, in the process that
 * does them.
 *
 * Read-only against the server: one GET of /api/deploy, which runs nothing.
 * Fixtures are synthetic; the data dir is a scratch dir.
 */
import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DeployResult, deployLogPath } from '../src/deploy-log.ts';
import { VERIFY_BOOT_TIMEOUT_MS } from '../src/deploy.ts';
import { readServerStarts, serverStartsPath } from '../src/server-starts.ts';
import { waitFor } from './wait-for.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('bin.ts records its own start', () => {
  it('confirms the pending deploy an older server wrote, and ties this start to it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cw-starts-boot-'));
    const ranAt = Date.now();
    const legacy: DeployResult = {
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
    };
    writeFileSync(deployLogPath(dataDir), `${JSON.stringify(legacy, null, 2)}\n`);

    const port = 8863 + Math.floor(Math.random() * 10);
    const child = spawn(
      'bun',
      [
        'run',
        join(repoRoot, 'packages', 'server', 'src', 'bin.ts'),
        '--port',
        String(port),
        '--data-dir',
        dataDir,
        '--deploy',
      ],
      { cwd: repoRoot, stdio: 'ignore', env: { ...process.env, CW_SUMMARIES: '0' } },
    );
    try {
      const starts = await waitFor(
        () => {
          const all = readServerStarts(serverStartsPath(dataDir));
          return all.at(-1)?.servingAt !== undefined ? all : null;
        },
        { timeout: 20_000, interval: 100, describe: 'the boot to mark itself serving' },
      );
      expect(starts).toHaveLength(1);
      expect(starts[0]?.deployRanAt).toBe(ranAt);

      const onDisk = JSON.parse(readFileSync(deployLogPath(dataDir), 'utf8')) as {
        entries: DeployResult[];
      };
      expect(onDisk.entries).toHaveLength(1);
      expect(onDisk.entries[0]?.verification?.state).toBe('healthy');

      const res = await fetch(`http://127.0.0.1:${port}/api/deploy`, {
        headers: { host: `localhost:${port}` },
      });
      const body = (await res.json()) as { deploy: DeployResult | null };
      expect(body.deploy?.ranAt).toBe(ranAt);
      expect(body.deploy?.verification?.state).toBe('healthy');
    } finally {
      child.kill('SIGTERM');
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
