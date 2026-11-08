#!/usr/bin/env bun
/**
 * The keeper's own Terraform run. The keeper (`packages/server/src/keeper/`)
 * starts this file from ITS release, as its own macOS user, with the
 * Cloudflare token in the environment and nowhere else, so `cf:plan` and
 * `cf:apply` on the Mac work without any agent's user holding that token.
 * What runs is pinned: this file, the `.tf` files and the provider lock in
 * the release's `infra/cloudflare/`, and the keeper's fixed terraform binary.
 * An agent can write Bryan's checkout, never the release.
 *
 *   keeper-run.ts plan  <env>   discover, write the tfvars, init, plan to a saved
 *                               file, and report its text, its summary and the
 *                               service tokens the account lacks
 *   keeper-run.ts apply <env>   init, apply the saved plan the keeper names, and
 *                               report the Access audiences
 *   keeper-run.ts mint  <env>   make exactly the missing service tokens the keeper
 *                               names and report their pairs, for the requester to
 *                               put in Bryan's Keychain (`service-tokens.ts`)
 *
 * stdin is one JSON object the keeper writes (`KeeperRunInput`): the configs
 * and the state bucket's credential the requester sent, and the plan id or
 * the expected token names the keeper chose. stdout is one JSON line. The
 * environment is the keeper's, built from nothing: `CLOUDFLARE_API_TOKEN`,
 * `CW_TERRAFORM_BIN` (the fixed binary), `CW_TF_WORK_DIR` (a folder only the
 * keeper's user can open), `HOME` and `PATH`.
 *
 * The token reaches terraform in its environment and Cloudflare in a header,
 * and nothing else: never an argument, a file, the plan text or stdout. The
 * provider takes it from `CLOUDFLARE_API_TOKEN`, so neither a saved plan nor
 * the state holds it. Terraform reads a CLI config that allows direct
 * provider downloads only, checked against the release's lock file, so no
 * mirror or override folder can swap the provider.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type CloudflareApi, cloudflareApi } from '../project-machine/cloudflare.ts';
import { planSummary, verbOf } from './plan-summary.ts';
import { audienceLines, discoverRun, initArgs, writeRunFiles } from './prepare.ts';
import { type TokenServices, mintServiceTokens } from './service-tokens.ts';
import { TF_DIR, type TfEnv, type TfResult, envDir, isEnv, lockDownState } from './terraform.ts';
import { CONFIG_PATHS, type ConfigPaths } from './vars.ts';

export type KeeperRunMode = 'plan' | 'apply' | 'mint';

export interface KeeperRunInput {
  /** Each config's text, keyed as `CONFIG_PATHS` keys them. */
  configs: Partial<Record<keyof ConfigPaths, string>>;
  /** The state bucket's credential, as `cloudflare-r2-tfstate` holds it. */
  state: { accessKeyId: string; secretAccessKey: string };
  bucket?: string;
  /** Plan: the saved plan's id. Apply: the plan to apply. Chosen by the keeper. */
  planId?: string;
  /** Plan: keep the saved plan for a later apply, unless it would make a service token. */
  keep?: boolean;
  /** Mint: the tokens the owner approved, config name -> name in Cloudflare. */
  expect?: Record<string, string>;
}

export interface KeeperRunIo {
  token: string;
  /** A file in the release, relative to its root, or null. */
  readRelease: (rel: string) => string | null;
  api: (token: string) => CloudflareApi;
  /** Write a file into the env's work folder, mode 600; returns its path. */
  writeState: (name: string, content: string) => string;
  statePath: (name: string) => string;
  removeState: (name: string) => void;
  /** terraform in the env's root, `env` added; stdout returned, stderr passed on. */
  terraform: (args: string[], env: Record<string, string>) => TfResult;
}

/** One new service token: where its pair goes in the Keychain, and the pair. */
export interface MintedToken {
  name: string;
  id: string;
  services: TokenServices;
  clientId: string;
  secret: string;
}

/** What one run reports on stdout. */
export type KeeperRunReport =
  | {
      ok: true;
      mode: 'plan';
      text: string;
      summary: string;
      changes: number;
      missing: Record<string, string>;
    }
  | { ok: true; mode: 'apply'; text: string; audiences: string[] }
  | { ok: true; mode: 'mint'; minted: MintedToken[] }
  | { ok: false; error: string; refusals?: string[] };

export const PLAN_ID = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_TEXT = 512 * 1024;

const planFile = (id: string) => `plan-${id}.tfplan`;

/** How many resources a `terraform show -json` plan changes. */
export function changeCount(showJson: string): number {
  const plan = JSON.parse(showJson) as { resource_changes?: Parameters<typeof verbOf>[0][] };
  return (plan.resource_changes ?? []).filter((rc) => verbOf(rc) !== null).length;
}

function fail(error: string, refusals?: string[]): KeeperRunReport {
  return refusals ? { ok: false, error, refusals } : { ok: false, error };
}

export async function keeperRun(
  mode: KeeperRunMode,
  env: TfEnv,
  input: KeeperRunInput,
  io: KeeperRunIo,
): Promise<KeeperRunReport> {
  const tfEnv = {
    CLOUDFLARE_API_TOKEN: io.token,
    AWS_ACCESS_KEY_ID: input.state.accessKeyId,
    AWS_SECRET_ACCESS_KEY: input.state.secretAccessKey,
  };
  const paths = CONFIG_PATHS[env];
  // The configs are the requester's; the committed tfvars are the release's.
  const read = (rel: string): string | null => {
    for (const [k, p] of Object.entries(paths)) {
      if (p === rel) return input.configs[k as keyof ConfigPaths] ?? null;
    }
    return io.readRelease(rel);
  };
  const api = io.api(io.token);
  const found = await discoverRun(env, read, api);
  if (!found.ok) return fail('refused before terraform ran; nothing was changed', found.refusals);

  if (mode === 'mint') {
    const want = input.expect ?? {};
    const same =
      Object.keys(want).length > 0 &&
      JSON.stringify(Object.entries(found.missing).sort()) ===
        JSON.stringify(Object.entries(want).sort());
    if (!same) {
      return fail('the missing service tokens changed since this was approved; nothing was made');
    }
    const stored: Array<{ services: TokenServices; clientId: string; secret: string }> = [];
    const errors: string[] = [];
    const minted = await mintServiceTokens(api, found.runtime.account_id, want, {
      keychainHasService: () => false,
      storeToken: (services, clientId, secret) => stored.push({ services, clientId, secret }),
      confirm: () => true,
      out: () => {},
      err: (s) => errors.push(s.trim()),
    });
    if (!minted.ok) return fail(errors.join(' ') || 'a service token could not be made');
    return {
      ok: true,
      mode: 'mint',
      minted: Object.entries(want).map(([key, name], i) => {
        const s = stored[i] as (typeof stored)[number];
        return { name, id: minted.ids[key] ?? '', ...s };
      }),
    };
  }

  const id = input.planId ?? '';
  if (!PLAN_ID.test(id)) return fail('the keeper named no plan id');
  const { varFile, backend } = writeRunFiles(env, found, input.bucket, io.writeState);
  const init = io.terraform(initArgs(backend), tfEnv);
  if (init.status !== 0) return fail(`terraform init exited ${init.status}`);
  const file = io.statePath(planFile(id));

  if (mode === 'apply') {
    const applied = io.terraform(['apply', '-input=false', '-lock-timeout=5m', file], tfEnv);
    io.removeState(planFile(id));
    if (applied.status !== 0) return fail(`terraform apply exited ${applied.status}`);
    const out = io.terraform(['output', '-json', 'access'], tfEnv);
    const audiences = out.status === 0 ? audienceLines(JSON.parse(out.stdout || '{}')) : [];
    return { ok: true, mode: 'apply', text: applied.stdout.slice(0, MAX_TEXT), audiences };
  }

  // No lock: a plan changes nothing, and an apply of the saved plan takes the
  // lock and refuses a plan the state has moved past.
  const plan = ['plan', '-input=false', '-lock=false', varFile, `-out=${file}`];
  try {
    const planned = io.terraform(plan, tfEnv);
    if (planned.status !== 0) return fail(`terraform plan exited ${planned.status}`);
    const json = io.terraform(['show', '-json', file], tfEnv);
    const text = io.terraform(['show', '-no-color', file], tfEnv);
    if (json.status !== 0 || text.status !== 0) return fail('terraform show failed');
    return {
      ok: true,
      mode: 'plan',
      text: text.stdout.slice(0, MAX_TEXT),
      summary: planSummary(json.stdout, env),
      changes: changeCount(json.stdout),
      missing: found.missing,
    };
  } finally {
    // A plan that would make a service token is never applied (`service-tokens.ts`).
    if (!input.keep || Object.keys(found.missing).length > 0) io.removeState(planFile(id));
  }
}

/** A saved plan nobody applied is removed after this long. */
const PLAN_MAX_AGE_MS = 3 * 60 * 60_000;

export function realKeeperIo(env: TfEnv, workRoot: string, terraformBin: string): KeeperRunIo {
  // Flat, because every file in it is set to 600 after each run; terraform's
  // own folder (providers, backend) sits beside it.
  const dir = join(workRoot, env);
  const data = join(workRoot, `${env}-data`);
  for (const d of [dir, data]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const rc = join(workRoot, 'terraformrc');
  writeFileSync(rc, 'provider_installation {\n  direct {}\n}\n', { mode: 0o600 });
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f.endsWith('.tfplan') && Date.now() - statSync(p).mtimeMs > PLAN_MAX_AGE_MS) rmSync(p);
  }
  const root = resolve(TF_DIR, '..', '..');
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? '';
  return {
    token,
    readRelease: (rel) => {
      try {
        return readFileSync(join(root, rel), 'utf8');
      } catch {
        return null;
      }
    },
    // Cloudflare's API and nothing else hears the token.
    api: (t) =>
      cloudflareApi(t, {
        fetchImpl: ((url: string, init?: RequestInit) => {
          if (new URL(url).host !== 'api.cloudflare.com') throw new Error('not Cloudflare');
          return fetch(url, init);
        }) as typeof fetch,
      }),
    writeState: (name, content) => {
      const p = join(dir, name);
      writeFileSync(p, content, { mode: 0o600 });
      lockDownState(dir);
      return p;
    },
    statePath: (name) => join(dir, name),
    removeState: (name) => rmSync(join(dir, name), { force: true }),
    terraform: (args, extra) => {
      const r = Bun.spawnSync([terraformBin, ...args], {
        cwd: envDir(env),
        env: {
          PATH: '/usr/bin:/bin',
          HOME: process.env.HOME ?? workRoot,
          TF_IN_AUTOMATION: '1',
          TF_INPUT: '0',
          CHECKPOINT_DISABLE: '1',
          TF_DATA_DIR: data,
          TF_CLI_CONFIG_FILE: rc,
          ...extra,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      lockDownState(dir);
      process.stderr.write(r.stderr.toString());
      return { status: r.exitCode ?? 1, stdout: r.stdout.toString() };
    },
  };
}

if (import.meta.main) {
  const [mode, env] = process.argv.slice(2);
  const say = (r: KeeperRunReport) => process.stdout.write(`${JSON.stringify(r)}\n`);
  const bin = process.env.CW_TERRAFORM_BIN?.trim() ?? '';
  const work = process.env.CW_TF_WORK_DIR?.trim() ?? '';
  if ((mode !== 'plan' && mode !== 'apply' && mode !== 'mint') || !isEnv(env) || !bin || !work) {
    say(fail('usage: keeper-run.ts plan|apply|mint prod|staging, from the keeper'));
    process.exit(2);
  }
  try {
    const input = JSON.parse(await Bun.stdin.text()) as KeeperRunInput;
    const report = await keeperRun(mode, env, input, realKeeperIo(env, work, bin));
    say(report);
    process.exit(report.ok ? 0 : 1);
  } catch (e) {
    // Never a raw stack: a message names a path or a status, not a value.
    say(fail(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }
}
