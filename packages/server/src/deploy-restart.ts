/**
 * How a deploy restarts the server: it shuts itself down and exits NON-ZERO,
 * and launchd's KeepAlive starts it again.
 *
 * The prod plist says KeepAlive { SuccessfulExit: false, Crashed: true }, so
 * launchd relaunches the job whenever the supervisor exits non-zero, and the
 * supervisor (`scripts/serve.ts`) exits 1 whenever its server child exits.
 * That is the same path a crash takes, and it needs nothing to happen after
 * this process is gone.
 *
 * The deploy used to run `launchctl kickstart -k` instead. That SIGTERMs the
 * supervisor, which exits 0 (an intentional stop), so the relaunch depended
 * entirely on launchd completing the kickstart's start half. On 31 Oct one
 * deploy restart in 22 left the job `not running` with `last exit code = 0`.
 * kickstart also SIGKILLs a job that has not exited 5s after its SIGTERM
 * (measured), which cut short the doc flush in the graceful shutdown.
 *
 * The shutdown itself is the existing SIGTERM handler in `bin.ts`, raised on
 * this process, so every listener that already runs on a launchd stop runs
 * here too. That handler asks `shutdownExitCode()` which code to exit with.
 */

/** What a deploy restart exits with. Non-zero so KeepAlive relaunches;
 *  not 1, so the supervisor can tell it from a crash. 75 is EX_TEMPFAIL. */
export const DEPLOY_RESTART_EXIT_CODE = 75;

/** If the graceful shutdown has not exited by then, exit anyway: a hung
 *  `handle.stop()` would otherwise leave a stopped server nobody relaunches. */
export const DEPLOY_SHUTDOWN_DEADLINE_MS = 30_000;

let restartRequested = false;

/** The code the SIGTERM handler exits with: the restart code after a deploy
 *  asked for one, 0 for any other stop (so launchd leaves the job down). */
export function shutdownExitCode(): number {
  return restartRequested ? DEPLOY_RESTART_EXIT_CODE : 0;
}

export interface SelfRestartDeps {
  /** Start the graceful shutdown. Default: SIGTERM to this process. */
  stop: () => void;
  /** The backstop if the shutdown hangs. Default: `process.exit`. */
  exit: (code: number) => void;
  deadlineMs: number;
}

const defaultDeps: SelfRestartDeps = {
  stop: () => process.kill(process.pid, 'SIGTERM'),
  exit: (code) => process.exit(code),
  deadlineMs: DEPLOY_SHUTDOWN_DEADLINE_MS,
};

/**
 * The deploy's restart, `delayMs` from now. The delay lets the HTTP response
 * announcing the restart flush before the process serving it stops. Nothing
 * awaits this: the restart ends the caller.
 */
export function selfRestart(delayMs: number, deps: SelfRestartDeps = defaultDeps): () => void {
  return () => {
    const timer = setTimeout(() => {
      restartRequested = true;
      const backstop = setTimeout(() => deps.exit(DEPLOY_RESTART_EXIT_CODE), deps.deadlineMs);
      backstop.unref?.();
      deps.stop();
    }, delayMs);
    timer.unref?.();
  };
}
