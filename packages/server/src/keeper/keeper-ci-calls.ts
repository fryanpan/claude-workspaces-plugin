/**
 * The keeper requests behind Cloudflare's CI, gathered so `keeper-requests.ts`
 * dispatches them in one place:
 *
 * - `github-secrets` (held): write the CI credentials as Actions secrets
 *   (`keeper-github.ts`). `keeper-setup`'s CI credentials step sends it.
 * - `github-status` (routine): the GitHub token's scopes and which secrets
 *   are set, names only.
 * - `cf-sync` (held, planned first): the gitignored configs to GitHub, any
 *   missing service token made, and `cloudflare.yml` started
 *   (`keeper-cf-sync.ts`).
 * - `service-token-rotate` (held): a new secret for one existing service
 *   token (`keeper-rotate.ts`).
 *
 * None is ever covered by a grant: each names what it writes, and the owner
 * reads that on the approval page.
 */
import {
  type CfSyncCall,
  type SyncHold,
  classifyCfSync,
  prepareSync,
  runSync,
} from './keeper-cf-sync.ts';
import {
  CREDENTIAL_SECRETS,
  type GithubSecretsCall,
  type GithubStatusCall,
  checkSecretWrites,
  classifyGithubSecrets,
  githubStatus,
  writeGithubSecrets,
} from './keeper-github.ts';
import type { Verdict } from './keeper-policy.ts';
import type { CloudflareResult, Executors, FlyResult } from './keeper-requests.ts';
import { type RotateCall, classifyRotate, rotateServiceToken } from './keeper-rotate.ts';

export type CiCall = GithubSecretsCall | GithubStatusCall | CfSyncCall | RotateCall;

const CI_TYPES = new Set(['github-secrets', 'github-status', 'cf-sync', 'service-token-rotate']);

export function isCiCall(call: { type: string }): call is CiCall {
  return CI_TYPES.has(call.type);
}

export function classifyCi(call: CiCall): Verdict {
  switch (call.type) {
    case 'github-secrets':
      return classifyGithubSecrets(call.secrets);
    case 'github-status':
      return {
        kind: 'routine',
        app: null,
        summary: 'read the GitHub token scopes and secret names',
      };
    case 'cf-sync':
      return classifyCfSync(call.input);
    case 'service-token-rotate':
      return classifyRotate(call.name);
  }
}

const github = (exec: Executors) => {
  if (!exec.github) throw new Error('this keeper cannot reach GitHub');
  return exec.github;
};
const terraform = (exec: Executors) => {
  if (!exec.terraform) throw new Error('this keeper cannot run terraform');
  return exec.terraform;
};

/** Before a hold: only a sync is planned first, so its page shows who it lets sign in. */
export async function prepareCi(
  call: CiCall,
  exec: Executors,
): Promise<null | { ran: FlyResult } | { hold: SyncHold; summary: string }> {
  return call.type === 'cf-sync' ? prepareSync(call, terraform(exec)) : null;
}

/** The run a routine call or an approval starts. */
export async function runCi(
  call: CiCall,
  hold: SyncHold | undefined,
  exec: Executors,
): Promise<CloudflareResult> {
  switch (call.type) {
    case 'github-status':
      return githubStatus(github(exec));
    case 'github-secrets': {
      // Checked again: what runs is what the page listed.
      const checked = checkSecretWrites(call.secrets, CREDENTIAL_SECRETS);
      if ('error' in checked) throw new Error(`refused: ${checked.error}`);
      return writeGithubSecrets(github(exec), checked);
    }
    case 'cf-sync':
      if (!hold) throw new Error('refused: a sync runs only the plan its page showed');
      return runSync(call, hold, { run: terraform(exec), github: github(exec) });
    case 'service-token-rotate':
      return rotateServiceToken(exec.cloudflare, call.name);
  }
}

/** Whose result carries a secret, so only the requester's poll reads it. */
export function resultIsSecret(call: { type: string }): boolean {
  return call.type === 'cf-sync' || call.type === 'service-token-rotate';
}

/** A request's values are dropped as soon as it can no longer run. */
export function stripCiInput(call: CiCall): CiCall {
  if (call.type === 'cf-sync') return { ...call, input: '' };
  if (call.type === 'github-secrets') {
    return { ...call, secrets: call.secrets.map((s) => ({ ...s, value: '' })) };
  }
  return call;
}
