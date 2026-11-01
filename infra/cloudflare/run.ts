#!/usr/bin/env bun
/**
 * `bun run cf:plan` and `bun run cf:apply`: one reviewed OpenTofu run over
 * every Cloudflare resource this repo configures (README.md).
 *
 *   1. assemble the variables from the gitignored local configs (`vars.ts`);
 *   2. read the Cloudflare API token from the Keychain into memory;
 *   3. read the account for the ids tofu cannot know offline, and refuse what
 *      would repoint or shadow something this config did not make
 *      (`discover.ts`);
 *   4. write those variables to `state/run.tfvars.json`, mode 600;
 *   5. `tofu init`, then `tofu plan`, or `tofu apply` (which shows the plan
 *      and asks before it changes anything);
 *   6. after an apply, print each project's `CF_ACCESS_AUD` and
 *      `CF_ACCESS_HOST_AUDS` for its server.
 *
 * The token reaches tofu as CLOUDFLARE_API_TOKEN in the child's environment
 * and nowhere else: never an argument, a file, a variable or a printed line.
 * tofu runs under umask 077 and every file in `state/` is set to 600 after
 * each run, so the state and its backups are readable by this user alone.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostAudiencesFor, parseAccessConfig } from '../access-apps/access-plan.ts';
import { type CloudflareApi, cloudflareApi } from '../project-machine/cloudflare.ts';
import { cloudflareApiToken } from '../project-machine/mac-ops.ts';
import { type RuntimeVars, discover } from './discover.ts';
import { STATE_DIR, TF_DIR, type TofuResult, lockDownState, spawnTofu } from './tofu.ts';
import { CONFIG_PATHS, type ReadConfig, type StaticVars, staticVars } from './vars.ts';

export const TFVARS = join(STATE_DIR, 'run.tfvars.json');
const REPO = resolve(TF_DIR, '..', '..');

export interface WrapperIo {
  /** A config file relative to the repo root, or null when it is missing. */
  read: ReadConfig;
  /** The API token; throws when the Keychain has none. */
  token: () => string;
  api: (token: string) => CloudflareApi;
  /** Write the tfvars, readable by this user alone. */
  writeVars: (json: string) => void;
  /** Run tofu with `env` added to its environment. `capture` returns stdout instead of showing it. */
  tofu: (args: string[], env: Record<string, string>, capture?: boolean) => TofuResult;
  out: (s: string) => void;
  err: (s: string) => void;
}

/** The whole tfvars document: what files decided, then what the account holds. */
export function tfvars(stat: StaticVars, runtime: RuntimeVars): Record<string, unknown> {
  return { ...stat, ...runtime };
}

/** The env lines each project's server needs, from the audiences an apply read back. */
export function audienceLines(
  accessRaw: string | null,
  audiences: Record<string, string>,
): string[] {
  if (accessRaw === null) return [];
  const cfg = parseAccessConfig(accessRaw);
  const lines: string[] = [];
  for (const label of Object.keys(cfg.projects)) {
    const aud = audiences[label];
    if (!aud) continue;
    lines.push(`${label}: CF_ACCESS_AUD=${aud}`);
    lines.push(
      `${label}: CF_ACCESS_HOST_AUDS='${JSON.stringify(hostAudiencesFor(cfg, [label], () => aud))}'`,
    );
  }
  return lines;
}

/** Exit code: 0 on success, 1 on a refusal or a failed step. */
export async function runWrapper(command: 'plan' | 'apply', io: WrapperIo): Promise<number> {
  try {
    const stat = staticVars(io.read);
    const token = io.token();
    const found = await discover(io.api(token), stat);
    if (!found.ok) {
      for (const r of found.refusals) io.err(`  - ${r}\n`);
      io.err('Refused before tofu ran; nothing was changed.\n');
      return 1;
    }
    io.writeVars(`${JSON.stringify(tfvars(stat, found.vars), null, 2)}\n`);
    const env = { CLOUDFLARE_API_TOKEN: token };
    const init = io.tofu(['init', '-input=false', '-lockfile=readonly'], env);
    if (init.status !== 0) {
      io.err(`tofu init exited ${init.status}\n`);
      return 1;
    }
    const varFile = `-var-file=${TFVARS}`;
    const run = io.tofu(command === 'plan' ? ['plan', varFile] : ['apply', varFile], env);
    if (run.status !== 0) {
      io.err(`tofu ${command} exited ${run.status}\n`);
      return 1;
    }
    if (command === 'apply') {
      const out = io.tofu(['output', '-json', 'access_audiences'], {}, true);
      if (out.status === 0) {
        const audiences = JSON.parse(out.stdout || '{}') as Record<string, string>;
        for (const line of audienceLines(io.read(CONFIG_PATHS.access), audiences))
          io.out(`${line}\n`);
      }
    }
    return 0;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

function realIo(): WrapperIo {
  return {
    read: (rel) => {
      const p = join(REPO, rel);
      return existsSync(p) ? readFileSync(p, 'utf8') : null;
    },
    // The deploy scripts' one reader of it: `security`, base64-decoded.
    token: cloudflareApiToken,
    api: (token) => cloudflareApi(token),
    writeVars: (json) => {
      mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(TFVARS, json, { mode: 0o600 });
      lockDownState();
    },
    tofu: spawnTofu,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  };
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command !== 'plan' && command !== 'apply') {
    process.stderr.write('usage: bun run infra/cloudflare/run.ts plan|apply\n');
    process.exit(2);
  }
  runWrapper(command, realIo()).then((code) => process.exit(code));
}
