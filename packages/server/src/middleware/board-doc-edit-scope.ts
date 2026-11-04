/**
 * The doc reads and edits a board-scoped agent may make on its own board's
 * docs, beyond what `collabScope` lists for a member.
 *
 * A board agent is a caller holding a board agent token (`at2`,
 * `middleware/board-agent-door.ts`) or arriving on that board's own socket
 * (`middleware/board-socket-door.ts`). Neither is a share or collaboration
 * visitor, and `shareScopeAllows` is not widened by this file: a person in a
 * browser reaches none of these paths through it.
 *
 * Each verb here is an edit a board member can already make. A member holds
 * the doc's live-editing socket (`docs/<doc>/y` in `docSubrouteAllowed`),
 * which is unrestricted text editing of the same document, and the thread
 * region edits (`threads/<id>/rewrite_region`, `insert_blocks_after`). These
 * are the same edits with an address an agent can name without a thread:
 *
 * - `GET outline` — the doc's blocks and headings, a projection of the
 *   `content` a member already reads;
 * - `POST find_and_replace`, `POST block_edits`, `POST delete_block_at_anchor`,
 *   `POST delete_blocks_in_range`, `POST delete_section` — text edits;
 * - `POST agent_anchors`, `POST agent_anchors/<id>/edit`,
 *   `POST agent_anchors/<id>/insert_blocks`, `DELETE agent_anchors/<id>` — a
 *   marker the agent places in the text, and edits made at it.
 *
 * The operator verbs stay refused: `content` (a whole-doc rewrite, which
 * only a lead gets, `middleware/lead-scope.ts`), `reparse_from_disk`,
 * `archive`, `unarchive`, the bare `DELETE`, and every other board.
 *
 * Three conditions, all required: the path's board is the caller's board, the
 * doc is filed on that board, and the verb is in the table below. Anything
 * not named here is refused, so a route added later is closed to a board
 * agent until somebody decides otherwise.
 */

/** Every board an id belongs to, as `collabScope` asks it. */
type WorkspacesOf = (id: string) => string[];

const DOC_PATH = /^\/workspaces\/([^/]+)\/docs\/([^/]+)\/(.+)$/;
const ANCHOR_VERB = /^agent_anchors\/[^/]+(\/edit|\/insert_blocks)?$/;

/** The plain verbs: remainder → the one method each answers. */
const DOC_EDIT_VERBS: Readonly<Record<string, string>> = {
  outline: 'GET',
  find_and_replace: 'POST',
  block_edits: 'POST',
  delete_block_at_anchor: 'POST',
  delete_blocks_in_range: 'POST',
  delete_section: 'POST',
  agent_anchors: 'POST',
};

export function boardDocEditAllows(
  pathname: string,
  method: string,
  boardId: string,
  workspacesOf: WorkspacesOf,
): boolean {
  const match = pathname.match(DOC_PATH);
  if (!match || decoded(match[1] ?? '') !== boardId) return false;
  const docId = decoded(match[2] ?? '');
  const verb = match[3] ?? '';
  const m = method.toUpperCase();
  if (!verbAllows(verb, m)) return false;
  const owners = workspacesOf(docId);
  return Array.isArray(owners) && owners.includes(boardId);
}

function verbAllows(verb: string, method: string): boolean {
  if (Object.hasOwn(DOC_EDIT_VERBS, verb)) return DOC_EDIT_VERBS[verb] === method;
  const anchor = verb.match(ANCHOR_VERB);
  if (!anchor) return false;
  // `agent_anchors/<id>` alone is the anchor's removal; `/edit` and
  // `/insert_blocks` under it are edits made at it.
  return anchor[1] === undefined ? method === 'DELETE' : method === 'POST';
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
