/**
 * Running terraform in one environment's root (`deploys/<env>`), for the
 * wrapper (`run.ts`), its check (`check.ts`) and `machine:deploy`'s read of
 * the outputs (`outputs.ts`).
 *
 * The state is remote (an R2 bucket, README "State"). What stays on disk is
 * `state/<env>/`: the tfvars and the -backend-config file the wrapper writes.
 * terraform runs under umask 077, and after every run each file there is set
 * to 600 and the directory to 700. A credential is only ever in `env`.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const TF_DIR = dirname(new URL(import.meta.url).pathname);

export const ENVS = ['prod', 'staging'] as const;
export type TfEnv = (typeof ENVS)[number];

export const isEnv = (s: string | undefined): s is TfEnv => ENVS.includes(s as TfEnv);
export const envDir = (env: TfEnv): string => join(TF_DIR, 'deploys', env);
export const stateDir = (env: TfEnv): string => join(TF_DIR, 'state', env);

export interface TfResult {
  status: number;
  stdout: string;
}

/** Every file under `dir` to 600, the directory to 700. */
export function lockDownState(dir: string): void {
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o700);
  for (const f of readdirSync(dir)) chmodSync(join(dir, f), 0o600);
}

/**
 * terraform, under umask 077, in `cwd`. `capture` returns stdout instead of
 * showing it. The credentials are only ever in `env`.
 */
export function spawnTerraform(
  cwd: string,
  args: string[],
  env: Record<string, string>,
  capture = false,
  lockDir?: string,
): TfResult {
  const r = spawnSync('/bin/sh', ['-c', 'umask 077 && exec terraform "$@"', 'terraform', ...args], {
    cwd,
    env: { ...process.env, TF_IN_AUTOMATION: '1', ...env },
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (lockDir) lockDownState(lockDir);
  if (r.error) throw new Error(`could not run terraform: ${r.error.message}`);
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
}
