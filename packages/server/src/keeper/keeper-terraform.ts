/**
 * `cf:plan` and `cf:apply` through the keeper: the Cloudflare Terraform run,
 * with the keeper's token, started from the keeper's own release
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
 * **An apply is a tap, on the plan the owner reads.** At submit the keeper
 * plans first and keeps the saved plan under an id of its own. The approval
 * page shows that plan's text, and an approval applies exactly that saved
 * file; terraform refuses it if the state moved on since. The text prints
 * `(sensitive value)` for each project's sign-in list, so the run also
 * reports who each list gains or loses, which goes to the page and nowhere
 * else. Text cut at the run's limit is marked on the page, and the tap then
 * applies nothing, because the owner did not see the whole plan. A plan that changes
 * nothing runs no tap. When the account lacks a service token the config
 * names, the request instead makes exactly those tokens, listed on the page,
 * and hands their pairs back to the requester for Bryan's Keychain
 * (`service-tokens.ts`); the requester asks again for the apply, which is a
 * second tap on a plan that imports them. No apply ever creates a token
 * itself, because the provider would keep its secret in the state.
 *
 * The requester's input is the configs and the state bucket's credential; it
 * is checked here and handed to the run on stdin, never written down.
 */
import { randomBytes } from 'node:crypto';
import type { Verdict } from './keeper-policy.ts';
import type { FlyResult } from './keeper-requests.ts';

export const TF_ENVS = ['prod', 'staging'] as const;
export type TerraformEnv = (typeof TF_ENVS)[number];
export type TerraformMode = 'plan' | 'apply' | 'mint';

export interface TerraformCall {
  type: 'terraform';
  command: 'plan' | 'apply';
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

/** What a held apply will run once approved: the saved plan, or the tokens. */
export type TerraformHold =
  | {
      stage: 'apply';
      planId: string;
      plan: string;
      summary: string;
      /** For the approval page only: never the requester's answer or a log line. */
      access: SignInChange[];
      /** The plan text was cut here, so the page did not show it all and the tap applies nothing. */
      cut?: { shown: number; total: number };
    }
  | { stage: 'mint'; tokens: Record<string, string> };

/** Runs `keeper-run.ts <mode> <env>` with this stdin; the result's stdout is its report. */
export type TerraformRunner = (
  mode: TerraformMode,
  env: TerraformEnv,
  stdin: string,
) => Promise<FlyResult>;

const CONFIG_KEYS = ['router', 'access', 'shareLink'] as const;
const MAX_CONFIG = 256 * 1024;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export function classifyTerraform(command: unknown, env: unknown, input: unknown): Verdict {
  if (!TF_ENVS.includes(env as TerraformEnv)) {
    return { kind: 'refused', reason: 'env must be prod or staging' };
  }
  const parsed = parseTerraformInput(input);
  if ('error' in parsed) return { kind: 'refused', reason: parsed.error };
  const summary = `terraform ${String(command)} ${String(env)}`;
  if (command === 'plan') return { kind: 'routine', app: null, summary };
  if (command === 'apply') return { kind: 'held', hold: 'cloudflare.apply', app: null, summary };
  return { kind: 'refused', reason: 'command must be plan or apply' };
}

interface Input {
  configs: Partial<Record<(typeof CONFIG_KEYS)[number], string>>;
  state: { accessKeyId: string; secretAccessKey: string };
  bucket?: string;
}

/** The requester's input, with nothing it did not need; or why it is refused. */
export function parseTerraformInput(raw: unknown): Input | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(typeof raw === 'string' ? raw : '');
  } catch {
    return { error: 'input must be JSON' };
  }
  const o = (v ?? {}) as Record<string, unknown>;
  const c = (o.configs ?? {}) as Record<string, unknown>;
  const s = (o.state ?? {}) as Record<string, unknown>;
  const configs: Input['configs'] = {};
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

interface PlanReport {
  ok: boolean;
  text?: string;
  summary?: string;
  changes?: number;
  missing?: Record<string, string>;
  access?: SignInChange[];
  cut?: { shown: number; total: number };
}

const strings = (x: unknown): x is string[] =>
  Array.isArray(x) && x.every((v) => typeof v === 'string');

/** The run's sign-in changes, or null when the report does not hold a readable list. */
function signInChanges(x: unknown): SignInChange[] | null {
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
function withoutAccess(r: FlyResult): FlyResult {
  const lines = r.stdout.trim().split('\n');
  try {
    const last = JSON.parse(lines.pop() ?? '') as Record<string, unknown>;
    if (!('access' in last)) return r;
    const { access: _, ...rest } = last;
    return { ...r, stdout: `${[...lines, JSON.stringify(rest)].join('\n')}\n` };
  } catch {
    return r;
  }
}

function report(r: FlyResult): PlanReport | null {
  try {
    const last = r.stdout.trim().split('\n').pop() ?? '';
    return JSON.parse(last) as PlanReport;
  } catch {
    return null;
  }
}

const stdinFor = (call: TerraformCall, extra: Record<string, unknown>): string => {
  const input = parseTerraformInput(call.input);
  if ('error' in input) throw new Error(`refused: ${input.error}`);
  return JSON.stringify({ ...input, ...extra });
};

const newPlanId = (): string => randomBytes(18).toString('base64url');

/**
 * Before an apply is held: plan it and keep the plan. Answers the result to
 * hand straight back when there is nothing to approve (a failed or empty
 * plan), or what the hold will run.
 */
export async function prepareApply(
  call: TerraformCall,
  run: TerraformRunner,
): Promise<{ ran: FlyResult } | { hold: TerraformHold; summary: string }> {
  const planId = newPlanId();
  const result = await run('plan', call.env, stdinFor(call, { planId, keep: true }));
  const r = report(result);
  if (result.status !== 0 || !r?.ok) return { ran: withoutAccess(result) };
  const missing = r.missing ?? {};
  if (Object.keys(missing).length > 0) {
    // That plan would have terraform make the tokens, so the run kept no copy of it.
    return {
      hold: { stage: 'mint', tokens: missing },
      summary: `make Access service tokens for ${call.env}: ${Object.values(missing).join(', ')}`,
    };
  }
  if (!r.changes) return { ran: withoutAccess(result) };
  const access = signInChanges(r.access);
  if (access === null) {
    return {
      ran: {
        status: 1,
        stdout: `${JSON.stringify({ ok: false, error: 'the plan did not say who it lets sign in; nothing was held' })}\n`,
        stderr: '',
      },
    };
  }
  const hold: TerraformHold = {
    stage: 'apply',
    planId,
    plan: r.text ?? '',
    summary: r.summary ?? '',
    access,
    ...(r.cut ? { cut: r.cut } : {}),
  };
  return { hold, summary: `terraform apply ${call.env}` };
}

/** The run an approval or a routine plan starts. */
export function runTerraformCall(
  call: TerraformCall,
  hold: TerraformHold | undefined,
  run: TerraformRunner,
): Promise<FlyResult> {
  if (!hold) return run('plan', call.env, stdinFor(call, { planId: newPlanId(), keep: false }));
  if (hold.stage === 'mint') return run('mint', call.env, stdinFor(call, { expect: hold.tokens }));
  if (hold.cut) {
    return Promise.reject(
      new Error(
        'refused: the plan was longer than the approval page showed, so nothing was applied',
      ),
    );
  }
  return run('apply', call.env, stdinFor(call, { planId: hold.planId }));
}
