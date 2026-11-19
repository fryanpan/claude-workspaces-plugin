#!/usr/bin/env bun
/**
 * `bun run cf:plan [prod|staging]`: one Terraform plan over an environment's
 * Cloudflare configuration (README.md). CI runs the same script with `--ci`
 * (`.github/workflows/cloudflare.yml`), and only CI applies: `cf:apply`
 * without `--ci` prints where applies happen now and changes nothing
 * (`APPLY_POINTER`).
 *
 *   1. assemble the variables from the environment's configs (`vars.ts`);
 *   2. take the credentials from the environment or the Keychain
 *      (`credentials.ts`);
 *   3. read the account for the ids Terraform cannot know offline, and refuse
 *      what would repoint or shadow something this config did not make
 *      (`discover.ts`);
 *   4. CI's apply only: make each service token the config names and the
 *      account lacks (`service-tokens.ts`), seal its pair to the Mac
 *      (CW_HANDOFF_OUT, `infra/handoff/`) and read the account again, so the
 *      apply adopts it by id;
 *   5. write the tfvars and the -backend-config file to `state/<env>/`, 600;
 *   6. `terraform init` against the R2 state, then plan, or (CI) apply.
 *
 * With `--ci` the plan is saved and only its summary is printed
 * (`plan-summary.ts`), and to the file CF_PLAN_SUMMARY names when set; a
 * plan takes no state lock, and apply applies that saved plan without asking. Terraform's own stdout is not
 * shown, because CI logs are public; its errors still are.
 *
 * Credentials reach terraform in the child's environment and nowhere else:
 * never an argument, a file, a variable or a printed line. The Cloudflare
 * token comes from the environment only: since the keeper retired the Mac
 * holds none, and a pull request's plan is the way to see a change
 * (docs/process/keeper.md, "Retired").
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type HandoffSink, macSinkFromEnv, recipientKey } from '../handoff/items.ts';
import { type CloudflareApi, cloudflareApi } from '../project-machine/cloudflare.ts';
import { keychainHas, keychainRead } from '../project-machine/mac-ops.ts';
import { tfCredentials } from './credentials.ts';
import { planSummary } from './plan-summary.ts';
import { audienceLines, discoverRun, initArgs, writeRunFiles } from './prepare.ts';
import { mintServiceTokens, tokenServices } from './service-tokens.ts';
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

/** What `cf:apply` on the Mac prints instead of applying. */
export const APPLY_POINTER = [
  'cf:apply no longer runs here: Cloudflare applies run in CI, with nobody at a terminal.',
  '  - A change to infra/cloudflare/ or either Worker applies when its pull request merges to main',
  '    (.github/workflows/cloudflare.yml, job apply).',
  '  - A change to the gitignored routing configs (router.local.json, wrangler.local.toml):',
  '    bun run cf:sync-config writes them to GitHub and starts cloudflare.yml on main.',
  '  - A new service token: name it in the config; the apply makes it and seals its pair',
  '    to this Mac, and bun run handoff:pull stores it in the Keychain.',
  '  - To see what would change first: bun run cf:plan.',
  'Nothing was changed.',
  '',
].join('\n');

export interface WrapperIo {
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
  /** CI's apply: where a new service token's pair goes, sealed to the Mac. */
  macSink: HandoffSink | null;
  /** The Mac's public handoff key. */
  macKey: () => string;
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
  if (command === 'apply' && !opts.ci) {
    io.err(APPLY_POINTER);
    return 1;
  }
  try {
    const creds = tfCredentials(io);
    const api = io.api(creds.token);
    let found = await discoverRun(opts.env, io.read, api);
    if (!found.ok) {
      for (const r of found.refusals) io.err(`  - ${r}\n`);
      io.err('Refused before terraform ran; nothing was changed.\n');
      return 1;
    }
    const missing = found.missing;
    if (command === 'plan' && !opts.ci) {
      for (const name of Object.values(missing)) {
        const s = tokenServices(name);
        io.out(
          `Service token "${name}" does not exist: the apply on main makes it and seals its pair to the Mac, and bun run handoff:pull stores it (${s.clientId}, ${s.secret}).\n`,
        );
      }
    }
    if (command === 'apply' && Object.keys(missing).length > 0) {
      if (!(await mintMissing(found.runtime.account_id, missing, api, io))) return 1;
      found = await discoverRun(opts.env, io.read, api);
      if (!found.ok || Object.keys(found.missing).length > 0) {
        io.err('A service token made here is not in the account yet; nothing else was changed.\n');
        return 1;
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

    if (!opts.ci) return step(io, 'plan', io.terraform(['plan', varFile], env)) ? 0 : 1;

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

/**
 * Make the missing service tokens and seal each pair to the Mac at once, so a
 * later failure cannot lose a secret Cloudflare sends only to this call.
 * True when every token was made and sealed.
 */
async function mintMissing(
  accountId: string,
  missing: Record<string, string>,
  api: CloudflareApi,
  io: WrapperIo,
): Promise<boolean> {
  const sink = io.macSink;
  if (!sink) {
    io.err(
      `  - ${Object.values(missing).join(', ')}: a new service token is made only where its pair can be sealed to the Mac (CW_HANDOFF_OUT, cloudflare.yml)\nNothing was changed.\n`,
    );
    return false;
  }
  // Before anything is made: what is made must be sealable.
  const key = io.macKey();
  const nameOf = new Map(Object.values(missing).map((n) => [tokenServices(n).secret, n]));
  const minted = await mintServiceTokens(api, accountId, missing, {
    keychainHasService: () => false,
    storeToken: (services, clientId, secret) =>
      sink.add({
        kind: 'service-token',
        name: nameOf.get(services.secret) ?? '',
        clientId,
        secret,
        replace: false,
      }),
    confirm: () => true,
    // Its lines speak of the Keychain; here the pair goes to the Mac.
    out: () => {},
    err: io.err,
  });
  if (sink.flush(key)) {
    for (const line of sink.describe()) io.out(`Made and sealed to the Mac: ${line}\n`);
    io.out('The Mac stores each pair on its next bun run handoff:pull.\n');
  }
  return minted.ok;
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
    macSink: macSinkFromEnv(process.env),
    macKey: () => recipientKey('mac'),
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
  runWrapper(command, { env, ci }, realIo(env)).then((code) => process.exit(code));
}
