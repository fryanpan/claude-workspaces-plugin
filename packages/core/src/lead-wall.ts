/**
 * What a walled lead may write under `~/.claude`, in one place.
 *
 * The wall (`scripts/lead-sandbox-lib.ts`) opens `~/.claude` to a lead, then
 * makes the folders and files below read only, and denies `projects/` apart
 * from the lead's own transcript folders. The server reads the same lists
 * (`server/src/board-socket-roots.ts`): a path the lead can write is refused
 * as the lead's bytes, and a path it cannot is read through a checked open.
 * One list, so the profile and the server cannot disagree.
 */

/**
 * What under `~/.claude` an unsandboxed session later runs or obeys:
 * settings (hooks, MCP servers, the status line), plugin and skill code,
 * instructions, and the shell snapshot and env files each Bash call
 * sources. Measured on 2.1.302: a `claude -p` with every write under
 * `~/.claude` refused still signed in and ran a Bash call.
 */
export const CLAUDE_CODE_FOLDERS = [
  'hooks',
  'plugins',
  'skills',
  'agents',
  'commands',
  'rules',
  'output-styles',
  'shell-snapshots',
  'session-env',
];

/**
 * The folders under `~/.claude` that the server and its supervisor read and
 * replace by name, current name first. A lead's hooks and MCP children only
 * read them; a hook marker it cannot create reads as already seen.
 */
export const SERVER_STATE_FOLDERS = ['claude-workspaces', 'live-feedback'];

/** Every folder under `~/.claude` a walled lead may read and not write:
 *  the two lists above, and the owner's plans. */
export const CLAUDE_READ_ONLY_FOLDERS = [...CLAUDE_CODE_FOLDERS, ...SERVER_STATE_FOLDERS, 'plans'];

/** Files directly in `~/.claude` a walled lead may not write, as regex
 *  source for one name: the instructions, the settings and every name they
 *  are replaced through (Claude Code's own, and the server's `.settings…`). */
export const CLAUDE_READ_ONLY_FILES = ['CLAUDE\\.md', 'settings[^/]*', '\\.settings[^/]*'];

/** The folder under `~/.claude` holding every project's transcripts and
 *  memory. Denied to a lead, except its own projects' folders. */
export const CLAUDE_PROJECTS = 'projects';

/** Claude Code's name for a folder's transcript and scratch folders. */
export function transcriptSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Whether a transcript or scratch folder name is one of `slugs`, or a
 *  worktree launched inside one. */
export function isOwnSlug(name: string, slugs: ReadonlySet<string>): boolean {
  return slugs.has(name.replace(/--claude-worktrees-.*$/, ''));
}

/**
 * Whether the wall lets a lead whose projects have `slugs` write `rel`,
 * a path relative to `~/.claude` (`''` is the folder itself).
 */
export function leadWritesUnderClaude(rel: string, slugs: ReadonlySet<string>): boolean {
  if (rel === '') return false;
  const [first = '', second] = rel.split('/');
  if (CLAUDE_READ_ONLY_FOLDERS.includes(first)) return false;
  if (
    second === undefined &&
    CLAUDE_READ_ONLY_FILES.some((re) => new RegExp(`^${re}$`).test(first))
  )
    return false;
  if (first === CLAUDE_PROJECTS) return second !== undefined && isOwnSlug(second, slugs);
  return true;
}
