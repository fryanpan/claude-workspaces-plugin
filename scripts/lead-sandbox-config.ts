/**
 * The lead sandbox's config: who the leads are and what each may reach.
 * Checked here; turned into profiles by `lead-sandbox-lib.ts`, which
 * re-exports all of it.
 */
import { boardSocketDirError } from '../packages/server/src/board-sockets.ts';
import { parseGitProxyPort, parseGithubRepos } from './git-proxy-lead.ts';

export interface Lead {
  /** Lowercase words, for the profile's file name. */
  name: string;
  /** The lead's own repos: read and write, with their worktrees inside. */
  projects: string[];
  /** Extra folders or files the lead may read and write (a build cache). */
  allow: string[];
  /** Extra folders or files the lead may only read (`~/.gitconfig`). */
  allowRead: string[];
  /**
   * Leave the tmux socket reachable, for a lead that runs tmux sessions of
   * its own. Off by default: with it, the lead can `send-keys` into every
   * unsandboxed session on the machine.
   */
  allowTmux: boolean;
  /**
   * Leave the keychain readable, for a lead whose `gh` or git over HTTPS it
   * holds. Off by default: with it, the lead reads every item in it.
   */
  allowKeychain: boolean;
  /** `owner/name` repos it may fetch and push through the GitHub proxy (`git-proxy.ts`). */
  githubRepos: string[];
  /**
   * Deny every board server's port and every board's socket but its own
   * (`lead-sandbox-wall.ts`). Off by default.
   */
  boardWall: boolean;
  /** The board whose socket a walled lead may reach. Required with `boardWall`. */
  boardId?: string;
  /** Which of `claudeAccounts` it signs in to Claude as; else the default. */
  claudeAccount?: string;
}

export interface LeadSandboxConfig {
  leads: Lead[];
  /**
   * Labels for the Claude accounts a lead may sign in as. Each names a
   * keychain item of its own (`lead-sandbox-token.ts`). Empty: every lead
   * uses the one un-labelled item.
   */
  claudeAccounts: string[];
  /** The account a lead that names none signs in as. */
  defaultClaudeAccount?: string;
  /** Folders no lead may read or write, beyond the built-in ones. */
  protect: string[];
  gitProxyPort: number;
  /** Where the board sockets are; unset is `defaultBoardSocketDir(uid)`. */
  boardSocketDir?: string;
}

/** The machine, as the generator may ask about it. */
export interface Machine {
  home: string;
  uid: number;
  /** The path with every symlink resolved, or the path itself if it is missing. */
  realpath(path: string): string;
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BOARD_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** The config, checked, or the reason it is refused. A path may start `~/`. */
export function parseConfig(
  raw: unknown,
  home: string,
): { ok: true; config: LeadSandboxConfig } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null)
    return { ok: false, error: 'config is not an object' };
  const r = raw as {
    leads?: unknown;
    protect?: unknown;
    claudeAccounts?: unknown;
    defaultClaudeAccount?: unknown;
  };
  if (!Array.isArray(r.leads) || r.leads.length === 0)
    return { ok: false, error: 'config.leads must list at least one lead' };
  const paths = (v: unknown, what: string): string[] | string => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((p) => typeof p === 'string'))
      return `${what} must be a list of paths`;
    const expanded = (v as string[]).map((p) => (p.startsWith('~/') ? `${home}${p.slice(1)}` : p));
    for (const p of expanded) {
      if (!p.startsWith('/')) return `${what}: ${p} must be absolute`;
      if (p === '/' || /\/\.\.?(\/|$)/.test(p))
        return `${what}: ${p} must name one folder, not / or a relative step`;
      if (/["\\\n\r]/.test(p)) return `${what}: ${p} must not hold a quote or a backslash`;
    }
    return expanded;
  };
  const accounts = r.claudeAccounts ?? [];
  if (
    !Array.isArray(accounts) ||
    !accounts.every((a) => typeof a === 'string' && NAME.test(a)) ||
    new Set(accounts).size !== accounts.length
  )
    return { ok: false, error: 'claudeAccounts must list distinct lowercase words' };
  const claudeAccounts = accounts as string[];
  const account = (v: unknown, what: string): string | undefined | { error: string } => {
    if (v === undefined) return undefined;
    if (typeof v === 'string' && claudeAccounts.includes(v)) return v;
    return { error: `${what} ${JSON.stringify(v)} is not one of claudeAccounts` };
  };
  const defaultClaudeAccount = account(r.defaultClaudeAccount, 'defaultClaudeAccount');
  if (typeof defaultClaudeAccount === 'object') return { ok: false, ...defaultClaudeAccount };
  const leads: Lead[] = [];
  const seen = new Set<string>();
  for (const l of r.leads as unknown[]) {
    const o = (l ?? {}) as Record<string, unknown>;
    const name = o.name;
    if (typeof name !== 'string' || !NAME.test(name))
      return { ok: false, error: `lead name ${JSON.stringify(name)} must be lowercase words` };
    if (seen.has(name)) return { ok: false, error: `${name} is listed twice` };
    seen.add(name);
    const projects = paths(o.projects, `${name}.projects`);
    const allow = paths(o.allow, `${name}.allow`);
    const allowRead = paths(o.allowRead, `${name}.allowRead`);
    for (const key of ['allowTmux', 'allowKeychain', 'boardWall'])
      if (o[key] !== undefined && typeof o[key] !== 'boolean')
        return { ok: false, error: `${name}.${key} must be true or false` };
    const githubRepos = parseGithubRepos(o.githubRepos, name);
    for (const p of [projects, allow, allowRead, githubRepos])
      if (typeof p === 'string') return { ok: false, error: p };
    if ((projects as string[]).length === 0)
      return { ok: false, error: `${name}.projects must name at least one repo` };
    const boardId = o.boardId;
    if (boardId !== undefined && (typeof boardId !== 'string' || !BOARD_ID.test(boardId)))
      return { ok: false, error: `${name}.boardId must be a board id` };
    if (o.boardWall === true && boardId === undefined)
      return {
        ok: false,
        error: `${name}.boardWall needs a boardId: the board whose socket it may reach`,
      };
    const claudeAccount = account(o.claudeAccount, `${name}.claudeAccount`);
    if (typeof claudeAccount === 'object') return { ok: false, ...claudeAccount };
    leads.push({
      name,
      projects: projects as string[],
      allow: allow as string[],
      allowRead: allowRead as string[],
      allowTmux: o.allowTmux === true,
      allowKeychain: o.allowKeychain === true,
      githubRepos: githubRepos as string[],
      boardWall: o.boardWall === true,
      ...(typeof boardId === 'string' ? { boardId } : {}),
      ...(claudeAccount ? { claudeAccount } : {}),
    });
  }
  const protect = paths(r.protect, 'protect');
  if (typeof protect === 'string') return { ok: false, error: protect };
  const gitProxyPort = parseGitProxyPort((raw as { gitProxyPort?: unknown }).gitProxyPort);
  if (typeof gitProxyPort === 'string') return { ok: false, error: gitProxyPort };
  const boardSocketDir = (raw as { boardSocketDir?: unknown }).boardSocketDir;
  if (boardSocketDir !== undefined) {
    const why =
      typeof boardSocketDir !== 'string'
        ? 'boardSocketDir must be a path'
        : /["\\\n\r]/.test(boardSocketDir)
          ? `boardSocketDir: ${boardSocketDir} must not hold a quote or a backslash`
          : boardSocketDirError(boardSocketDir);
    if (why) return { ok: false, error: why };
  }
  return {
    ok: true,
    config: {
      leads,
      protect,
      gitProxyPort,
      ...(typeof boardSocketDir === 'string' ? { boardSocketDir } : {}),
      claudeAccounts,
      ...(defaultClaudeAccount ? { defaultClaudeAccount } : {}),
    },
  };
}
