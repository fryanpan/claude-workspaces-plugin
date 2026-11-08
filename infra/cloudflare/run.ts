#!/usr/bin/env bun
/**
 * `bun run cf:plan [prod|staging]` and `bun run cf:apply [prod|staging]`:
 * one reviewed Terraform run over an environment's Cloudflare configuration
 * (README.md). CI runs the same script with `--ci`
 * (`.github/workflows/cloudflare.yml`).
 *
 *   1. assemble the variables from the environment's configs (`vars.ts`);
 *   2. take the credentials from the environment or the Keychain
 *      (`credentials.ts`);
 *   3. read the account for the ids Terraform cannot know offline, and refuse
 *      what would repoint or shadow something this config did not make
 *      (`discover.ts`); on a local apply, make each service token the
 *      account lacks and put its pair in the Keychain (`service-tokens.ts`),
 *      which CI cannot do and so refuses;
 *   4. write the tfvars and the -backend-config file to `state/<env>/`, 600;
 *   5. `terraform init` against the R2 state, then plan, or apply (which shows
 *      the plan and asks first);
 *   6. after a local apply, print each project's CF_ACCESS_AUD and
 *      CF_ACCESS_HOST_AUDS for a server on the Mac.
 *
 * With `--ci` the plan is saved and only its summary is printed
 * (`plan-summary.ts`), and to the file CF_PLAN_SUMMARY names when set; a
 * plan takes no state lock, and apply applies that saved plan without asking. Terraform's own stdout is not
 * shown, because CI logs are public; its errors still are.
 *
 * Credentials reach terraform in the child's environment and nowhere else:
 * never an argument, a file, a variable or a printed line.
 *
 * On the Mac, once the keeper holds the Cloudflare token (`CW_KEEPER_URL`
 * set, `--ci` absent, no `CLOUDFLARE_API_TOKEN` in the environment), the
 * keeper runs terraform from its own release instead, and this process reads
 * no Cloudflare token (`keeper-wrapper.ts`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  announceToBoard,
  boardUrlFromEnv,
} from '../../packages/server/src/keeper/keeper-announce.ts';
import { keeperTerraform } from '../../packages/server/src/keeper/keeper-client.ts';
import { type CloudflareApi, cloudflareApi } from '../project-machine/cloudflare.ts';
import { keychainHas, keychainRead } from '../project-machine/mac-ops.ts';
import { tfCredentials } from './credentials.ts';
import { type KeeperWrapperIo, runThroughKeeper } from './keeper-wrapper.ts';
import { planSummary } from './plan-summary.ts';
import { audienceLines, discoverRun, initArgs, writeRunFiles } from './prepare.ts';
import {
  type MintIo,
  keychainHasService,
  mintServiceTokens,
  storeTokenInKeychain,
  tokenServices,
} from './service-tokens.ts';
import {
  TF_DIR,
  type TfEnv,
  type TfResult,
  envDir,
  isEnv,
  lockDownState,
  spawnTerraform,
  stateDir,
} from './terraform.ts';
import { CONFIG_ENV, CONFIG_PATHS, type ReadConfig } from './vars.ts';

const REPO = resolve(TF_DIR, '..', '..');

export interface WrapperIo extends Omit<MintIo, 'out' | 'err'> {
  /** A config relative to the repo root, or null when it is missing. */
  read: ReadConfig;
  env: Record<string, string | undefined>;
  keychainHas: (name: string) => boolean;
  keychainRead: (name: string) => string;
  api: (token: string) => CloudflareApi;
  /** Write a file into `state/<env>/`, readable by this user alone; returns its path. */
  writeState: (name: string, content: string) => string;
  /** The path a file in `state/<env>/` has, written or not. */
  statePath: (name: string) => string;
  /** terraform in the env's root, `env` added. `capture` returns stdout instead of showing it. */
  terraform: (args: string[], env: Record<string, string>, capture?: boolean) => TfResult;
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface WrapperOptions {
  env: TfEnv;
  ci: boolean;
}

export { audienceLines };

function step(io: WrapperIo, name: string, r: TfResult): boolean {
  if (r.status === 0) return true;
  io.err(`terraform ${name} exited ${r.status}\n`);
  return false;
}

/** Exit code: 0 on success, 1 on a refusal or a failed step. */
export async function runWrapper(
  command: 'plan' | 'apply',
  opts: WrapperOptions,
  io: WrapperIo,
): Promise<number> {
  try {
    const creds = tfCredentials(io);
    const api = io.api(creds.token);
    const found = await discoverRun(opts.env, io.read, api);
    if (!found.ok) {
      for (const r of found.refusals) io.err(`  - ${r}\n`);
      io.err('Refused before terraform ran; nothing was changed.\n');
      return 1;
    }
    const { runtime } = found;
    const missing = found.missing;
    if (Object.keys(missing).length > 0) {
      if (command === 'apply' && opts.ci) {
        for (const name of Object.values(missing)) {
          io.err(
            `  - service token "${name}" does not exist, and CI has no Keychain for its secret\n`,
          );
        }
        io.err(
          `Run bun run cf:apply ${opts.env} on the Mac once to make it. Nothing was changed.\n`,
        );
        return 1;
      }
      if (command === 'apply') {
        const minted = await mintServiceTokens(api, runtime.account_id, missing, {
          keychainHasService: io.keychainHasService,
          storeToken: io.storeToken,
          confirm: io.confirm,
          out: io.out,
          err: io.err,
        });
        if (!minted.ok) return 1;
        runtime.service_token_ids = { ...runtime.service_token_ids, ...minted.ids };
      } else if (!opts.ci) {
        for (const name of Object.values(missing)) {
          const s = tokenServices(name);
          io.out(
            `Service token "${name}" does not exist: cf:apply makes it and stores its pair in the Keychain (${s.clientId}, ${s.secret}).\n`,
          );
        }
      }
    }
    const { varFile, backend } = writeRunFiles(
      opts.env,
      found,
      io.env.CF_TFSTATE_BUCKET,
      io.writeState,
    );
    const env = creds.env;
    if (!step(io, 'init', io.terraform(initArgs(backend), env, opts.ci))) return 1;

    if (!opts.ci) {
      if (!step(io, command, io.terraform([command, varFile], env))) return 1;
      if (command === 'apply') {
        const out = io.terraform(['output', '-json', 'access'], env, true);
        if (out.status === 0)
          for (const l of audienceLines(JSON.parse(out.stdout || '{}'))) io.out(`${l}\n`);
      }
      return 0;
    }

    const planFile = io.statePath('plan.tfplan');
    // A pull request's plan holds no lock: its state credential is read-only.
    const lock = command === 'plan' ? ['-lock=false'] : ['-lock-timeout=5m'];
    const plan = ['plan', '-input=false', ...lock, varFile, `-out=${planFile}`];
    if (!step(io, 'plan', io.terraform(plan, env, true))) return 1;
    const shown = io.terraform(['show', '-json', planFile], env, true);
    if (!step(io, 'show', shown)) return 1;
    const summary = planSummary(shown.stdout, opts.env);
    io.out(summary);
    const summaryFile = io.env.CF_PLAN_SUMMARY?.trim();
    if (summaryFile) writeFileSync(summaryFile, summary);
    if (command === 'apply') {
      if (!step(io, 'apply', io.terraform(['apply', '-input=false', planFile], env, true)))
        return 1;
      io.out(`Applied to ${opts.env}.\n`);
    }
    return 0;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

/** A config from its CI stand-in when that is set, else from its file. */
export function configReader(env: Record<string, string | undefined>, repo = REPO): ReadConfig {
  const byPath = new Map<string, string>();
  for (const paths of Object.values(CONFIG_PATHS)) {
    for (const [k, p] of Object.entries(paths))
      byPath.set(p, CONFIG_ENV[k as keyof typeof CONFIG_ENV]);
  }
  return (rel) => {
    const name = byPath.get(rel);
    const fromEnv = name ? env[name] : undefined;
    if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv;
    const p = join(repo, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };
}

export function realIo(tfEnv: TfEnv): WrapperIo {
  const dir = stateDir(tfEnv);
  return {
    read: configReader(process.env),
    env: process.env,
    keychainHas,
    keychainRead,
    keychainHasService: (service) => keychainHasService(service),
    storeToken: storeTokenInKeychain,
    confirm: (question) => prompt(`${question} Only 'yes' is accepted:`)?.trim() === 'yes',
    api: (token) => cloudflareApi(token),
    writeState: (name, content) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, name);
      writeFileSync(path, content, { mode: 0o600 });
      lockDownState(dir);
      return path;
    },
    statePath: (name) => join(dir, name),
    terraform: (args, env, capture) => spawnTerraform(envDir(tfEnv), args, env, capture, dir),
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  };
}

/** Whether a run goes through the keeper rather than reading a token here. */
export function throughKeeper(env: Record<string, string | undefined>, ci: boolean): boolean {
  return !ci && !!env.CW_KEEPER_URL?.trim() && !env.CLOUDFLARE_API_TOKEN?.trim();
}

export function realKeeperWrapperIo(origin: string): KeeperWrapperIo {
  const requester = process.env.FEEDBACK_AGENT_NAME?.trim() || 'cf:apply';
  return {
    read: configReader(process.env),
    env: process.env,
    keychainHas,
    keychainRead,
    keychainHasService: (service) => keychainHasService(service),
    storeToken: storeTokenInKeychain,
    keeper: (command, env, input) =>
      keeperTerraform(origin, command, env, input, {
        requester,
        announce: announceToBoard(boardUrlFromEnv(), requester),
        onHeld: (held) => {
          process.stderr.write(`[keeper] ${held.summary} waits for Bryan's passkey\n`);
          process.stderr.write(`[keeper] approve at ${held.approveUrl}\n`);
        },
      }),
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];
  const env = args.find((a, i) => i > 0 && !a.startsWith('--')) ?? 'prod';
  if ((command !== 'plan' && command !== 'apply') || !isEnv(env)) {
    process.stderr.write(
      'usage: bun run infra/cloudflare/run.ts plan|apply [prod|staging] [--ci]\n',
    );
    process.exit(2);
  }
  const ci = args.includes('--ci');
  const run = throughKeeper(process.env, ci)
    ? runThroughKeeper(command, env, realKeeperWrapperIo(process.env.CW_KEEPER_URL?.trim() ?? ''))
    : runWrapper(command, { env, ci }, realIo(env));
  run.then((code) => process.exit(code));
}
