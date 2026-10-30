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
 * - `GET /workspaces/<board>/docs` — the board's doc list (`list_docs`);
 * - `POST /workspaces/<board>/docs/<doc>/content` — a whole-doc rewrite
 *   (`set_doc_content`) of a doc on that board;
 * - `POST /workspaces` — a folder bind (`attach_folder`). The path names no
 *   board, so `routes/workspaces-create-read.ts` holds the body to it: the
 *   board must be the lead's, the folder one of the roots registered for it
 *   (`board-socket-roots.ts`), and a board create is refused;
 * - `POST /workspaces/<board>/agents/<agent>/notes` and `…/prompts` — the
 *   plugin's Stop, PermissionDenied and UserPromptSubmit hooks, and
 *   `post_status`'s untargeted form;
 * - `POST /workspaces/<board>/tasks/<task>/notes` — `post_status` on a row
 *   of that board.
 *
 * The bind and the rewrite have the server act on a file tree the lead
 * controls. That is safe because every read, listing and write under a
 * registered root goes through `tree-fs.ts`, which follows no link below the
 * root, takes a regular file with one name only, and writes through a temp
 * file renamed with no link allowed in either name.
 *
 * Each names its board in its first segment and is refused for any other.
 * The agent a notes path names is a claim, as it is over TCP: the hooks send
 * the session's display name, not the id a board token carries, and a note
 * lands only on this board. Anything not named here is refused, so a route
 * added later is closed to a lead until somebody decides otherwise.
 */

/** Every board an id belongs to, as `collabScope` asks it. */
type WorkspacesOf = (id: string) => string[];

const FOLDER_BIND_PATH = '/workspaces';
const BOARD_PATH = /^\/workspaces\/([^/]+)\/(.+)$/;

export function leadScopeAllows(
  pathname: string,
  method: string,
  boardId: string,
  workspacesOf: WorkspacesOf,
): boolean {
  const m = method.toUpperCase();
  if (pathname === FOLDER_BIND_PATH) return m === 'POST';
  const match = pathname.match(BOARD_PATH);
  if (!match || decoded(match[1] ?? '') !== boardId) return false;
  const rest = match[2] ?? '';
  if (rest === 'docs') return m === 'GET';
  const parts = rest.split('/').map(decoded);
  if (parts.length !== 3 || m !== 'POST') return false;
  const [collection, id = '', verb] = parts;
  if (collection === 'docs' && verb === 'content') return onBoard(workspacesOf, id, boardId);
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
