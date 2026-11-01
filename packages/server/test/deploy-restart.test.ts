/**
 * A deploy restart must come back with nothing left to do after the server
 * is gone.
 *
 * On 31 Oct a deploy stopped prod and launchd left it `not running` with
 * `last exit code = 0`: the restart had been a `launchctl kickstart -k` from
 * inside the job, the supervisor exited 0 on its SIGTERM, and KeepAlive
 * { SuccessfulExit: false } never relaunches a clean exit. Now the deploy
 * stops the server itself with a non-zero code, so the relaunch is
 * KeepAlive's own crash path.
 *
 * `fakeLaunchd` applies the prod plist's KeepAlive rule to a stand-in job in
 * its own process group (fixtures/deploy-restart-job.ts): relaunch on a
 * non-zero exit or a signal, never on exit 0. No real launchd, no launchctl.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPLOY_RESTART_EXIT_CODE } from '../src/deploy-restart.ts';
import { waitFor } from './wait-for.ts';

const JOB = join(import.meta.dir, 'fixtures', 'deploy-restart-job.ts');

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const live: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const p of live.splice(0)) {
    if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run the job under the plist's KeepAlive rule. The relaunch runs `idle`,
 *  so a working restart happens once rather than in a loop. */
function fakeLaunchd(firstMode: 'deploy' | 'hang' | 'idle') {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-restart-'));
  dirs.push(dir);
  const log = join(dir, 'job.log');
  const exits: Exit[] = [];
  const runs: ChildProcess[] = [];
  const start = (mode: string) => {
    const child = spawn(process.execPath, [JOB, log, mode], { detached: true, stdio: 'ignore' });
    live.push(child);
    runs.push(child);
    child.on('exit', (code, signal) => {
      exits.push({ code, signal });
      const keepAlive = signal !== null || code !== 0;
      if (keepAlive && runs.length < 2) start('idle');
    });
  };
  start(firstMode);
  const starts = () => {
    try {
      return readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('start '));
    } catch {
      return [];
    }
  };
  return { exits, runs, starts };
}

describe('a deploy restart', () => {
  test('exits non-zero, so KeepAlive relaunches the job', async () => {
    const job = fakeLaunchd('deploy');
    await waitFor(() => job.starts().length === 2, {
      describe: 'the job to be relaunched after the deploy restart',
    });
    expect(job.exits[0]).toEqual({ code: DEPLOY_RESTART_EXIT_CODE, signal: null });
  });

  test('still exits non-zero when the graceful shutdown hangs', async () => {
    const job = fakeLaunchd('hang');
    await waitFor(() => job.starts().length === 2, {
      describe: 'the backstop exit to relaunch a job whose shutdown hung',
    });
    expect(job.exits[0]).toEqual({ code: DEPLOY_RESTART_EXIT_CODE, signal: null });
  });
});

describe('any other stop', () => {
  test('exits 0, so KeepAlive leaves the job down', async () => {
    const job = fakeLaunchd('idle');
    await waitFor(() => job.starts().length === 1, { describe: 'the job to start' });
    job.runs[0]?.kill('SIGTERM');
    await waitFor(() => job.exits.length === 1, { describe: 'the job to exit on SIGTERM' });
    // The relaunch decision runs inside the exit handler, so it has already
    // been made by the time the exit is recorded.
    expect(job.exits[0]).toEqual({ code: 0, signal: null });
    expect(job.runs).toHaveLength(1);
  });
});
