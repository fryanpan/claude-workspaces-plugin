/**
 * What a lead may reach on its own board beyond what a board member may.
 *
 * A LEAD here is a caller the server has placed on one board itself, never a
 * person: a request on that board's own socket (`board-sockets.ts`), or the
 * board token the server holds for a session opened there
 * (`connector/board-token-lease.ts`, `BoardAgentTokens.isHeld`). Both are
 * processes of this user on this machine that the lead's sandbox profile let
 * reach one board. A share or collaboration visitor never reaches this file,
 * and `shareScopeAllows` is not widened by it.
 *
 * `collabScope` refuses these because a member is a reviewer, not an
 * operator; a lead is the board's operator, so on its own board it gets:
 *
 * - `POST /workspaces/<board>/agents/<agent>/notes` and `…/prompts` — the
 *   plugin's Stop, PermissionDenied and UserPromptSubmit hooks, and
 *   `post_status`'s untargeted form;
 * - `POST /workspaces/<board>/tasks/<task>/notes` — `post_status` on a row
 *   of that board.
 *
 * A lead's own folder bind, the doc list and a whole-doc rewrite are not
 * here: each would have the server act on a file tree the lead controls,
 * and they wait for a design where that runs contained.
 *
 * Each names its board in its first segment and is refused for any other.
 * The agent a notes path names is a claim, as it is over TCP: the hooks send
 * the session's display name, not the id a board token carries, and a note
 * lands only on this board. Anything not named here is refused, so a route
 * added later is closed to a lead until somebody decides otherwise.
 */

/** Every board an id belongs to, as `collabScope` asks it. */
type WorkspacesOf = (id: string) => string[];

const BOARD_PATH = /^\/workspaces\/([^/]+)\/(.+)$/;

export function leadScopeAllows(
  pathname: string,
  method: string,
  boardId: string,
  workspacesOf: WorkspacesOf,
): boolean {
  const m = method.toUpperCase();
  const match = pathname.match(BOARD_PATH);
  if (!match || decoded(match[1] ?? '') !== boardId) return false;
  const rest = match[2] ?? '';
  const parts = rest.split('/').map(decoded);
  if (parts.length !== 3 || m !== 'POST') return false;
  const [collection, id = '', verb] = parts;
  if (collection === 'tasks' && verb === 'notes')
    return onBoard(workspacesOf, `task:${id}`, boardId);
  if (collection === 'agents') return (verb === 'notes' || verb === 'prompts') && id !== '';
  return false;
}

function onBoard(workspacesOf: WorkspacesOf, id: string, boardId: string): boolean {
  const owners = workspacesOf(id);
  return Array.isArray(owners) && owners.includes(boardId);
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
