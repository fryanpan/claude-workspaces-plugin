#!/usr/bin/env bun
/**
 * `bun run check:cloudflare-tf`: the Terraform config is formatted, every
 * root is valid, prod plans what `deploys/prod/tests/plan.tftest.hcl` says
 * against a mock provider, and `ci-secrets/tests/apply.tftest.hcl`,
 * `app-secrets/tests/apply.tftest.hcl` and each
 * app root's tests (`apps/<name>/tests/`) pass. A member
 * of `bun run verify`, a step of CI's `gates` job, and the first step of
 * `.github/workflows/cloudflare.yml`.
 *
 * No token, no account and no state: terraform runs with HOME, PATH and its
 * own data directory and nothing else from this environment, so a
 * credential in the caller's shell cannot reach it, and `init
 * -backend=false` never touches the R2 bucket. `init` downloads the
 * provider pinned in each root's `.terraform.lock.hcl` (read-only) into
 * `.terraform-check/<env>`, gitignored and reused on the next run.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { APP_DIRS, APP_SECRETS_DIR, CI_SECRETS_DIR, ENVS, TF_DIR, envDir } from './terraform.ts';

function run(cwd: string, args: string[], dataDir: string): void {
  const env = {
    HOME: process.env.HOME ?? '',
    PATH: process.env.PATH ?? '',
    TF_DATA_DIR: dataDir,
    TF_IN_AUTOMATION: '1',
  };
  const r = spawnSync('terraform', args, { cwd, env, stdio: 'inherit' });
  if (r.error) {
    console.error(
      `check:cloudflare-tf: could not run terraform (${r.error.message}); install it: brew install hashicorp/tap/terraform`,
    );
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`check:cloudflare-tf: terraform ${args[0]} exited ${r.status ?? r.signal}`);
    process.exit(1);
  }
}

const checkData = (env: string) => join(TF_DIR, '.terraform-check', env);

run(TF_DIR, ['fmt', '-check', '-recursive', '-diff'], checkData('fmt'));
for (const env of ENVS) {
  run(
    envDir(env),
    ['init', '-backend=false', '-input=false', '-lockfile=readonly'],
    checkData(env),
  );
  run(envDir(env), ['validate', '-no-color'], checkData(env));
}
run(envDir('prod'), ['test', '-no-color'], checkData('prod'));
// CI's credentials (`ci-secrets/`): its own root, local state, mock providers.
run(
  CI_SECRETS_DIR,
  ['init', '-backend=false', '-input=false', '-lockfile=readonly'],
  checkData('ci-secrets'),
);
run(CI_SECRETS_DIR, ['validate', '-no-color'], checkData('ci-secrets'));
run(CI_SECRETS_DIR, ['test', '-no-color'], checkData('ci-secrets'));
// Apps' secrets (`app-secrets/`): GitHub alone, local state, a mock provider.
run(
  APP_SECRETS_DIR,
  ['init', '-backend=false', '-input=false', '-lockfile=readonly'],
  checkData('app-secrets'),
);
run(APP_SECRETS_DIR, ['validate', '-no-color'], checkData('app-secrets'));
run(APP_SECRETS_DIR, ['test', '-no-color'], checkData('app-secrets'));
// Each app's own root (`apps/<name>/`): applied by its own workflow.
for (const [name, dir] of Object.entries(APP_DIRS)) {
  run(dir, ['init', '-backend=false', '-input=false', '-lockfile=readonly'], checkData(name));
  run(dir, ['validate', '-no-color'], checkData(name));
  run(dir, ['test', '-no-color'], checkData(name));
}
console.log('check:cloudflare-tf: formatted, every root valid, and the plan tests pass');
