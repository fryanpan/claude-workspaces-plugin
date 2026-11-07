/**
 * A stop signal must end in an exit launchd relaunches.
 *
 * On 6 Nov prod's supervisor took a SIGTERM, exited 0 and stayed down until
 * somebody ran kickstart: the plist's KeepAlive { SuccessfulExit: false,
 * Crashed: true } never relaunches a clean exit, and nothing says who sent the
 * signal. `launchctl kickstart -k`, `bootout` and a machine shutdown send the
 * same SIGTERM, and in those launchd decides what happens next whatever the
 * exit code was, so the supervisor exits non-zero for all of them.
 *
 * These boot the real `scripts/serve.ts` with a stand-in `bun` first on its
 * PATH. Install and the client builds are no-ops; the server is the real
 * `bin.ts`, on port 0, or for a deploy the fixture that runs the real
 * `selfRestart`. `relaunches` is the plist's rule as `man launchd.plist` words
 * it, so a death by SIGTERM does not count: the man page promises a relaunch
 * only for a non-zero exit status and for crash signals.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { deployLogPath, readDeployLog, writeDeployLog } from '../src/deploy-log.ts';
import type { DeployResult } from '../src/deploy.ts';
import { waitFor } from './wait-for.ts';

const repoRoot = join(import.meta.dir, '..', '..', '..');
const SERVE = join(repoRoot, 'scripts', 'serve.ts');
const DEPLOY_JOB = join(import.meta.dir, 'fixtures', 'deploy-restart-job.ts');
const WAIT = { timeout: 30_000 };

const SHIM = `#!/bin/sh
case "$*" in
  *--frozen-lockfile*)
    if [ -n "$SHIM_INSTALL_FAILS" ]; then
      echo 'error: lockfile had changes, but lockfile is frozen' >&2
      exit 1
    fi
    exit 0 ;;
  *--watch*)
    exec sleep 600 ;;
  *bin.ts*)
    echo $$ >> "$SHIM_SERVER_PIDS"
    if [ -f "$SHIM_DEPLOY_ONCE" ]; then
      rm "$SHIM_DEPLOY_ONCE"
      exec "$REAL_BUN" "$DEPLOY_JOB" "$SHIM_JOB_LOG" deploy
    fi
    exec "$REAL_BUN" "$@" ;;
esac
exit 0
`;

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const relaunches = (e: Exit): boolean => e.signal === null && e.code !== null && e.code !== 0;

const scratch: string[] = [];
const running: ReturnType<typeof boot>[] = [];

afterEach(async () => {
  // SIGTERM rather than SIGKILL: only the supervisor knows to stop the server.
  for (const s of running.splice(0)) {
    if (s.exited() === null) s.proc.kill('SIGTERM');
    await waitFor(() => s.exited() !== null, WAIT);
  }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function machine(opts: { installFails?: boolean; deployOnce?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'supervisor-stop-')));
  scratch.push(dir);
  const shimDir = join(dir, 'bin');
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, 'bun'), SHIM);
  chmodSync(join(shimDir, 'bun'), 0o755);
  mkdirSync(join(dir, 'home'));
  const deployOnce = join(dir, 'deploy-once');
  if (opts.deployOnce) writeFileSync(deployOnce, '');
  const serverPids = join(dir, 'server-pids');
  return {
    dataDir: join(dir, 'data'),
    serverPids: (): number[] =>
      existsSync(serverPids)
        ? readFileSync(serverPids, 'utf8').split('\n').filter(Boolean).map(Number)
        : [],
    env: {
      ...process.env,
      PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
      REAL_BUN: process.execPath,
      DEPLOY_JOB,
      SHIM_DEPLOY_ONCE: deployOnce,
      SHIM_JOB_LOG: join(dir, 'job.log'),
      SHIM_SERVER_PIDS: serverPids,
      ...(opts.installFails ? { SHIM_INSTALL_FAILS: '1' } : {}),
      HOME: join(dir, 'home'),
      CW_DATA_DIR: join(dir, 'data'),
      CW_CLIENT_ROOT: join(dir, 'client'),
      CW_PLUGIN_REFRESH_MINUTES: '0',
      CW_SUMMARIES: '0',
      SENTRY_DSN: '',
    },
  };
}

function boot(m: ReturnType<typeof machine>, mode: string[] = ['--no-watch']) {
  const proc: ChildProcess = spawn(process.execPath, [SERVE, ...mode, '--port', '0'], {
    env: m.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout?.on('data', (d) => {
    output += String(d);
  });
  proc.stderr?.on('data', (d) => {
    output += String(d);
  });
  let exit: Exit | null = null;
  proc.on('exit', (code, signal) => {
    exit = { code, signal };
  });
  const handle = {
    proc,
    output: () => output,
    exited: () => exit,
    exit: () =>
      waitFor(() => exit, { ...WAIT, describe: `the supervisor to exit; output: ${output}` }),
    line: (needle: string) =>
      waitFor(() => output.split('\n').find((l) => l.includes(needle)), {
        ...WAIT,
        describe: `a line containing "${needle}"`,
      }).catch((e: Error) => {
        throw new Error(`${e.message}; output: ${output.slice(-1500)}`);
      }),
    /** The port the real server bound, once it answers. */
    serving: async () => {
      const line = await handle.line('[feedback] listening on :');
      const port = Number(line.slice(line.lastIndexOf(':') + 1));
      const res = await fetch(`http://127.0.0.1:${port}/api/deploy`);
      expect(res.status).toBe(200);
      return port;
    },
  };
  running.push(handle);
  return handle;
}

describe('a stop signal with no deploy recorded', () => {
  it('ends in an exit launchd relaunches, and the relaunch serves', async () => {
    const m = machine();
    const first = boot(m);
    await first.serving();
    expect(readDeployLog(deployLogPath(m.dataDir))).toBeNull();

    first.proc.kill('SIGTERM');
    const exit = await first.exit();
    expect(exit).toEqual({ code: 143, signal: null });
    expect(relaunches(exit)).toBe(true);
    // The graceful shutdown still ran: that handler is what flushes documents.
    expect(first.output()).toContain('[feedback] shutting down (SIGTERM)');

    await boot(m).serving();
  }, 90_000);

  for (const [signal, code] of [
    ['SIGTERM', 143],
    ['SIGHUP', 129],
    ['SIGINT', 130],
  ] as const) {
    it(`${signal} before a server exists still exits so launchd relaunches`, async () => {
      // Waiting on a failed install is one of the boot's long windows.
      const s = boot(machine({ installFails: true }));
      await s.line('bun install --frozen-lockfile FAILED');

      s.proc.kill(signal);
      const exit = await s.exit();
      expect(exit).toEqual({ code, signal: null });
      expect(relaunches(exit)).toBe(true);
    }, 60_000);
  }

  it('sent to the server alone, the supervisor exits non-zero too', async () => {
    const m = machine();
    const s = boot(m);
    await s.serving();
    const [serverPid] = m.serverPids();

    process.kill(serverPid as number, 'SIGTERM');
    // A young server takes the 20s crash hold. A second signal lands inside
    // it, so this case pays neither the hold nor a fixed wait.
    await s.line('holding 20s before exiting');
    s.proc.kill('SIGTERM');
    const exit = await s.exit();
    expect(exit).toEqual({ code: 143, signal: null });
    expect(relaunches(exit)).toBe(true);
  }, 90_000);

  it('stays exit 0 for a dev server, where Ctrl+C means stop', async () => {
    const s = boot(machine(), []);
    await s.line('[supervisor] data dir:');

    s.proc.kill('SIGINT');
    expect(await s.exit()).toEqual({ code: 0, signal: null });
  }, 60_000);
});

describe('a deploy restart', () => {
  it('relaunches with no crash hold, and the new boot records healthy', async () => {
    const m = machine({ deployOnce: true });
    mkdirSync(m.dataDir, { recursive: true });
    const log = deployLogPath(m.dataDir);
    const pending: DeployResult = {
      ok: true,
      status: 'deployed',
      before: 'aaaaaaa',
      after: 'bbbbbbb',
      changed: true,
      behind: 1,
      ahead: 0,
      restartRequested: true,
      installed: true,
      verification: { state: 'pending', deadlineAt: Date.now() + 600_000 },
      message: 'fixture deploy',
      ranAt: Date.now(),
    };
    writeDeployLog(log, pending);

    // The first server is the fixture: real `selfRestart`, exit 75.
    const first = boot(m);
    const exit = await first.exit();
    expect(exit).toEqual({ code: 1, signal: null });
    expect(relaunches(exit)).toBe(true);
    expect(first.output()).not.toContain('holding');
    expect(first.output()).not.toContain('stop signal');

    await boot(m).serving();
    await waitFor(() => readDeployLog(log)?.verification?.state === 'healthy', {
      ...WAIT,
      describe: 'the restarted server to confirm the deploy',
    });
  }, 90_000);
});
