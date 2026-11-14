/**
 * Which Actions secrets a workflow pushed with a repo's write deploy key
 * could read, reported after the keeper makes the key
 * (`keeper-push-keys.ts`).
 *
 * A deploy key with write access can push a workflow file to any branch, and
 * GitHub cannot stop it. The server's push path holds every `.github/` change
 * for a person (`git-push/pusher.ts`), but a server that is broken into
 * skips that hold. So the keeper reports what such a workflow reaches from a
 * side branch:
 *
 * - every repository secret;
 * - every organization secret shared with the repo;
 * - the secrets of every environment with no deployment branch policy and no
 *   required reviewers, which any branch may deploy to. An environment with
 *   a branch policy counts as closed whatever its patterns say.
 *
 * And when the default branch does not refuse the key's direct push, the key
 * can push the workflow to the default branch itself, so an environment
 * limited to the default branch protects nothing either.
 *
 * "Refuses" means classic protection that requires a pull request, restricts
 * who may push, or locks the branch (no deploy key can be on a classic
 * bypass list), or a ruleset rule of type `pull_request` or `update` whose
 * ruleset does not list deploy keys as a bypass actor. A ruleset whose
 * bypass list cannot be read gives null.
 *
 * It reads NAMES only. GitHub's API never returns a secret's value, and this
 * module asks for none. Every call is a GET. A read that fails gives null,
 * never "none", and a list longer than one page says it is incomplete.
 * Moving a secret into an environment needs its value, which the keeper does
 * not hold, so this module only reports.
 */
import type { GithubApi } from './keeper-push-keys.ts';

const PAGE = 100;

/** Names from one list endpoint. `complete` is false when GitHub has more than one page. */
export interface Listed<T> {
  items: T[];
  complete: boolean;
}

export interface OpenEnvironment {
  environment: string;
  /** The environment's secret names, or null when they could not be read. */
  secrets: Listed<string> | null;
}

export interface RepoExposure {
  repo: string;
  /** The default branch's name, or null when the repo could not be read. */
  defaultBranch: string | null;
  /** Whether the deploy key is refused a direct push to the default branch; null when unread. */
  defaultBranchProtected: boolean | null;
  /** Repository secret names; null when unread. */
  repoSecrets: Listed<string> | null;
  /** Organization secret names shared with the repo; null when unread. */
  orgSecrets: Listed<string> | null;
  /** Environments any branch may deploy to; null when unread. */
  openEnvironments: Listed<OpenEnvironment> | null;
}

function parse(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** A `{total_count, <key>: [...]}` page, or null when it is not one. */
function page(body: string, key: string): { list: unknown[]; total: number } | null {
  const p = parse(body) as Record<string, unknown> | null;
  const list = p?.[key];
  if (!Array.isArray(list)) return null;
  const total = typeof p?.total_count === 'number' ? p.total_count : list.length;
  return { list, total };
}

async function secretNames(github: GithubApi, path: string): Promise<Listed<string> | null> {
  const r = await github('GET', `${path}?per_page=${PAGE}`);
  if (r.status !== 200) return null;
  const p = page(r.body, 'secrets');
  if (!p) return null;
  const items = p.list
    .map((s) => (s as { name?: unknown } | null)?.name)
    .filter((n): n is string => typeof n === 'string');
  return { items, complete: p.total <= items.length };
}

async function openEnvironments(
  github: GithubApi,
  repo: string,
): Promise<Listed<OpenEnvironment> | null> {
  const r = await github('GET', `/repos/${repo}/environments?per_page=${PAGE}`);
  if (r.status !== 200) return null;
  const p = page(r.body, 'environments');
  if (!p) return null;
  const items: OpenEnvironment[] = [];
  for (const e of p.list) {
    const env = e as {
      name?: unknown;
      deployment_branch_policy?: unknown;
      protection_rules?: unknown;
    } | null;
    if (typeof env?.name !== 'string') continue;
    if (env.deployment_branch_policy) continue;
    const rules = Array.isArray(env.protection_rules) ? env.protection_rules : [];
    if (rules.some((x) => (x as { type?: unknown } | null)?.type === 'required_reviewers'))
      continue;
    const secrets = await secretNames(
      github,
      `/repos/${repo}/environments/${encodeURIComponent(env.name)}/secrets`,
    );
    items.push({ environment: env.name, secrets });
  }
  return { items, complete: p.total <= p.list.length };
}

/** Whether a ruleset holds against deploy keys: false when they may bypass it, null when unread. */
async function rulesetHolds(github: GithubApi, repo: string, id: number): Promise<boolean | null> {
  const r = await github('GET', `/repos/${repo}/rulesets/${id}`);
  if (r.status !== 200) return null;
  const actors = (parse(r.body) as { bypass_actors?: unknown } | null)?.bypass_actors;
  // GitHub leaves bypass_actors out for a caller who may not see it.
  if (!Array.isArray(actors)) return null;
  return !actors.some((a) => (a as { actor_type?: unknown } | null)?.actor_type === 'DeployKey');
}

async function isProtected(
  github: GithubApi,
  repo: string,
  branch: string,
): Promise<boolean | null> {
  const b = encodeURIComponent(branch);
  const classic = await github('GET', `/repos/${repo}/branches/${b}/protection`);
  if (classic.status === 200) {
    const p = parse(classic.body) as {
      required_pull_request_reviews?: unknown;
      restrictions?: unknown;
      lock_branch?: { enabled?: unknown };
    } | null;
    if (p?.required_pull_request_reviews || p?.restrictions || p?.lock_branch?.enabled === true)
      return true;
  } else if (classic.status !== 404) {
    return null;
  }
  // A 404 is "Branch not protected" for a token that may read protection.
  const rules = await github('GET', `/repos/${repo}/rules/branches/${b}?per_page=${PAGE}`);
  if (rules.status !== 200) return null;
  const list = parse(rules.body);
  if (!Array.isArray(list)) return null;
  const ids = new Set<number>();
  for (const rule of list) {
    const r = rule as { type?: unknown; ruleset_id?: unknown } | null;
    if (r?.type !== 'pull_request' && r?.type !== 'update') continue;
    if (typeof r.ruleset_id !== 'number') return null;
    ids.add(r.ruleset_id);
  }
  let unread = false;
  for (const id of ids) {
    const holds = await rulesetHolds(github, repo, id);
    if (holds === true) return true;
    if (holds === null) unread = true;
  }
  return unread ? null : false;
}

/** One repo's report. Every read is a GET; nothing is written. */
export async function repoExposure(github: GithubApi, repo: string): Promise<RepoExposure> {
  const info = await github('GET', `/repos/${repo}`);
  const branch =
    info.status === 200
      ? (parse(info.body) as { default_branch?: unknown } | null)?.default_branch
      : undefined;
  const defaultBranch = typeof branch === 'string' && branch ? branch : null;
  return {
    repo,
    defaultBranch,
    defaultBranchProtected:
      defaultBranch === null ? null : await isProtected(github, repo, defaultBranch),
    repoSecrets: await secretNames(github, `/repos/${repo}/actions/secrets`),
    orgSecrets: await secretNames(github, `/repos/${repo}/actions/organization-secrets`),
    openEnvironments: await openEnvironments(github, repo),
  };
}

/** The same report with every unreadable part null: what a throw during the reads gives. */
export function unreadExposure(repo: string): RepoExposure {
  return {
    repo,
    defaultBranch: null,
    defaultBranchProtected: null,
    repoSecrets: null,
    orgSecrets: null,
    openEnvironments: null,
  };
}

/** A list from the wire, or null when it is not one. */
function listed<T>(x: unknown, item: (v: unknown) => v is T): Listed<T> | null {
  const l = x as { items?: unknown; complete?: unknown } | null;
  if (!Array.isArray(l?.items) || typeof l?.complete !== 'boolean') return null;
  return { items: l.items.filter(item), complete: l.complete };
}
const isString = (v: unknown): v is string => typeof v === 'string';
const isOpenEnv = (v: unknown): v is OpenEnvironment =>
  typeof (v as { environment?: unknown } | null)?.environment === 'string';

function secretLine(repo: string, what: string, l: Listed<string> | null, via: string): string[] {
  if (l === null) return [`${repo}: could not read the names of its ${what}`];
  const out =
    l.items.length > 0
      ? [`${repo}: a workflow on any branch can ${via} ${l.items.join(', ')} (${what})`]
      : [];
  if (!l.complete)
    out.push(`${repo}: GitHub lists more ${what} than one page; the list above is incomplete`);
  return out;
}

/**
 * The report's lines for `machine:deploy` to print. Takes the keeper's
 * answer as it arrived, so an entry missing a part prints "could not read"
 * rather than throwing after the keys are in place.
 */
export function exposureLines(reports: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of reports) {
    const r = raw as Partial<Record<keyof RepoExposure, unknown>> | null;
    const repo = typeof r?.repo === 'string' ? r.repo : 'a repo';
    const lines: string[] = [];
    lines.push(
      ...secretLine(repo, 'repository secrets', listed(r?.repoSecrets, isString), 'read'),
      ...secretLine(repo, 'organization secrets', listed(r?.orgSecrets, isString), 'read'),
    );
    const envs = listed(r?.openEnvironments, isOpenEnv);
    if (envs === null) {
      lines.push(`${repo}: could not read its environments`);
    } else {
      for (const e of envs.items) {
        lines.push(
          ...secretLine(
            repo,
            `environment ${e.environment} secrets`,
            listed(e.secrets, isString),
            `deploy to environment ${e.environment} and read`,
          ),
        );
      }
      if (!envs.complete)
        lines.push(`${repo}: GitHub lists more environments than one page; some were not read`);
    }
    if (lines.length === 0) lines.push(`${repo}: no secret a side-branch workflow can read`);
    if (r?.defaultBranchProtected === false) {
      const branch = typeof r.defaultBranch === 'string' ? r.defaultBranch : 'the default branch';
      lines.push(
        `${repo}: default branch ${branch} does not refuse the deploy key, so it can push a workflow there and reach every secret, environment ones too`,
      );
    } else if (r?.defaultBranchProtected !== true) {
      lines.push(`${repo}: could not read whether its default branch refuses the deploy key`);
    }
    out.push(...lines);
  }
  return out;
}
