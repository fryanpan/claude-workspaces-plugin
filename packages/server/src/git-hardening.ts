/**
 * Options every server-side git read passes before its subcommand, so a
 * repository a walled lead can write cannot make that read run code.
 *
 * The server runs git in folders a lead owns. Git reads config from the
 * repository it finds, and several settings there name a program git then
 * runs as the server's user: `core.fsmonitor` runs on almost every command,
 * and a folder that looks like a bare repository supplies a `config` of its
 * own. The lead sandbox refuses writes to `.git`, `.git/config` and
 * `.git/config.worktree` under a lead's roots; these options are the server's
 * own half, so a config the sandbox missed still runs nothing here.
 *
 * - `core.fsmonitor=false` — no hook program on status, ls-files or diff.
 * - `safe.bareRepository=explicit` — a folder holding `HEAD`, `objects` and
 *   `refs` is not taken as a repository unless `--git-dir` names it.
 *
 * Filters and textconv drivers are defined in config too. Those reads pass
 * `--no-textconv` / `--no-ext-diff` at the call, and `hash-object --path`
 * relies on the sandbox's refusal; see `git-provenance.ts`.
 */
export const HARDENED_GIT_ARGS: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'safe.bareRepository=explicit',
];

/** `git <hardened> <args>` as one argv tail, for spawn calls that take one. */
export function hardenedGitArgs(args: readonly string[]): string[] {
  return [...HARDENED_GIT_ARGS, ...args];
}
