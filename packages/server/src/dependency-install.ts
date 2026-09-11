/**
 * `bun install --frozen-lockfile` in a deploy source, and the rule for what a
 * failed one means: nothing boots over it.
 *
 * Two callers, one runner. The deploy verb (`deploy.ts`) installs before every
 * restart it schedules and answers `install-failed` when the install does not
 * succeed. The supervisor (`scripts/serve.ts --no-watch`) installs before it
 * builds a client or spawns a server, because the manual fallback — `git pull`
 * plus `launchctl kickstart`, used when the server is down and the verb cannot
 * answer — never reaches the verb. On 2026-08-30 a PR added a package and the
 * server booted into a missing-import crash; before this module the fallback
 * could still do exactly that, and only a person remembering to run the install
 * by hand stood in the way.
 *
 * Frozen, in both places, because a deploy installs exactly what was merged:
 * an install that wants to rewrite `bun.lock` is a broken merge to refuse
 * loudly, and a write to the lockfile would also dirty the deploy source,
 * which the NEXT deploy then refuses over. Only `node_modules` moves.
 *
 * Unconditional, in both places, rather than gated on `bun.lock` changing:
 * gating misses a pull whose install failed (the next attempt sees nothing new
 * to pull) and a checkout somebody updated by hand. A no-op frozen install
 * measured ~40-60ms against ~630 packages, next to a client build of seconds,
 * so the check is cheaper than any cache that could skip it.
 */
import { spawnSync } from 'node:child_process';

/** Ceiling on `bun install`. A cold cache pulling a new package over a slow
 *  link is minutes, not seconds; a hang past this is a failed install, and a
 *  failed install is a refused restart — never a restart into missing
 *  imports. */
export const INSTALL_TIMEOUT_MS = 300_000;

/** What an install said. `detail` is the tail of bun's output on failure. */
export interface InstallResult {
  ok: boolean;
  detail?: string;
}

export type InstallRunner = () => InstallResult;

/** The real runner: `bun install --frozen-lockfile` in `cwd`, synchronously. */
export function spawnBunInstall(cwd: string): InstallRunner {
  return () => {
    try {
      const r = spawnSync('bun', ['install', '--frozen-lockfile'], {
        cwd,
        encoding: 'utf8',
        timeout: INSTALL_TIMEOUT_MS,
      });
      if (r.status === 0) return { ok: true };
      // The tail, not the head: bun prints its resolution log first and the
      // reason it stopped last.
      const tail = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.trim().slice(-500);
      return { ok: false, detail: tail || `bun install exited with ${r.status ?? 'a signal'}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  };
}

/**
 * The supervisor's gate: install, and say so loudly when it fails. Returns
 * whether the server may boot.
 *
 * The caller exits non-zero on `false` rather than serving anything. There is
 * no old server to keep running — the restart already stopped it — and the
 * checkout on disk is the new code, so booting would be the missing-import
 * crash this exists to prevent. launchd's relaunch is the retry:a transient cause (the registry, the network) clears
 * on a later attempt, and every attempt writes this line again.
 */
export function installBeforeBoot(install: InstallRunner, log: (line: string) => void): boolean {
  const result = install();
  if (result.ok) return true;
  log(
    '[supervisor] bun install --frozen-lockfile FAILED — refusing to boot the server over ' +
      'dependencies that do not match bun.lock. Nothing will serve until an install ' +
      `succeeds; launchd relaunches this supervisor to retry. bun said: ${result.detail ?? 'no detail'}`,
  );
  return false;
}
