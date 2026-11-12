/**
 * The keeper's writes to this repository's GitHub Actions settings, made with
 * the GitHub token only the keeper holds (`github-token`, the classic token
 * imported from `cw-github-push-token`): Actions secrets for Cloudflare's CI
 * (`.github/workflows/cloudflare.yml`), and a dispatch of that workflow.
 *
 * **`github-secrets`** writes the CI credentials `keeper-setup` makes: the
 * apply token and the read-write R2 key to the environment `cloudflare-prod`,
 * the read-only token and R2 key to the repository. Always a passkey tap,
 * and the approval page lists each secret's NAME and where it goes, never a
 * value. Only the three credential names are accepted here; the three config
 * secrets are written by `cf-sync` (`keeper-cf-sync.ts`), whose page shows
 * who each config lets sign in, because a config secret IS who may sign in.
 *
 * **`github-status`** is routine: the token's scope names and the names of
 * the secrets already set. Neither is a credential.
 *
 * Each value is sealed to the target's public key (`keeper-sealed-box.ts`)
 * before it leaves the keeper, so the request body carries no value GitHub
 * itself did not ask for. Before any write the token's scopes are read from
 * `X-OAuth-Scopes`; without `repo` (the scope GitHub asks of a classic token
 * for Actions secrets and for a workflow dispatch) nothing is written. A
 * fine-grained token sends no such header and is refused the same way.
 *
 * The repository is fixed here rather than named by the requester: a secret
 * the keeper writes goes to this repository and nowhere else.
 */
import type { Verdict } from './keeper-policy.ts';
import { sealedBox } from './keeper-sealed-box.ts';

export const CI_REPO = 'fryanpan/claude-workspaces-plugin';
export const CI_ENVIRONMENT = 'cloudflare-prod';
export const CI_WORKFLOW = 'cloudflare.yml';
export const CI_REF = 'main';

/** Where a secret goes: the repository, or the one environment that may write. */
export type SecretTarget = 'repository' | typeof CI_ENVIRONMENT;
export const SECRET_TARGETS: readonly SecretTarget[] = ['repository', CI_ENVIRONMENT];

/** The credentials `keeper-setup` makes, which `github-secrets` writes. */
export const CREDENTIAL_SECRETS = [
  'CLOUDFLARE_API_TOKEN',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const;
/** The configs `cf-sync` writes, repository only. */
export const CONFIG_SECRETS = ['CF_ROUTER_CONFIG', 'CF_ACCESS_CONFIG', 'CF_SHARE_LINK_CONFIG'];

export interface SecretWrite {
  target: SecretTarget;
  name: string;
  value: string;
}

export interface GithubSecretsCall {
  type: 'github-secrets';
  secrets: SecretWrite[];
}

export interface GithubStatusCall {
  type: 'github-status';
}

/** One call to GitHub's REST API, under `https://api.github.com`, with the scope header. */
export type GithubScopedApi = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: string; scopes: string | null }>;

/** GitHub's own limit on one secret's value. */
const MAX_VALUE = 48 * 1024;

/** The writes, checked; or why they are refused. */
export function checkSecretWrites(
  secrets: unknown,
  allowed: readonly string[],
  targets: readonly SecretTarget[] = SECRET_TARGETS,
): SecretWrite[] | { error: string } {
  if (!Array.isArray(secrets) || secrets.length === 0 || secrets.length > 12) {
    return { error: 'secrets must list 1-12 writes' };
  }
  const seen = new Set<string>();
  const out: SecretWrite[] = [];
  for (const s of secrets) {
    const { target, name, value } = (s ?? {}) as Record<string, unknown>;
    if (!targets.includes(target as SecretTarget)) {
      return { error: `a secret's target must be one of ${targets.join(', ')}` };
    }
    if (typeof name !== 'string' || !allowed.includes(name)) {
      return { error: `a secret's name must be one of ${allowed.join(', ')}` };
    }
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_VALUE) {
      return { error: `${name} needs a value under ${MAX_VALUE} bytes` };
    }
    if (value.includes('\0')) return { error: `${name} holds a NUL` };
    const key = `${target}/${name}`;
    if (seen.has(key)) return { error: `${name} is listed twice for ${target}` };
    seen.add(key);
    out.push({ target: target as SecretTarget, name, value });
  }
  return out;
}

/** The names a list of writes sets, per target: what the page and the summary show. */
export function namesByTarget(secrets: readonly Pick<SecretWrite, 'target' | 'name'>[]) {
  const by: Partial<Record<SecretTarget, string[]>> = {};
  for (const s of secrets) {
    const list = by[s.target] ?? [];
    list.push(s.name);
    by[s.target] = list;
  }
  return by;
}

const where = (t: SecretTarget) => (t === 'repository' ? 'repository' : `environment ${t}`);

export function describeTargets(secrets: readonly Pick<SecretWrite, 'target' | 'name'>[]): string {
  return Object.entries(namesByTarget(secrets))
    .map(([t, names]) => `${where(t as SecretTarget)}: ${(names ?? []).join(', ')}`)
    .join('; ');
}

export function classifyGithubSecrets(secrets: unknown): Verdict {
  const checked = checkSecretWrites(secrets, CREDENTIAL_SECRETS);
  if ('error' in checked) return { kind: 'refused', reason: checked.error };
  return {
    kind: 'held',
    hold: 'github.secrets',
    app: null,
    summary: `write GitHub Actions secrets on ${CI_REPO}: ${describeTargets(checked)}`,
  };
}

/** The scope names a classic token's `X-OAuth-Scopes` header lists. */
export function scopeNames(header: string | null): string[] {
  return (header ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const base = (t: SecretTarget) =>
  t === 'repository'
    ? `/repos/${CI_REPO}/actions/secrets`
    : `/repos/${CI_REPO}/environments/${t}/secrets`;

/** What GitHub said, short, with no value of ours in it. */
function why(text: string): string {
  try {
    const m = (JSON.parse(text) as { message?: unknown }).message;
    if (typeof m === 'string') return m.slice(0, 200);
  } catch {}
  return '';
}

type Result = { status: number; body: string };
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Result => ({
  status,
  body: JSON.stringify({ error, ...extra }),
});

/** The token's scopes, or the refusal when it cannot write Actions secrets. */
async function repoScope(gh: GithubScopedApi): Promise<Result | null> {
  const r = await gh('GET', `/repos/${CI_REPO}`);
  if (r.status !== 200)
    return fail(502, `GitHub answered ${r.status} for ${CI_REPO}: ${why(r.body)}`);
  if (!scopeNames(r.scopes).includes('repo')) {
    return fail(
      403,
      `the keeper's GitHub token does not have the classic repo scope (it has: ${scopeNames(r.scopes).join(', ') || 'none listed'}), so nothing was written. Make a classic token with repo and import it as github-token (docs/process/keeper.md, "The GitHub token").`,
    );
  }
  return null;
}

/** The token's scope names and the secret names already set, per target. */
export async function githubStatus(gh: GithubScopedApi): Promise<Result> {
  const r = await gh('GET', `/repos/${CI_REPO}`);
  const scopes = scopeNames(r.scopes);
  const names: Partial<Record<SecretTarget, string[]>> = {};
  for (const t of SECRET_TARGETS) {
    const l = await gh('GET', `${base(t)}?per_page=100`);
    if (l.status !== 200) continue;
    try {
      const list = (JSON.parse(l.body) as { secrets?: { name?: unknown }[] }).secrets ?? [];
      names[t] = list.map((s) => s.name).filter((n): n is string => typeof n === 'string');
    } catch {}
  }
  return { status: r.status === 200 ? 200 : 502, body: JSON.stringify({ scopes, names }) };
}

/**
 * Seal and write each secret. Stops at the first failure, naming what was
 * written before it; the answer names secrets, never values.
 */
export async function writeGithubSecrets(
  gh: GithubScopedApi,
  secrets: readonly SecretWrite[],
): Promise<Result> {
  const refused = await repoScope(gh);
  if (refused) return refused;
  const keys = new Map<SecretTarget, { key_id: string; key: string }>();
  const written: string[] = [];
  for (const s of secrets) {
    let k = keys.get(s.target);
    if (!k) {
      const r = await gh('GET', `${base(s.target)}/public-key`);
      const parsed = (() => {
        try {
          return JSON.parse(r.body) as { key_id?: unknown; key?: unknown };
        } catch {
          return {};
        }
      })();
      if (r.status !== 200 || typeof parsed.key_id !== 'string' || typeof parsed.key !== 'string') {
        return fail(502, `GitHub gave no public key for ${where(s.target)}: ${r.status}`, {
          written,
        });
      }
      k = { key_id: parsed.key_id, key: parsed.key };
      keys.set(s.target, k);
    }
    const put = await gh('PUT', `${base(s.target)}/${s.name}`, {
      encrypted_value: sealedBox(s.value, k.key),
      key_id: k.key_id,
    });
    if (put.status !== 201 && put.status !== 204) {
      return fail(502, `GitHub did not take ${s.name} for ${where(s.target)}: ${put.status}`, {
        written,
      });
    }
    written.push(`${where(s.target)}/${s.name}`);
  }
  return { status: 200, body: JSON.stringify({ repo: CI_REPO, written }) };
}

/** Start `cloudflare.yml` on main. */
export async function dispatchCloudflareWorkflow(gh: GithubScopedApi): Promise<Result> {
  const r = await gh('POST', `/repos/${CI_REPO}/actions/workflows/${CI_WORKFLOW}/dispatches`, {
    ref: CI_REF,
  });
  return r.status === 204
    ? { status: 200, body: JSON.stringify({ dispatched: `${CI_WORKFLOW}@${CI_REF}` }) }
    : fail(502, `GitHub did not start ${CI_WORKFLOW}: ${r.status} ${why(r.body)}`);
}
