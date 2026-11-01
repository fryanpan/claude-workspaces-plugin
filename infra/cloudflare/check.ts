#!/usr/bin/env bun
/**
 * `bun run check:cloudflare-tf`: the OpenTofu config is formatted, valid, and
 * plans what `tests/plan.tftest.hcl` says against a mock provider. A member
 * of `bun run verify` and a step of CI's `gates` job.
 *
 * No token and no account: tofu runs with HOME, PATH and its own data
 * directory and nothing else from this environment, so a Cloudflare token in
 * the caller's shell cannot reach it. `init` downloads the provider pinned in
 * `.terraform.lock.hcl` (read-only) into `.terraform-check/`, which is
 * gitignored and reused on the next run.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { TF_DIR } from './tofu.ts';

const env = {
  HOME: process.env.HOME ?? '',
  PATH: process.env.PATH ?? '',
  TF_DATA_DIR: join(TF_DIR, '.terraform-check'),
  TF_IN_AUTOMATION: '1',
};

const steps: string[][] = [
  ['fmt', '-check', '-recursive', '-diff'],
  ['init', '-backend=false', '-input=false', '-lockfile=readonly'],
  ['validate', '-no-color'],
  ['test', '-no-color'],
];

for (const args of steps) {
  const r = spawnSync('tofu', args, { cwd: TF_DIR, env, stdio: 'inherit' });
  if (r.error) {
    console.error(
      `check:cloudflare-tf: could not run tofu (${r.error.message}); install OpenTofu 1.13: brew install opentofu`,
    );
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`check:cloudflare-tf: tofu ${args[0]} exited ${r.status ?? r.signal}`);
    process.exit(1);
  }
}
console.log('check:cloudflare-tf: formatted, valid, and the plan tests pass');
