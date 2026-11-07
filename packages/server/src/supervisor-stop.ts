/**
 * What the supervisor exits with when a stop signal reaches it.
 *
 * Under launchd the answer is never 0. The plist's KeepAlive
 * { SuccessfulExit: false, Crashed: true } does not relaunch a clean exit, so
 * on 6 Nov a SIGTERM nobody meant left prod down until a person ran kickstart.
 * Nothing inside the process can name the sender. It does not have to: a
 * `bootout` and a machine shutdown stop the job whatever the exit code was,
 * and `kickstart -k` starts it anyway. So every stop exits non-zero and launchd
 * decides. 128 + the signal number is the shell's convention, so a stray stop
 * reads `last exit code = 143` in `launchctl print`, distinct from a crash's 1.
 *
 * Without `--no-watch` this is a developer's terminal, where Ctrl+C means stop
 * and exit 0 is the truth.
 *
 * This file is imported before `bun install` runs: Node builtins only.
 */
import { constants } from 'node:os';

export const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
export type StopSignal = (typeof STOP_SIGNALS)[number];

export function stopExitCode(signal: StopSignal, underLaunchd: boolean): number {
  return underLaunchd ? 128 + constants.signals[signal] : 0;
}

/** The log line for a stop. Null when the exit is 0: Ctrl+C needs no line. */
export function stopLogLine(signal: StopSignal, code: number): string | null {
  if (code === 0) return null;
  return `[supervisor] stop signal ${signal} — exiting ${code} so launchd relaunches; a bootout or shutdown stays stopped`;
}
