/**
 * Names each step the prod supervisor runs before it spawns the server, with
 * how long it took, so a slow boot says where its time went.
 *
 * On 20 November a watchdog restart spent 14 minutes between launchd starting
 * the supervisor (09:59:38Z) and the server's spawn (10:13:42Z), and the log
 * held nothing for those 14 minutes. The steps in that window — the frozen
 * install, the `git describe` for the release label, the port wait and the
 * two client builds — were all silent on success, so nobody could say which
 * one took the time. Deploy restarts take 3 to 8 seconds over the same steps.
 *
 * Each step logs a start line before it runs, so a step that never returns is
 * still named by the last line in the log. A step that runs asynchronously
 * also logs a line every `heartbeatMs` while it runs; a synchronous one blocks
 * this process's timers, and the start line is what names it.
 */
import { spawn } from 'node:child_process';

export interface BootStepDeps {
  log(line: string): void;
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** How often a running async step says it is still running. */
  heartbeatMs?: number;
}

export const BOOT_STEP_HEARTBEAT_MS = 60_000;

export interface BootSteps {
  step<T>(name: string, run: () => T | Promise<T>): Promise<T>;
}

const secs = (ms: number): string => `${Math.round(ms / 1000)}s`;

export function createBootSteps(deps: BootStepDeps): BootSteps {
  const launchedAt = deps.now();
  const every = deps.heartbeatMs ?? BOOT_STEP_HEARTBEAT_MS;
  return {
    async step(name, run) {
      const started = deps.now();
      deps.log(`[supervisor] boot: ${name} started, ${secs(started - launchedAt)} after launch`);
      const beat = deps.setInterval(() => {
        deps.log(
          `[supervisor] boot: ${name} still running after ${secs(deps.now() - started)} ` +
            `(${secs(deps.now() - launchedAt)} after launch); the server is not spawned until it returns`,
        );
      }, every);
      try {
        const value = await run();
        deps.log(`[supervisor] boot: ${name} took ${secs(deps.now() - started)}`);
        return value;
      } catch (err) {
        deps.log(`[supervisor] boot: ${name} threw after ${secs(deps.now() - started)}`);
        throw err;
      } finally {
        deps.clearInterval(beat);
      }
    },
  };
}

/** The real clock and timers. */
export function supervisorBootSteps(log: (line: string) => void): BootSteps {
  return createBootSteps({
    log,
    now: Date.now,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  });
}

/**
 * Run a command with inherited stdio and resolve with its exit status (null
 * when a signal ended it). Asynchronous, unlike `spawnSync`, so the heartbeat
 * of the step that runs it keeps firing. Because a stop signal can now end
 * the supervisor mid-build, the build is killed when this process exits, so it
 * cannot keep writing a dist the next supervisor is building.
 */
export function runInherited(cmd: string, args: string[]): Promise<number | null> {
  return new Promise((resolveStatus) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    const killOnExit = (): void => {
      child.kill('SIGKILL');
    };
    process.once('exit', killOnExit);
    const done = (status: number | null): void => {
      process.off('exit', killOnExit);
      resolveStatus(status);
    };
    child.on('error', () => done(null));
    child.on('exit', (code) => done(code));
  });
}
