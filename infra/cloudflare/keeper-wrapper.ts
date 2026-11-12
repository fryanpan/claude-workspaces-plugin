/**
 * `bun run cf:plan` on the Mac once the keeper holds the Cloudflare token
 * (`CW_KEEPER_URL` set, no `--ci`). The keeper runs terraform from its own
 * release with its own token (`packages/server/src/keeper/keeper-terraform.ts`,
 * `keeper-run.ts`); this side sends only the configs and the state bucket's
 * credential, which are Bryan's and already readable here, and reads no
 * Cloudflare token at all. The plan runs at once, with no tap, and prints.
 *
 * Nothing here applies: applies run in CI, and a change to these configs
 * reaches CI through `cf:sync-config` (`sync-config.ts`), which sends the
 * same input built here.
 */
import type { FlyResult } from '../../packages/server/src/keeper/keeper-requests.ts';
import { stateCredentials } from './credentials.ts';
import { tokenServices } from './service-tokens.ts';
import type { TfEnv } from './terraform.ts';
import { CONFIG_PATHS, type ConfigPaths, type ReadConfig } from './vars.ts';

export interface KeeperInputIo {
  read: ReadConfig;
  env: Record<string, string | undefined>;
  keychainHas: (name: string) => boolean;
  keychainRead: (name: string) => string;
}

export interface KeeperWrapperIo extends KeeperInputIo {
  /** One plan through the keeper. */
  keeper: (env: TfEnv, input: string) => Promise<FlyResult>;
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface Report {
  ok?: boolean;
  error?: string;
  refusals?: string[];
  text?: string;
  summary?: string;
  missing?: Record<string, string>;
}

export function reportOf<T = Report>(r: FlyResult): T | null {
  try {
    return JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as T;
  } catch {
    return null;
  }
}

/** The request body's input: the configs and the state credential, nothing else. */
export function keeperInput(env: TfEnv, io: KeeperInputIo): string {
  const configs: Partial<Record<keyof ConfigPaths, string>> = {};
  for (const [k, p] of Object.entries(CONFIG_PATHS[env])) {
    const text = io.read(p);
    if (text !== null) configs[k as keyof ConfigPaths] = text;
  }
  const s = stateCredentials(io);
  const bucket = io.env.CF_TFSTATE_BUCKET?.trim();
  return JSON.stringify({
    configs,
    state: { accessKeyId: s.AWS_ACCESS_KEY_ID, secretAccessKey: s.AWS_SECRET_ACCESS_KEY },
    ...(bucket ? { bucket } : {}),
  });
}

/** A run that failed: what the keeper or terraform said, never a value. */
export function failed(io: Pick<KeeperWrapperIo, 'err'>, r: FlyResult, rep: Report | null): number {
  if (r.stderr.trim()) io.err(`${r.stderr.trim()}\n`);
  for (const x of rep?.refusals ?? []) io.err(`  - ${x}\n`);
  io.err(`${rep?.error ?? 'the keeper run failed'}\n`);
  return 1;
}

/** Exit code: 0 on success, 1 on a refusal or a failed step. */
export async function runThroughKeeper(env: TfEnv, io: KeeperWrapperIo): Promise<number> {
  try {
    const planned = await io.keeper(env, keeperInput(env, io));
    const plan = reportOf(planned);
    if (planned.status !== 0 || !plan?.ok) return failed(io, planned, plan);
    io.out(plan.text ?? '');
    for (const name of Object.values(plan.missing ?? {})) {
      const s = tokenServices(name);
      io.out(
        `Service token "${name}" does not exist: cf:sync-config makes it and stores its pair in the Keychain (${s.clientId}, ${s.secret}).\n`,
      );
    }
    return 0;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
