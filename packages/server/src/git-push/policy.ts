/**
 * Which repos a board's lead may push to through its server, and which of
 * them wait for a person's approval first.
 *
 * The policy is a file in the server's data dir, `git-push.json`:
 *
 *   { "boards": { "<boardId>": { "repos": [
 *       { "repo": "owner/name" },
 *       { "repo": "owner/other", "approval": true } ] } } }
 *
 * No route writes it. The operator edits it on the machine: on the Mac in
 * prod's data dir, which a walled lead's profile denies; on a project
 * machine in `/data/cw`, mode 700 as `cw`, over `fly ssh console`. So the
 * lead that asks for a push can neither read nor change the list it is
 * judged against. It is read again on every request, so an edit needs no
 * restart, and a file that does not parse allows nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const GIT_PUSH_POLICY_FILE = 'git-push.json';

export interface RepoRule {
  /** `owner/name`, as GitHub spells it. */
  repo: string;
  /** Hold every push for a person's answer on a review item. */
  approval: boolean;
}

/** `owner/name`: GitHub's own character set, no dot-only segment. */
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

export function isRepoName(repo: string): boolean {
  if (!REPO.test(repo)) return false;
  const name = repo.split('/')[1] ?? '';
  return name !== '.' && name !== '..' && !name.endsWith('.git');
}

/**
 * A branch name the server will push: git's own ref-name rules, written out
 * so no git runs to judge input, plus no leading dash (it would read as an
 * option) and nothing outside a plain character set.
 */
export function isBranchName(branch: string): boolean {
  if (branch.length === 0 || branch.length > 200) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) return false;
  if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')) return false;
  if (branch.endsWith('.') || branch.includes('..') || branch.includes('//')) return false;
  if (branch === 'HEAD' || branch.startsWith('refs/')) return false;
  return branch.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

/** The rules for every board, from the policy text. Null when it does not parse. */
export function parsePolicy(text: string): Map<string, RepoRule[]> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const boards = (raw as { boards?: unknown } | null)?.boards;
  if (typeof boards !== 'object' || boards === null || Array.isArray(boards)) return null;
  const out = new Map<string, RepoRule[]>();
  for (const [boardId, entry] of Object.entries(boards)) {
    const repos = (entry as { repos?: unknown } | null)?.repos;
    if (!Array.isArray(repos)) return null;
    const rules: RepoRule[] = [];
    for (const r of repos) {
      const repo = (r as { repo?: unknown } | null)?.repo;
      const approval = (r as { approval?: unknown }).approval;
      if (typeof repo !== 'string' || !isRepoName(repo)) return null;
      if (approval !== undefined && typeof approval !== 'boolean') return null;
      rules.push({ repo, approval: approval === true });
    }
    out.set(boardId, rules);
  }
  return out;
}

/** The rule for `repo` on `boardId`, or null when the board may not push to it. */
export function ruleFor(dataDir: string, boardId: string, repo: string): RepoRule | null {
  let text: string;
  try {
    text = readFileSync(join(dataDir, GIT_PUSH_POLICY_FILE), 'utf8');
  } catch {
    return null;
  }
  const rules = parsePolicy(text)?.get(boardId) ?? [];
  // GitHub treats owner and name case-insensitively; so does the list.
  return rules.find((r) => r.repo.toLowerCase() === repo.toLowerCase()) ?? null;
}
