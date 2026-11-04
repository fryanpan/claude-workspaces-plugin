/**
 * What a board's lead may ask of `POST /workspaces/<board>/attachments`
 * (`create_diff_review`): a diff of a repository inside one of the roots
 * registered for its board, and nothing else. `middleware/lead-scope.ts`
 * lets the path through for the lead's own board; this holds the body to it,
 * as `refuseLeadBind` holds a folder bind.
 *
 * Safe for the reason the folder bind is: every read under a root goes
 * through `tree-fs.ts`, and git there runs contained (`git-contained.ts`).
 */
import { treeFsMode } from '../tree-fs.ts';

/** The most files a lead's diff may ask for, as for its folder bind. */
export const LEAD_DIFF_MAX_FILES = 5_000;

export interface LeadDiff {
  /** The repository as the roots spell it: what the bind is made on. */
  repo: string;
}

/**
 * Why a lead's diff request is refused, or the repository to diff.
 * `repoIn(board, repo)` answers the repository as the roots spell it when the
 * innermost root holding it is one of the board's, else null.
 */
export function refuseLeadDiff(
  leadBoard: string,
  body: Record<string, unknown> | null,
  repoIn: (boardId: string, repo: string) => string | null,
): { error: string; message: string } | LeadDiff {
  const refuse = (message: string) => ({ error: 'out_of_lead_scope', message });
  if (treeFsMode() !== 'contained')
    return refuse('A lead’s diff review needs the contained file calls, which this server lacks.');
  const repo = body?.repo;
  if (typeof repo !== 'string' || repo === '') return refuse('A lead’s diff review names a repo.');
  if (typeof body?.base !== 'string') return refuse('A lead’s diff review names a base.');
  if (body.reviewId !== undefined) return refuse('A lead may not re-file a review by id.');
  const { maxFiles } = body;
  if (
    maxFiles !== undefined &&
    !(
      Number.isInteger(maxFiles) &&
      (maxFiles as number) > 0 &&
      (maxFiles as number) <= LEAD_DIFF_MAX_FILES
    )
  )
    return refuse(`A lead’s maxFiles is a whole number from 1 to ${LEAD_DIFF_MAX_FILES}.`);
  const inside = repoIn(leadBoard, repo);
  if (inside === null)
    return refuse(
      'A lead diffs a repository inside one of the folders registered for its board (PUT /api/board-sockets/<board>/roots).',
    );
  return { repo: inside };
}
