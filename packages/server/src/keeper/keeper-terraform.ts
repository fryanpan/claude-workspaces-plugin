/**
 * `cf:plan` through the keeper: the Cloudflare Terraform plan, with the
 * keeper's token, started from the keeper's own release
 * (`infra/cloudflare/keeper-run.ts`, run by `runTerraform` in
 * `keeper-exec.ts`).
 *
 * **A plan is routine.** It reads the account and the state and changes
 * nothing, and what it reads is fixed by the release's `.tf` files, not by
 * the requester. Its answer is the plan text, which holds no credential:
 * the state holds none by design (every pull request's plan can read it), and
 * the provider takes the token from its environment, so no plan stores it.
 * This matches the keeper's reads: a Cloudflare read whose answer carries no
 * credential runs without a tap.
 *
 * **Nothing here applies.** Applies run in CI, on a merge to main or a
 * dispatch of `cloudflare.yml` (`infra/cloudflare/README.md`). An `apply`
 * request is refused with a pointer there. The one keeper request that
 * reaches the account through this run's discovery to make something is
 * `cf-sync` (`keeper-cf-sync.ts`), which makes a missing service token.
 *
 * The requester's input is the configs and the state bucket's credential; it
 * is checked here and handed to the run on stdin, never written down.
 */
import type { Verdict } from './keeper-policy.ts';
import type { FlyResult } from './keeper-requests.ts';

export const TF_ENVS = ['prod', 'staging'] as const;
export type TerraformEnv = (typeof TF_ENVS)[number];
/** `tokens` makes exactly the missing service tokens a `cf-sync` approval named. */
export type TerraformMode = 'plan' | 'tokens';

export interface TerraformCall {
  type: 'terraform';
  command: 'plan';
  env: TerraformEnv;
  /** JSON: `{configs, state, bucket?}`, as `parseTerraformInput` reads it. */
  input: string;
}

/**
 * One project's Access sign-in list as the plan changes it
 * (`infra/cloudflare/access-changes.ts`). The plan text cannot show it,
 * because the module marks the list sensitive.
 */
export interface SignInChange {
  project: string;
  added: string[];
  removed: string[];
}

/** Runs `keeper-run.ts <mode> <env>` with this stdin; the result's stdout is its report. */
export type TerraformRunner = (
  mode: TerraformMode,
  env: TerraformEnv,
  stdin: string,
) => Promise<FlyResult>;

export const CONFIG_KEYS = ['router', 'access', 'shareLink'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
const MAX_CONFIG = 256 * 1024;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export const APPLY_MOVED =
  'applies run in CI now: merge a pull request touching infra/cloudflare/, or run bun run cf:sync-config for a change to the gitignored configs (infra/cloudflare/README.md)';

export function classifyTerraform(command: unknown, env: unknown, input: unknown): Verdict {
  if (command === 'apply') return { kind: 'refused', reason: APPLY_MOVED };
  if (!TF_ENVS.includes(env as TerraformEnv)) {
    return { kind: 'refused', reason: 'env must be prod or staging' };
  }
  const parsed = parseTerraformInput(input);
  if ('error' in parsed) return { kind: 'refused', reason: parsed.error };
  if (command === 'plan') return { kind: 'routine', app: null, summary: `terraform plan ${env}` };
  return { kind: 'refused', reason: 'command must be plan' };
}

export interface TerraformInput {
  configs: Partial<Record<ConfigKey, string>>;
  state: { accessKeyId: string; secretAccessKey: string };
  bucket?: string;
}

/** The requester's input, with nothing it did not need; or why it is refused. */
export function parseTerraformInput(raw: unknown): TerraformInput | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(typeof raw === 'string' ? raw : '');
  } catch {
    return { error: 'input must be JSON' };
  }
  const o = (v ?? {}) as Record<string, unknown>;
  const c = (o.configs ?? {}) as Record<string, unknown>;
  const s = (o.state ?? {}) as Record<string, unknown>;
  const configs: TerraformInput['configs'] = {};
  for (const k of CONFIG_KEYS) {
    const text = c[k];
    if (text === undefined) continue;
    if (typeof text !== 'string' || text.length > MAX_CONFIG) {
      return { error: `configs.${k} must be text under ${MAX_CONFIG} bytes` };
    }
    configs[k] = text;
  }
  const word = (x: unknown) => typeof x === 'string' && /^[A-Za-z0-9+/=_-]{8,256}$/.test(x);
  if (!word(s.accessKeyId) || !word(s.secretAccessKey)) {
    return { error: 'state needs the bucket credential: accessKeyId and secretAccessKey' };
  }
  if (o.bucket !== undefined && (typeof o.bucket !== 'string' || !BUCKET.test(o.bucket))) {
    return { error: 'bucket is not an R2 bucket name' };
  }
  return {
    configs,
    state: { accessKeyId: s.accessKeyId as string, secretAccessKey: s.secretAccessKey as string },
    ...(o.bucket ? { bucket: o.bucket as string } : {}),
  };
}

/** The last line of a run's stdout, read as its report; or null. */
export function runReport<T>(r: FlyResult): T | null {
  try {
    return JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as T;
  } catch {
    return null;
  }
}

const strings = (x: unknown): x is string[] =>
  Array.isArray(x) && x.every((v) => typeof v === 'string');

/** The run's sign-in changes, or null when the report does not hold a readable list. */
export function signInChanges(x: unknown): SignInChange[] | null {
  if (!Array.isArray(x)) return null;
  const ok = x.every((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    return typeof o.project === 'string' && strings(o.added) && strings(o.removed);
  });
  return ok ? (x as SignInChange[]) : null;
}

/**
 * The run's result with the sign-in changes taken out of its report, for an
 * answer that goes back to the requester.
 */
export function withoutAccess(r: FlyResult): FlyResult {
  const lines = r.stdout.trim().split('\n');
  try {
    const last = JSON.parse(lines.pop() ?? '') as Record<string, unknown>;
    if (!('access' in last)) return r;
    const { access: _, ...rest } = last;
    return { ...r, stdout: `${[...lines, JSON.stringify(rest)].join('\n')}\n` };
  } catch {
    // Fail closed: a report the keeper cannot read is not passed on.
    return { ...r, stdout: '' };
  }
}

/** The run's stdin: the checked input and the keeper's own fields, never the requester's. */
export function terraformStdin(input: unknown, extra: Record<string, unknown>): string {
  const parsed = parseTerraformInput(input);
  if ('error' in parsed) throw new Error(`refused: ${parsed.error}`);
  return JSON.stringify({ ...parsed, ...extra });
}

/** A routine plan: no sign-in list, which only an approval page may show. */
export function runTerraformPlan(call: TerraformCall, run: TerraformRunner): Promise<FlyResult> {
  return run('plan', call.env, terraformStdin(call.input, { access: false })).then(withoutAccess);
}
