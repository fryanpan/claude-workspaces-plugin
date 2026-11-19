#!/usr/bin/env bun
/**
 * `bun run cf:app-secrets plan|apply`: the `app-secrets/` Terraform root,
 * which writes the secrets apps' workflows read to the GitHub Environment
 * `cloudflare-prod` (README.md, "Apps' secrets").
 *
 *   GITHUB_TOKEN  a classic token with repo scope, which writing Actions
 *                 secrets needs. Nothing else: no Cloudflare token.
 *
 * Each secret in `APP_SECRETS` comes from, in order: the environment variable
 * of the same name; the Keychain item `service` stored plain (account
 * claude-workspaces); the board's secret card for `service`, which stores it
 * base64 under `claude-workspaces-secret.<service>` (`core/secret-name.ts`).
 *
 * Each value reaches terraform in its environment (`TF_VAR_secrets`, JSON)
 * and nowhere else: never an argument, a file this writes, or a printed
 * line. What prints is the plan's resource addresses and verbs, and the
 * names of secrets with no value. The state holds the values, so it is
 * local, in `~/.local/state/claude-workspaces/app-secrets/` (or
 * `$CW_TF_WORK_DIR/app-secrets`), outside every checkout, mode 700. The saved
 * plan holds them too, so it is removed when the run ends and again when the
 * next one starts.
 *
 * An apply whose plan deletes anything is refused unless `--drop` is given: a
 * value missing from this run would otherwise delete the secret an earlier
 * apply wrote.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SECRET_ACCOUNT, storedSecretService } from '../../packages/core/src/secret-name.ts';
import { CI_ENVIRONMENT, CI_REPO } from '../../packages/server/src/provisioning/github-ci.ts';
import { deletions } from './ci-secrets.ts';
import { planSummary } from './plan-summary.ts';
import { APP_SECRETS_DIR, type TfResult, spawnTerraform } from './terraform.ts';

/**
 * Every secret an app's workflow reads from `cloudflare-prod`. `name` is the
 * GitHub secret and the environment variable; `service` the Keychain name,
 * plain or as a secret card. A new app adds its rows here.
 */
export const APP_SECRETS = [
  // signin-test.yml (infra/signin-test/README.md).
  { name: 'RESEND_API_KEY', service: 'resend-api-key' },
  { name: 'SIGNIN_TEST_GOOGLE_CLIENT_ID', service: 'signin-test-google-client-id' },
  { name: 'SIGNIN_TEST_GOOGLE_CLIENT_SECRET', service: 'signin-test-google-client-secret' },
] as const;

export interface AppSecretsIo {
  env: Record<string, string | undefined>;
  /** A Keychain item's value under account claude-workspaces, as stored, or null. */
  keychain: (service: string) => string | null;
  /** Where the state and the saved plan go, mode 700, each file 600. */
  stateDir: string;
  /** terraform's own folder (providers, backend), beside `stateDir`. */
  dataDir: string;
  /** terraform in `app-secrets/`, `env` added; stdout captured, stderr shown. */
  terraform: (args: string[], env: Record<string, string>) => TfResult;
  removeFile: (path: string) => void;
  out: (s: string) => void;
  err: (s: string) => void;
}

/** A secret card's stored form decoded, or null when it decodes to nothing. */
export function decodeCard(stored: string): string | null {
  // Not `atob`: it throws on a character outside the alphabet, and the
  // message could quote what it was given.
  const decoded = Buffer.from(stored.trim(), 'base64').toString('utf8').trim();
  return decoded || null;
}

/** Where a value was found, for the run's one line per secret. Never the value. */
export type Source = 'environment' | 'keychain' | 'secret card';

/** One secret's value and where it came from, or null when none of the three has it. */
export function resolveSecret(
  item: { name: string; service: string },
  io: Pick<AppSecretsIo, 'env' | 'keychain'>,
): { value: string; source: Source } | null {
  const fromEnv = io.env[item.name]?.trim();
  if (fromEnv) return { value: fromEnv, source: 'environment' };
  const plain = io.keychain(item.service)?.trim();
  if (plain) return { value: plain, source: 'keychain' };
  const card = io.keychain(storedSecretService(item.service));
  const decoded = card ? decodeCard(card) : null;
  if (decoded) return { value: decoded, source: 'secret card' };
  return null;
}

export const USAGE = 'usage: bun run cf:app-secrets plan|apply [--drop]\n';

/** Exit code: 0 done, 1 failed or refused, 2 bad usage. */
export async function appSecrets(argv: string[], io: AppSecretsIo): Promise<number> {
  const [mode, ...flags] = argv;
  if ((mode !== 'plan' && mode !== 'apply') || flags.some((f) => f !== '--drop')) {
    io.err(USAGE);
    return 2;
  }
  const drop = flags.includes('--drop');
  const say = (s: string) => io.err(`[cf:app-secrets] ${s}\n`);
  const githubToken = io.env.GITHUB_TOKEN?.trim() ?? '';
  if (!githubToken) {
    say('GITHUB_TOKEN not set; nothing was run');
    return 1;
  }
  const secrets: Record<string, string> = {};
  for (const item of APP_SECRETS) {
    const found = resolveSecret(item, io);
    if (found) {
      secrets[item.name] = found.value;
      say(`${item.name}: from the ${found.source}`);
    } else {
      say(
        `${item.name}: not in the environment, the Keychain item ${item.service} or its secret card; this run does not write it, and deletes one an earlier apply wrote (apply refuses that without --drop)`,
      );
    }
  }
  const [owner, repository] = CI_REPO.split('/') as [string, string];
  const tfEnv: Record<string, string> = {
    GITHUB_TOKEN: githubToken,
    TF_DATA_DIR: io.dataDir,
    TF_INPUT: '0',
    TF_VAR_repository_owner: owner,
    TF_VAR_repository: repository,
    TF_VAR_environment: CI_ENVIRONMENT,
    TF_VAR_secrets: JSON.stringify(secrets),
  };

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
  const plan = join(io.stateDir, 'app-secrets.tfplan');
  // A run that was killed left its plan, which holds the values.
  io.removeFile(plan);
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
    io.out(planSummary(shown.stdout, 'app-secrets'));
    if (mode === 'plan') return 0;
    const gone = deletions(shown.stdout);
    if (gone.length && !drop) {
      say(
        `the plan deletes ${gone.join(', ')}: a value this run could not find. Supply it, or pass --drop to delete on purpose; nothing was applied`,
      );
      return 1;
    }
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

/**
 * `security find-generic-password -w` on macOS, account claude-workspaces.
 * The service name is the only argument that varies; the value comes back on
 * stdout to this process alone.
 */
export function readKeychain(
  service: string,
  bin = 'security',
  platform: string = process.platform,
): string | null {
  if (platform !== 'darwin') return null;
  const r = spawnSync(bin, ['find-generic-password', '-a', SECRET_ACCOUNT, '-s', service, '-w'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.status !== 0) return null;
  const out = (r.stdout ?? '').replace(/\r?\n$/, '');
  return out === '' ? null : out;
}

if (import.meta.main) {
  // Outside every checkout: a worktree is deleted when its branch is done, and
  // a lost state makes the next apply recreate what GitHub already holds.
  const work = process.env.CW_TF_WORK_DIR?.trim();
  const stateDir = work
    ? join(work, 'app-secrets')
    : join(homedir(), '.local', 'state', 'claude-workspaces', 'app-secrets');
  const dataDir = `${stateDir}-data`;
  for (const d of [stateDir, dataDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  appSecrets(process.argv.slice(2), {
    env: process.env,
    keychain: (service) => readKeychain(service),
    stateDir,
    dataDir,
    terraform: (args, env) => spawnTerraform(APP_SECRETS_DIR, args, env, true, stateDir),
    removeFile: (p) => rmSync(p, { force: true }),
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  }).then((code) => process.exit(code));
}
