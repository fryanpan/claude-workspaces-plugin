/**
 * The steps every Terraform run takes before terraform starts, shared by the
 * wrapper (`run.ts`, on the Mac and in CI) and by the keeper's own run
 * (`keeper-run.ts`, which runs from the keeper's release with the keeper's
 * token). Nothing here reads the Keychain or imports anything outside this
 * folder's own config parsers, so the keeper's release, which has no
 * `node_modules`, can run it.
 *
 *   1. assemble the variables from the environment's configs (`vars.ts`) and
 *      its committed `terraform.tfvars`;
 *   2. read the account for the ids Terraform cannot know offline
 *      (`discover.ts`);
 *   3. write the tfvars and the -backend-config file, mode 600.
 */
import { join } from 'node:path';
import type { CloudflareApi } from '../project-machine/cloudflare.ts';
import { DEFAULT_STATE_BUCKET, backendConfig } from './credentials.ts';
import { type Imports, type RuntimeVars, discover } from './discover.ts';
import type { TfEnv } from './terraform.ts';
import {
  CONFIG_PATHS,
  type ReadConfig,
  type StaticVars,
  parseEnvNames,
  staticVars,
} from './vars.ts';

export type Discovered =
  | {
      ok: true;
      stat: StaticVars;
      runtime: Omit<RuntimeVars, 'imports'>;
      imports: Imports;
      /** Config name -> name in Cloudflare, for each service token the account lacks. */
      missing: Record<string, string>;
    }
  | { ok: false; refusals: string[] };

/** Steps 1 and 2. Throws on a config it cannot read. */
export async function discoverRun(
  env: TfEnv,
  read: ReadConfig,
  api: CloudflareApi,
): Promise<Discovered> {
  const stat = staticVars(read, CONFIG_PATHS[env]);
  const namesRaw = read(join('infra', 'cloudflare', 'deploys', env, 'terraform.tfvars'));
  if (namesRaw === null) throw new Error(`deploys/${env}/terraform.tfvars is missing`);
  const found = await discover(api, stat, parseEnvNames(namesRaw));
  if (!found.ok) return found;
  const { imports, ...runtime } = found.vars;
  return { ok: true, stat, runtime, imports, missing: found.missing_service_tokens };
}

/**
 * Step 3. Only prod adopts what exists; staging is made fresh or not at all.
 * The one exception is a service token, adopted by id in both
 * (`service-tokens.ts`). Returns the -var-file argument and the backend file's path.
 */
export function writeRunFiles(
  env: TfEnv,
  d: Extract<Discovered, { ok: true }>,
  bucketSetting: string | undefined,
  writeState: (name: string, content: string) => string,
): { varFile: string; backend: string } {
  const vars =
    env === 'prod' ? { ...d.stat, ...d.runtime, imports: d.imports } : { ...d.stat, ...d.runtime };
  const varFile = `-var-file=${writeState('run.tfvars.json', `${JSON.stringify(vars, null, 2)}\n`)}`;
  const bucket = bucketSetting?.trim() || DEFAULT_STATE_BUCKET;
  const backend = writeState('backend.hcl', backendConfig(env, d.runtime.account_id, bucket));
  return { varFile, backend };
}

/** `terraform init`'s arguments against the R2 state. */
export const initArgs = (backend: string): string[] => [
  'init',
  '-input=false',
  '-lockfile=readonly',
  '-reconfigure',
  `-backend-config=${backend}`,
];

/** The env lines a project server needs, from the `access` output. */
export function audienceLines(
  access: Record<string, { aud?: string; hosts?: string[] }>,
): string[] {
  const lines: string[] = [];
  for (const [label, p] of Object.entries(access)) {
    if (!p.aud) continue;
    const hostAuds = Object.fromEntries((p.hosts ?? []).map((h) => [h, p.aud]));
    lines.push(`${label}: CF_ACCESS_AUD=${p.aud}`);
    lines.push(`${label}: CF_ACCESS_HOST_AUDS='${JSON.stringify(hostAuds)}'`);
  }
  return lines;
}
