#!/usr/bin/env bun
/**
 * `bun run cf:ci-secrets plan|apply`: the `ci-secrets/` Terraform root, which
 * makes CI's Cloudflare deploy token and writes it, the state bucket's key
 * derived from it, the three gitignored configs and (when given) the Fly
 * token to GitHub Actions (README.md, "CI's credentials").
 *
 *   CLOUDFLARE_API_TOKEN  a token that can make tokens (User > API Tokens > Edit)
 *   GITHUB_TOKEN          a classic token with repo scope, which writing
 *                         Actions secrets needs
 *   FLY_API_TOKEN         optional: written to the environment's FLY_API_TOKEN
 *   CLOUDFLARE_ACCOUNT_ID optional: else the one account the token reaches
 *   CF_TFSTATE_BUCKET     optional: the state bucket the token may write
 *
 * Each value reaches terraform in its environment and nowhere else: never an
 * argument, a file this writes, or a printed line. What prints is the plan's
 * resource addresses and verbs (`plan-summary.ts`). The state is local, in
 * `state/ci-secrets/` (or `$CW_TF_WORK_DIR/ci-secrets` when the keeper runs
 * it), mode 700, because it holds the token's value and the shared R2 bucket
 * is readable by every pull request's plan. The saved plan holds the values
 * too, so it is removed when the run ends.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CI_ENVIRONMENT, CI_REPO } from '../../packages/server/src/keeper/keeper-github.ts';
import { type CloudflareApi, cloudflareApi } from '../project-machine/cloudflare.ts';
import { accountIdOf } from './ci-credentials.ts';
import { planSummary } from './plan-summary.ts';
import { CI_SECRETS_DIR, TF_DIR, type TfResult, spawnTerraform } from './terraform.ts';
import { CONFIG_PATHS, type ConfigPaths } from './vars.ts';

/** Each config's Terraform variable. */
export const CONFIG_VAR: Record<keyof ConfigPaths, string> = {
  router: 'TF_VAR_router_config',
  access: 'TF_VAR_access_config',
  shareLink: 'TF_VAR_share_link_config',
};

export type CiSecretsMode = 'plan' | 'apply';

export interface CiSecretsIo {
  env: Record<string, string | undefined>;
  /** A config relative to the repo root, or null when it is missing. */
  read: (rel: string) => string | null;
  api: (token: string) => CloudflareApi;
  /** Where the state and the saved plan go, mode 700, each file 600. */
  stateDir: string;
  /** terraform's own folder (providers, backend), beside `stateDir`. */
  dataDir: string;
  /** terraform in `ci-secrets/`, `env` added; stdout captured, stderr shown. */
  terraform: (args: string[], env: Record<string, string>) => TfResult;
  removeFile: (path: string) => void;
  out: (s: string) => void;
  err: (s: string) => void;
}

const value = (env: Record<string, string | undefined>, name: string): string =>
  env[name]?.trim() ?? '';

/** Exit code: 0 done, 1 failed, 2 bad usage. */
export async function ciSecrets(mode: string | undefined, io: CiSecretsIo): Promise<number> {
  if (mode !== 'plan' && mode !== 'apply') {
    io.err('usage: bun run cf:ci-secrets plan|apply\n');
    return 2;
  }
  const say = (s: string) => io.err(`[cf:ci-secrets] ${s}\n`);
  const missing = ['CLOUDFLARE_API_TOKEN', 'GITHUB_TOKEN'].filter((n) => value(io.env, n) === '');
  if (missing.length) {
    say(`${missing.join(' and ')} not set; nothing was run`);
    return 1;
  }
  const token = value(io.env, 'CLOUDFLARE_API_TOKEN');
  let account: string;
  try {
    account = await accountIdOf(io.api(token), io.env);
  } catch (e) {
    say(`${e instanceof Error ? e.message : String(e)}; nothing was run`);
    return 1;
  }
  const [owner, repository] = CI_REPO.split('/') as [string, string];
  const tfEnv: Record<string, string> = {
    CLOUDFLARE_API_TOKEN: token,
    GITHUB_TOKEN: value(io.env, 'GITHUB_TOKEN'),
    TF_DATA_DIR: io.dataDir,
    TF_INPUT: '0',
    TF_VAR_account_id: account,
    TF_VAR_repository_owner: owner,
    TF_VAR_repository: repository,
    TF_VAR_environment: CI_ENVIRONMENT,
  };
  const bucket = value(io.env, 'CF_TFSTATE_BUCKET');
  if (bucket) tfEnv.TF_VAR_state_bucket = bucket;
  const fly = value(io.env, 'FLY_API_TOKEN');
  if (fly) tfEnv.TF_VAR_fly_api_token = fly;
  const absent: string[] = [];
  for (const [key, rel] of Object.entries(CONFIG_PATHS.prod)) {
    const text = io.read(rel);
    if (text === null) absent.push(rel);
    else tfEnv[CONFIG_VAR[key as keyof ConfigPaths]] = text;
  }
  if (absent.length) say(`no ${absent.join(', ')}: its secret is left as GitHub holds it`);

  const init = io.terraform(
    [
      'init',
      '-input=false',
      '-lockfile=readonly',
      '-reconfigure',
      `-backend-config=path=${join(io.stateDir, 'terraform.tfstate')}`,
    ],
    tfEnv,
  );
  if (init.status !== 0) {
    say(`terraform init exited ${init.status}`);
    return 1;
  }
  const plan = join(io.stateDir, 'ci-secrets.tfplan');
  try {
    const planned = io.terraform(['plan', '-input=false', `-out=${plan}`], tfEnv);
    if (planned.status !== 0) {
      say(`terraform plan exited ${planned.status}`);
      return 1;
    }
    const shown = io.terraform(['show', '-json', plan], tfEnv);
    if (shown.status !== 0) {
      say('terraform show failed');
      return 1;
    }
    io.out(planSummary(shown.stdout, 'ci-secrets'));
    if (mode === 'plan') return 0;
    const applied = io.terraform(['apply', '-input=false', plan], tfEnv);
    if (applied.status !== 0) {
      say(`terraform apply exited ${applied.status}`);
      return 1;
    }
    io.out('Applied. GitHub holds the secrets the plan above names; no value was printed.\n');
    return 0;
  } finally {
    io.removeFile(plan);
  }
}

if (import.meta.main) {
  const work = process.env.CW_TF_WORK_DIR?.trim();
  const stateDir = work ? join(work, 'ci-secrets') : join(TF_DIR, 'state', 'ci-secrets');
  const dataDir = `${stateDir}-data`;
  for (const d of [stateDir, dataDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const repo = resolve(TF_DIR, '..', '..');
  ciSecrets(process.argv[2], {
    env: process.env,
    read: (rel) => {
      const p = join(repo, rel);
      return existsSync(p) ? readFileSync(p, 'utf8') : null;
    },
    api: (t) => cloudflareApi(t),
    stateDir,
    dataDir,
    terraform: (args, env) => spawnTerraform(CI_SECRETS_DIR, args, env, true, stateDir),
    removeFile: (p) => rmSync(p, { force: true }),
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  }).then((code) => process.exit(code));
}
