/**
 * What a board's lead may ask of `POST /workspaces` (`attach_folder`): a
 * folder bind on its own board, of a folder registered for that board, and
 * nothing else. `middleware/lead-scope.ts` lets the path through for a lead;
 * this holds the body to it, as `lead-diff-scope.ts` holds a diff review.
 */
import { leadSetId } from '../board-socket-roots.ts';
import { type TreeFsMode, treeFsMode } from '../tree-fs.ts';

/** The most files a lead's bind may ask the scan for. */
export const LEAD_MAX_FILES = 5_000;

export interface LeadBind {
  board: string;
  /** The registered root the folder resolved to: what is bound. */
  root: string;
  setId: string;
}

/**
 * Why a lead's `POST /workspaces` is refused, or what it binds. Only a
 * folder bind; only on the lead's own board; never re-filing a set by id,
 * which could name one on another board; and only a folder that resolves to
 * a root registered for that board (`board-socket-roots.ts`). Every read
 * and write the bind leads to then goes through `tree-fs.ts`.
 *
 * `mode` is the platform's file-call mode, and the route never passes it.
 * It is a parameter so a test can judge a body on a server without the
 * contained calls, where the route refuses every lead bind first.
 */
export function refuseLeadBind(
  leadBoard: string | null,
  body: Record<string, unknown> | null,
  leadBindRoot: (boardId: string, folderPath: string) => string | null,
  mode: TreeFsMode = treeFsMode(),
): { error: string; message: string } | LeadBind {
  const refuse = (message: string) => ({ error: 'out_of_lead_scope', message });
  if (leadBoard === null) return refuse('Only a board’s lead may bind a folder from here.');
  // The bind is safe only because its reads and writes are contained; where
  // the contained calls are not (any platform but macOS on arm64), refuse.
  if (mode !== 'contained')
    return refuse('A lead’s folder bind needs the contained file calls, which this server lacks.');
  const folderPath = body?.folderPath;
  if (typeof folderPath !== 'string' || folderPath === '')
    return refuse('A lead may bind a folder here, and not create a board.');
  if (body?.hubWorkspaceId !== leadBoard)
    return refuse('A lead binds a folder onto its own board only.');
  if (body?.setId !== undefined || body?.workspaceId !== undefined)
    return refuse('A lead may not re-file an attachment set by id.');
  if (body?.privacy !== undefined && body.privacy !== 'local-only')
    return refuse('A lead may keep a set local-only, and may not make it shareable.');
  const { maxFiles } = body;
  if (
    maxFiles !== undefined &&
    !(
      Number.isInteger(maxFiles) &&
      (maxFiles as number) > 0 &&
      (maxFiles as number) <= LEAD_MAX_FILES
    )
  )
    return refuse(`A lead’s maxFiles is a whole number from 1 to ${LEAD_MAX_FILES}.`);
  const root = leadBindRoot(leadBoard, folderPath);
  if (root === null)
    return refuse(
      'A lead binds one of the folders registered for its board (PUT /api/board-sockets/<board>/roots), and narrows to a subfolder with include.',
    );
  return { board: leadBoard, root, setId: leadSetId(root, leadBoard) };
}
