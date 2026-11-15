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
import { joinRoom } from './room-page.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

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

  it('writes both ends of the reconnect gap: the first page socket, then its own shutdown', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cw-starts-gap-'));
    // Port 0, read back off the listening line: a fixed port can be held by
    // another run on the same machine, and the server waits for it forever.
    const child = spawn(
      'bun',
      [
        'run',
        join(repoRoot, 'packages', 'server', 'src', 'bin.ts'),
        '--port',
        '0',
        '--data-dir',
        dataDir,
      ],
      {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, CW_SUMMARIES: '0' },
      },
    );
    let stdout = '';
    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString();
    });
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    const file = serverStartsPath(dataDir);
    try {
      const port = await waitFor(() => stdout.match(/listening on :(\d+)/)?.[1], {
        timeout: 20_000,
        interval: 100,
        describe: 'the listening line',
      });
      await waitFor(() => readServerStarts(file).at(-1)?.servingAt, {
        describe: 'the boot to mark itself serving',
      });
      expect(readServerStarts(file).at(-1)?.firstClientSocketAt).toBeUndefined();

      const base = `http://127.0.0.1:${port}`;
      const ws = await seedBoard(base);
      const page = joinRoom(`ws://127.0.0.1:${port}/workspaces/${ws}/y?type=workspace`, base);
      await page.ready;
      const reconnectAt = await waitFor(() => readServerStarts(file).at(-1)?.firstClientSocketAt, {
        describe: 'the first page socket in the start record',
      });
      page.close();

      child.kill('SIGTERM');
      const shutdownAt = await waitFor(() => readServerStarts(file).at(-1)?.shutdownAt, {
        timeout: 10_000,
        describe: 'the shutdown written by the stopping process',
      });
      expect(shutdownAt).toBeGreaterThanOrEqual(reconnectAt);
      await exited;
    } finally {
      child.kill('SIGKILL');
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 40_000);
});
