/**
 * The lead's half of the GitHub proxy (`git-proxy.ts`): which repos a lead
 * may name, the token and git config the wrapper writes for it, and the
 * profile rules that go with them. Runbook: `docs/process/lead-sandbox.md`,
 * "GitHub through the proxy".
 *
 * A lead never holds the owner's GitHub credential. Its git sends a random
 * token of its own to the proxy on loopback, and the proxy, which runs
 * outside every sandbox, maps the token to the lead's repo list and talks to
 * GitHub with the owner's credential.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const GIT_PROXY_PORT = 8793;

/** Each lead's token and git config, under `<home>/<GIT_PROXY_DIR>/<lead>/`. */
export const GIT_PROXY_DIR = '.config/claude-workspaces/git-proxy';

/** `owner/name` as GitHub spells it, with no `.git` and no path step. */
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isRepoName(s: string): boolean {
  return REPO.test(s) && !s.split('/').some((p) => p === '.' || p === '..' || p.endsWith('.git'));
}

/** A lead's `githubRepos`, checked, or the reason it is refused. */
export function parseGithubRepos(v: unknown, lead: string): string[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((r) => typeof r === 'string' && isRepoName(r)))
    return `${lead}.githubRepos must be a list of "owner/name"`;
  return v as string[];
}

/** The port the proxy listens on, from the config's `gitProxyPort`. */
export function parseGitProxyPort(v: unknown): number | string {
  if (v === undefined) return GIT_PROXY_PORT;
  if (!Number.isInteger(v) || (v as number) < 1024 || (v as number) > 65535)
    return 'gitProxyPort must be a port from 1024 to 65535';
  return v as number;
}

export function gitProxyLeadDir(home: string, lead: string): string {
  return join(home, GIT_PROXY_DIR, lead);
}

/**
 * The folder the lead reads its token and git config from, or none for a
 * lead that names no repo. Read only: the profile refuses writes to it after
 * every other rule.
 */
export function gitProxyPaths(lead: { name: string; githubRepos: string[] }, home: string) {
  return lead.githubRepos.length > 0 ? [gitProxyLeadDir(home, lead.name)] : [];
}

/**
 * A lead that names no repo cannot reach the proxy at all. One that does
 * reaches it, and its token decides which repos answer.
 */
export function gitProxyNetworkRules(lead: { githubRepos: string[] }, port: number): string[] {
  if (lead.githubRepos.length > 0) return [];
  return [`(deny network-outbound (remote ip "localhost:${port}")) ; the GitHub proxy`];
}

function gitQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The git config every git inside the lead's wall reads, through
 * `include.path` in the environment (`gitProxyEnv`). It sends GitHub's URLs
 * to the proxy, drops every other credential helper for the proxy's URL (the
 * keychain one included), and answers git's request for a password with the
 * lead's token, read from its file at the moment git asks.
 */
export function leadGitConfig(lead: string, tokenFile: string, proxyUrl: string): string {
  const base = proxyUrl.replace(/\/+$/, '');
  const shellPath = `'${tokenFile.replace(/'/g, `'\\''`)}'`;
  const helper = `!f() { test "$1" = get || exit 0; echo username=${lead}; printf 'password='; cat ${shellPath}; echo; }; f`;
  return [
    `# Written by scripts/lead-sandbox.ts for ${lead}; do not edit. GitHub goes through the proxy.`,
    `[url ${gitQuote(`${base}/`)}]`,
    '\tinsteadOf = git@github.com:',
    '\tinsteadOf = ssh://git@github.com/',
    '\tinsteadOf = https://github.com/',
    `[credential ${gitQuote(base)}]`,
    '\thelper =',
    `\thelper = ${gitQuote(helper)}`,
    '',
  ].join('\n');
}

/** What the wrapper adds to the lead's environment: the git config's path, never a secret. */
export function gitProxyEnv(gitconfig: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'include.path',
    GIT_CONFIG_VALUE_0: gitconfig,
  };
}

/**
 * The lead's token file, made if it has none yet: 32 random bytes, mode 600,
 * in a mode 700 folder. Its git and its gh both send it.
 */
export function ensureLeadToken(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = join(dir, 'token');
  if (!existsSync(token))
    writeFileSync(token, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
  return token;
}

/**
 * `cw-worktree <name> [<branch>] [<base>]`, run from inside a repository in
 * one of the lead's projects: the proxy adds `<repo>/.claude/worktrees/<name>`
 * on a new branch (`git-proxy-worktree.ts`), and this fills in its files with
 * the lead's own git, inside the wall. The token goes to curl on its stdin,
 * never in its arguments.
 */
export function worktreeScript(lead: string, tokenFile: string, proxyUrl: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const url = `${proxyUrl.replace(/\/+$/, '')}/-/worktree`;
  return [
    '#!/bin/sh',
    `# Written by scripts/lead-sandbox.ts for ${lead}; do not edit. See scripts/git-proxy-worktree.ts.`,
    '# cw-worktree <name> [<branch>] [<base>]: a worktree at <repo>/.claude/worktrees/<name>,',
    '# made by the git proxy outside the wall. <branch> defaults to <name>, <base> to',
    '# origin/HEAD (git fetch first). It is set to push to origin/<branch>.',
    'set -eu',
    'if [ $# -lt 1 ] || [ $# -gt 3 ]; then',
    "  echo 'usage: cw-worktree <name> [<branch>] [<base>]' >&2",
    '  exit 2',
    'fi',
    'common=$(git rev-parse --path-format=absolute --git-common-dir)',
    'repo=$(dirname "$common")',
    'branch=$' + '{2:-$1}',
    'base=$' + '{3:-}',
    `auth=$(printf 'user = "%s:%s"\\n' ${q(lead)} "$(cat ${q(tokenFile)})")`,
    `out=$(printf '%s\\n' "$auth" | /usr/bin/curl -sS -m 120 -K - -w '\\n%{http_code}' --data-urlencode "repo=$repo" --data-urlencode "name=$1" --data-urlencode "branch=$branch" --data-urlencode "base=$base" ${q(url)}) || { echo 'cw-worktree: the git proxy did not answer' >&2; exit 1; }`,
    `code=$(printf '%s\\n' "$out" | tail -n 1)`,
    `path=$(printf '%s\\n' "$out" | sed '$d')`,
    'if [ "$code" != 200 ]; then',
    '  echo "cw-worktree: the git proxy refused it ($code): $path" >&2',
    '  exit 1',
    'fi',
    'git -C "$path" reset -q --hard',
    `repo_name=$(git -C "$path" remote get-url origin | sed -e 's#\\.git$##' -e 's#^.*/\\([^/]*/[^/]*\\)$#\\1#')`,
    'echo "$path"',
    'echo "push it: git -C $path push" >&2',
    'echo "its PR: gh pr create -R $repo_name --head $branch --base <default branch> --title ... --body ..." >&2',
    '',
  ].join('\n');
}

/**
 * Write the lead's git config and `bin/cw-worktree`, and its token if it has
 * none yet: 32 random bytes, mode 600, in a mode 700 folder. An existing
 * token is kept, so a restart does not break a lead's running session.
 */
export function ensureGitProxyFiles(
  lead: string,
  dir: string,
  proxyUrl: string,
): { gitconfig: string; token: string; bin: string } {
  const token = ensureLeadToken(dir);
  const gitconfig = join(dir, 'gitconfig');
  writeFileSync(gitconfig, leadGitConfig(lead, token, proxyUrl), { mode: 0o600 });
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const script = join(bin, 'cw-worktree');
  writeFileSync(script, worktreeScript(lead, token, proxyUrl));
  chmodSync(script, 0o700);
  return { gitconfig, token, bin };
}

export interface ProxyLead {
  name: string;
  /** Lowercase `owner/name`: GitHub matches repo names without case. */
  repos: Set<string>;
  /** Whether its config lists the `gh` tool, which the gh proxy requires. */
  gh: boolean;
  /** Its projects, from the owner's config: where the proxy may make it a worktree. */
  projects: readonly string[];
}

/** The lead holding `password`, compared in constant time, or null. */
export function findLead(leads: Map<string, ProxyLead>, password: string | null): ProxyLead | null {
  if (password === null) return null;
  const given = Buffer.from(password, 'utf8');
  let found: ProxyLead | null = null;
  for (const [token, lead] of leads) {
    const want = Buffer.from(token, 'utf8');
    if (want.length === given.length && timingSafeEqual(want, given)) found = lead;
  }
  return found;
}

/**
 * Token to lead, for every lead that names a repo and has a token file. Read
 * on each request, so a new lead or a changed list needs no restart.
 */
export function readLeadTokens(
  leads: readonly {
    name: string;
    githubRepos: string[];
    tools?: readonly string[];
    projects?: readonly string[];
  }[],
  root: string,
): Map<string, ProxyLead> {
  const out = new Map<string, ProxyLead>();
  for (const l of leads) {
    if (l.githubRepos.length === 0) continue;
    let token: string;
    try {
      token = readFileSync(join(root, l.name, 'token'), 'utf8').trim();
    } catch {
      continue;
    }
    if (token.length < 32) continue;
    out.set(token, {
      name: l.name,
      repos: new Set(l.githubRepos.map((r) => r.toLowerCase())),
      gh: l.tools?.includes('gh') ?? false,
      projects: l.projects ?? [],
    });
  }
  return out;
}
