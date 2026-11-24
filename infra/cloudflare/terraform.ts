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
/** CI's credentials: a root of its own, with local state (`ci-secrets.ts`). */
export const CI_SECRETS_DIR = join(TF_DIR, 'ci-secrets');
/** Apps' secrets in `cloudflare-prod`: GitHub alone, local state (`app-secrets.ts`). */
export const APP_SECRETS_DIR = join(TF_DIR, 'app-secrets');
/** Fly's CI environments and app-scoped tokens (`fly-ci/`, `fly:ci-tokens`). */
export const FLY_CI_DIR = join(TF_DIR, 'fly-ci');
/** Roots of single apps, each applied by its own workflow (`apps/<name>/`). */
export const APP_DIRS = { 'signin-test': join(TF_DIR, 'apps', 'signin-test') } as const;

export interface TfResult {
  status: number;
  stdout: string;
  /** Only when run with `capture: 'both'`; still echoed to this process's stderr. */
  stderr?: string;
}

/** Every file under `dir` to 600, the directory to 700. */
export function lockDownState(dir: string): void {
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o700);
  // A subdirectory (a TF_DATA_DIR set inside the work dir) keeps its search
  // bit: at 0600 the next terraform call cannot open what init wrote there.
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    chmodSync(join(dir, f.name), f.isDirectory() ? 0o700 : 0o600);
  }
}

/**
 * terraform, under umask 077, in `cwd`. `capture` returns stdout instead of
 * showing it. The credentials are only ever in `env`. `bin` is the binary,
 * found on PATH by default.
 */
export function spawnTerraform(
  cwd: string,
  args: string[],
  env: Record<string, string>,
  capture: boolean | 'both' = false,
  lockDir?: string,
  bin = 'terraform',
): TfResult {
  const r = spawnSync('/bin/sh', ['-c', 'umask 077 && exec "$0" "$@"', bin, ...args], {
    cwd,
    env: { ...process.env, TF_IN_AUTOMATION: '1', ...env },
    encoding: 'utf8',
    stdio: capture === 'both' ? 'pipe' : capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (lockDir) lockDownState(lockDir);
  if (r.error) throw new Error(`could not run terraform: ${r.error.message}`);
  if (capture !== 'both') return { status: r.status ?? 1, stdout: r.stdout ?? '' };
  // Read for its verdict (outputs.ts `StateRefused`), and still shown.
  if (r.stderr) process.stderr.write(r.stderr);
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
