/**
 * Running tofu in this directory, for the wrapper (`run.ts`), its check
 * (`check.ts`) and `machine:deploy`'s read of the tunnel ids
 * (`infra/project-machine/tunnel.ts`).
 *
 * tofu runs under umask 077, and after every run each file in `state/` is
 * set to 600 and the directory to 700, so the state, its backups and the
 * tfvars are readable by this user alone. A token is only ever in `env`.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const TF_DIR = dirname(new URL(import.meta.url).pathname);
export const STATE_DIR = join(TF_DIR, 'state');

export interface TofuResult {
  status: number;
  stdout: string;
}

/** Every file under `state/` to 600, the directory to 700. */
export function lockDownState(dir = STATE_DIR): void {
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o700);
  for (const f of readdirSync(dir)) chmodSync(join(dir, f), 0o600);
}

/** tofu, under umask 077, in this directory. The token is only ever in `env`. */
export function spawnTofu(
  args: string[],
  env: Record<string, string>,
  capture = false,
  stateDir = STATE_DIR,
): TofuResult {
  const r = spawnSync('/bin/sh', ['-c', 'umask 077 && exec tofu "$@"', 'tofu', ...args], {
    cwd: TF_DIR,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  lockDownState(stateDir);
  if (r.error) throw new Error(`could not run tofu: ${r.error.message}`);
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
}
