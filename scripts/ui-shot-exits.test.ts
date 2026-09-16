/**
 * Every way a `ui:shot` run can end leaves no Chrome and no profile behind.
 *
 * Nine headless Chromes were found running 15 hours to 2 days after the runs
 * that started them had gone. So each case names ONE exit path, drives a real
 * run down it, and polls until neither this run's Chrome nor its profile is
 * left — matching only profiles carrying a run id this file handed out, never
 * a count of `cw-ui-shot-*`, which another agent's live run would change.
 *
 * The owner's own cleanup runs with the watchdog off (`CW_CHROME_WATCHDOG=0`):
 * with it on, a broken cleanup still passes a second later, and these cases
 * would prove the watchdog five times. Only the SIGKILL case, where no cleanup
 * can run, keeps it.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chromeForSuite } from './browser-tests.ts';
import { WATCHDOG_ENV } from './chrome-orphans.ts';
import { RUN_ID_ENV, profilePrefix, profilesOfRun } from './ui-shot-lib.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();
const SCRIPT = resolve(process.cwd(), 'scripts/ui-shot.ts');
const HANG_URL = `data:text/html,${encodeURIComponent('<title>hang</title>')}`;

/** Chrome processes running out of one of this run's profiles, by pid. */
function chromePids(runId: string): number[] {
  const needle = `user-data-dir=${join(tmpdir(), profilePrefix(runId))}`;
  return spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter((line) => line.includes(needle))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

const profiles = (runId: string) => profilesOfRun(readdirSync(tmpdir()), runId);

async function waitFor(what: string, ok: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Nothing of this run is left: no Chrome, no profile. */
async function expectNothingLeft(runId: string): Promise<void> {
  await waitFor(`run ${runId} to leave no Chrome`, () => chromePids(runId).length === 0);
  await waitFor(`run ${runId} to leave no profile`, () => profiles(runId).length === 0);
  // And it stays gone: a starting Chrome rebuilds a profile removed under it.
  // timed: one Chrome restart's worth — the rebuild lands within ~200ms.
  await new Promise((r) => setTimeout(r, 1000));
  expect(profiles(runId)).toEqual([]);
  expect(chromePids(runId)).toEqual([]);
}

describe.skipIf(CHROME === null)('ui-shot exit paths against real headless Chrome', () => {
  const owned: string[] = [];
  const children: ChildProcess[] = [];
  const newRunId = () => {
    const id = `exits${process.pid}${owned.length}`;
    owned.push(id);
    return id;
  };

  afterEach(() => {
    for (const c of children.splice(0)) {
      if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    }
    // Best effort and scoped to this file's run ids: a failing case can leave
    // its Chrome up, and nothing else on the machine is ours to touch.
    for (const runId of owned) {
      for (const pid of chromePids(runId)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      for (const name of profiles(runId)) {
        rmSync(join(tmpdir(), name), { recursive: true, force: true });
      }
    }
  });

  const env = (runId: string, watchdog: boolean) => ({
    ...process.env,
    [RUN_ID_ENV]: runId,
    [WATCHDOG_ENV]: watchdog ? '1' : '0',
  });

  /** Run to completion; returns the exit status and stderr. */
  function runToEnd(runId: string, args: string[]): { status: number | null; stderr: string } {
    const r = spawnSync('bun', [SCRIPT, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: env(runId, false),
    });
    return { status: r.status, stderr: r.stderr };
  }

  /** Start a run that hangs in `--wait-for`, and return once its Chrome is up. */
  async function startHanging(runId: string, watchdog: boolean): Promise<ChildProcess> {
    const child = spawn(
      'bun',
      [
        SCRIPT,
        '--url',
        HANG_URL,
        '--wait-for',
        '#never-matches',
        '--timeout',
        '60000',
        '--eval',
        '1',
      ],
      { stdio: 'ignore', env: env(runId, watchdog) },
    );
    children.push(child);
    // Non-vacuous by construction: the checks afterwards only mean something
    // once this run's Chrome and profile demonstrably existed.
    await waitFor('the run to start its Chrome', () => chromePids(runId).length > 0, 30_000);
    expect(profiles(runId)).toHaveLength(1);
    return child;
  }

  it('a capture that succeeds', async () => {
    const runId = newRunId();
    const r = runToEnd(runId, ['--url', HANG_URL, '--settle', '1', '--eval', '1']);
    expect(r.status, r.stderr).toBe(0);
    await expectNothingLeft(runId);
  }, 90_000);

  it('a capture that throws', async () => {
    const runId = newRunId();
    const r = runToEnd(runId, ['--url', HANG_URL, '--settle', '1', '--eval', 'nope.nope']);
    expect(r.status).toBe(1);
    expect(r.stderr, 'the run must fail inside the page').toMatch(/page threw/);
    await expectNothingLeft(runId);
  }, 90_000);

  it('a capture that times out', async () => {
    const runId = newRunId();
    const r = runToEnd(runId, [
      '--url',
      HANG_URL,
      '--wait-for',
      '#never-matches',
      '--timeout',
      '300',
      '--eval',
      '1',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr, 'the run must fail at the page, not the launch').toMatch(
      /page load did not finish|never matched/,
    );
    await expectNothingLeft(runId);
  }, 90_000);

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'a run that receives %s mid-shot',
    async (signal) => {
      const runId = newRunId();
      const child = await startHanging(runId, false);
      child.kill(signal);
      await waitFor('the run to exit', () => child.exitCode !== null || child.signalCode !== null);
      await expectNothingLeft(runId);
    },
    90_000,
  );

  it('a run whose parent is SIGKILLed mid-shot', async () => {
    const runId = newRunId();
    const child = await startHanging(runId, true);
    child.kill('SIGKILL');
    await waitFor('the run to die', () => child.signalCode !== null);
    await expectNothingLeft(runId);
  }, 90_000);
});
