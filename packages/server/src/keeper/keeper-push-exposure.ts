/**
 * Which of a repo's Actions secrets a workflow pushed with its write deploy
 * key could read, reported after the keeper makes the key
 * (`keeper-push-keys.ts`).
 *
 * A deploy key with write access can push a workflow file to any branch, and
 * GitHub cannot stop it. The server's push path holds every `.github/` change
 * for a person (`git-push/pusher.ts`), but a server that is broken into
 * skips that hold. So the keeper reports what such a workflow reaches:
 *
 * - every repository-level secret, from any branch;
 * - and when the default branch is not protected, the key can push the
 *   workflow to the default branch itself, so an environment limited to the
 *   default branch protects nothing either.
 *
 * It reads secret NAMES (`GET /repos/{repo}/actions/secrets`) and the default
 * branch's protection. GitHub's API never returns a secret's value, and this
 * module asks for none. It writes nothing: moving a secret into an
 * environment needs its value, which the keeper does not hold.
 *
 * "Protected" means a classic branch protection rule that requires a pull
 * request or restricts who may push, or a ruleset rule of type
 * `pull_request` or `update` on the branch. A ruleset's bypass list is not
 * read, so a ruleset that lets deploy keys bypass it still counts as
 * protected here. A read that fails gives null, never "none".
 */
import type { GithubApi } from './keeper-push-keys.ts';

export interface RepoExposure {
  repo: string;
  /** The default branch's name, or null when the repo could not be read. */
  defaultBranch: string | null;
  /** Whether the deploy key is refused a direct push to the default branch; null when unread. */
  defaultBranchProtected: boolean | null;
  /** Repository-level Actions secret names; null when they could not be read. */
  repoSecrets: string[] | null;
  /** The secrets a workflow pushed to a side branch can read. */
  sideBranchReadable: string[];
}

function parse(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

async function secretNames(github: GithubApi, repo: string): Promise<string[] | null> {
  const r = await github('GET', `/repos/${repo}/actions/secrets?per_page=100`);
  if (r.status !== 200) return null;
  const list = (parse(r.body) as { secrets?: unknown } | null)?.secrets;
  if (!Array.isArray(list)) return null;
  return list
    .map((s) => (s as { name?: unknown } | null)?.name)
    .filter((n): n is string => typeof n === 'string');
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
    } | null;
    if (p?.required_pull_request_reviews || p?.restrictions) return true;
  } else if (classic.status !== 404) {
    return null;
  }
  // 404 is "Branch not protected" for a token that may read protection.
  const rules = await github('GET', `/repos/${repo}/rules/branches/${b}?per_page=100`);
  if (rules.status !== 200) return null;
  const list = parse(rules.body);
  if (!Array.isArray(list)) return null;
  return list.some((r) => {
    const type = (r as { type?: unknown } | null)?.type;
    return type === 'pull_request' || type === 'update';
  });
}

/** One repo's report. Every read is a GET; nothing is written. */
export async function repoExposure(github: GithubApi, repo: string): Promise<RepoExposure> {
  const info = await github('GET', `/repos/${repo}`);
  const branch =
    info.status === 200
      ? (parse(info.body) as { default_branch?: unknown } | null)?.default_branch
      : undefined;
  const defaultBranch = typeof branch === 'string' && branch ? branch : null;
  const defaultBranchProtected =
    defaultBranch === null ? null : await isProtected(github, repo, defaultBranch);
  const repoSecrets = await secretNames(github, repo);
  return {
    repo,
    defaultBranch,
    defaultBranchProtected,
    repoSecrets,
    sideBranchReadable: repoSecrets ?? [],
  };
}

/** The report's lines, one or two per repo, for `machine:deploy` to print. */
export function exposureLines(reports: readonly RepoExposure[]): string[] {
  const out: string[] = [];
  for (const r of reports) {
    if (r.repoSecrets === null) {
      out.push(`${r.repo}: could not read its Actions secret names`);
    } else if (r.sideBranchReadable.length > 0) {
      out.push(
        `${r.repo}: a workflow on any branch can read ${r.sideBranchReadable.join(', ')} (repository secrets)`,
      );
    } else {
      out.push(`${r.repo}: no repository secrets`);
    }
    if (r.defaultBranchProtected === null) {
      out.push(`${r.repo}: could not read whether its default branch is protected`);
    } else if (!r.defaultBranchProtected) {
      out.push(
        `${r.repo}: default branch ${r.defaultBranch} is not protected, so the deploy key can push a workflow there and reach every secret, environment ones too`,
      );
    }
  }
  return out;
}
