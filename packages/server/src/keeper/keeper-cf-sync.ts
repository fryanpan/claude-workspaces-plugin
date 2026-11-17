/**
 * `cf-sync`: the gitignored Cloudflare configs (router, Access, share link)
 * reach CI, on one passkey tap. `bun run cf:sync-config`
 * (`infra/cloudflare/sync-config.ts`) sends them, with the state bucket's
 * credential, exactly as `cf:plan` does.
 *
 * **Before the hold** the keeper plans prod with those configs
 * (`keeper-run.ts plan`), so the approval page can show who each project's
 * sign-in list gains or loses (`access-changes.ts`) and which service tokens
 * the account lacks. The page lists the config secrets it writes by NAME;
 * their contents are the configs, whose effect is the sign-in list shown.
 *
 * **The tap**, in order, stopping at the first failure:
 *   1. makes each missing service token (`keeper-run.ts tokens`, which checks
 *      the account still lacks exactly those);
 *   2. writes `CF_ROUTER_CONFIG`, `CF_ACCESS_CONFIG` and `CF_SHARE_LINK_CONFIG`
 *      for each config sent, as repository secrets (`keeper-github.ts`);
 *   3. dispatches `cloudflare.yml` on main, whose apply imports the new token
 *      by id.
 * A token's pair goes back to the requester in the answer, even when a later
 * step failed, because Cloudflare returns a secret once: the requester puts it
 * in Bryan's Keychain (`infra/cloudflare/sync-config.ts`). Never to the page, a log line or a
 * file here.
 */
import {
  CONFIG_SECRETS,
  type GithubScopedApi,
  type SecretWrite,
  checkSecretWrites,
  dispatchCloudflareWorkflow,
  writeGithubSecrets,
} from './keeper-github.ts';
import type { Verdict } from './keeper-policy.ts';
import type { CloudflareResult, FlyResult } from './keeper-requests.ts';
import {
  type ConfigKey,
  type SignInChange,
  type TerraformRunner,
  parseTerraformInput,
  runReport,
  signInChanges,
  terraformStdin,
  withoutAccess,
} from './keeper-terraform.ts';

export interface CfSyncCall {
  type: 'cf-sync';
  /** JSON: `{configs, state, bucket?}`, as `parseTerraformInput` reads it. */
  input: string;
}

/** Each config's secret, as `infra/cloudflare/vars.ts` `CONFIG_ENV` names it for CI. */
export const CONFIG_SECRET: Record<ConfigKey, string> = {
  router: 'CF_ROUTER_CONFIG',
  access: 'CF_ACCESS_CONFIG',
  shareLink: 'CF_SHARE_LINK_CONFIG',
};

/** What the approval page shows and the tap does. */
export interface SyncHold {
  access: SignInChange[];
  /** The service tokens it makes: config name -> name in Cloudflare. */
  tokens: Record<string, string>;
  /** The Terraform plan's own summary, for the page. */
  plan: string;
  /** The repository secrets it writes, by name. */
  secrets: string[];
}

function secretWrites(input: unknown): SecretWrite[] {
  const parsed = parseTerraformInput(input);
  if ('error' in parsed) throw new Error(`refused: ${parsed.error}`);
  return Object.entries(parsed.configs).map(([k, value]) => ({
    target: 'repository',
    name: CONFIG_SECRET[k as ConfigKey],
    value: value as string,
  }));
}

export function classifyCfSync(input: unknown): Verdict {
  const parsed = parseTerraformInput(input);
  if ('error' in parsed) return { kind: 'refused', reason: parsed.error };
  const writes = secretWrites(input as string);
  if (!writes.length) return { kind: 'refused', reason: 'send at least one config' };
  const checked = checkSecretWrites(writes, CONFIG_SECRETS, ['repository']);
  if ('error' in checked) return { kind: 'refused', reason: checked.error };
  const names = writes.map((w) => w.name);
  return {
    kind: 'held',
    hold: 'cloudflare.sync',
    app: null,
    summary: `write ${names.join(', ')} to GitHub and start cloudflare.yml on main`,
  };
}

interface PlanReport {
  ok?: boolean;
  summary?: string;
  missing?: Record<string, string>;
  access?: unknown;
}

const failed = (error: string): FlyResult => ({
  status: 1,
  stdout: `${JSON.stringify({ ok: false, error })}\n`,
  stderr: '',
});

/**
 * Plan with the requester's configs. Answers the result to hand straight
 * back when there is nothing to approve (a failed plan), or the hold.
 */
export async function prepareSync(
  call: CfSyncCall,
  run: TerraformRunner,
): Promise<{ ran: FlyResult } | { hold: SyncHold; summary: string }> {
  const result = await run('plan', 'prod', terraformStdin(call.input, { access: true }));
  const r = runReport<PlanReport>(result);
  if (result.status !== 0 || !r?.ok) return { ran: withoutAccess(result) };
  const access = signInChanges(r.access);
  if (access === null)
    return { ran: failed('the plan did not say who it lets sign in; nothing was held') };
  const tokens = r.missing ?? {};
  const secrets = secretWrites(call.input).map((w) => w.name);
  const made = Object.values(tokens);
  return {
    hold: { access, tokens, plan: r.summary ?? '', secrets },
    summary: `write ${secrets.join(', ')} to GitHub${made.length ? `, make service tokens ${made.join(', ')},` : ''} and start cloudflare.yml on main`,
  };
}

interface Minted {
  name: string;
  id: string;
  clientId: string;
  secret: string;
}

/** The approved sync. The body names what was written; a new token's pair is for the requester. */
export async function runSync(
  call: CfSyncCall,
  hold: SyncHold,
  deps: { run: TerraformRunner; github: GithubScopedApi },
): Promise<CloudflareResult> {
  let minted: Minted[] = [];
  const answer = (status: number, body: Record<string, unknown>) => ({
    status,
    body: JSON.stringify({ ...body, minted }),
  });
  if (Object.keys(hold.tokens).length) {
    const made = await deps.run(
      'tokens',
      'prod',
      terraformStdin(call.input, { expect: hold.tokens }),
    );
    const rep = runReport<{ ok?: boolean; error?: string; minted?: Minted[] }>(made);
    minted = rep?.minted ?? [];
    if (made.status !== 0 || !rep?.ok) {
      return answer(502, {
        error: rep?.error ?? 'the service tokens could not be made; nothing was written',
      });
    }
  }
  const wrote = await writeGithubSecrets(deps.github, secretWrites(call.input));
  const w = JSON.parse(wrote.body) as Record<string, unknown>;
  if (wrote.status !== 200) return answer(wrote.status, w);
  const sent = await dispatchCloudflareWorkflow(deps.github);
  const d = JSON.parse(sent.body) as Record<string, unknown>;
  return answer(sent.status, { written: w.written, ...d });
}
