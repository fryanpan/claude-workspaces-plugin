/**
 * Which board owns product feedback.
 *
 * Every board's feedback widget writes to one doc, `BOARD_FEEDBACK_DOC_ID`
 * (`doc-ids.ts`), because a comment on the board UI is about the product and
 * not about the board it was made on. That doc sat on no board, so its
 * comments reached only a session that had called `watch_doc` on it. None
 * had, and feedback went unanswered for weeks.
 *
 * The fix gives the doc an owner the server always delivers to: one board,
 * whose lead receives the doc's comment events and durable queue rows exactly
 * as it does for a doc filed on that board (`stall-wiring.ts`,
 * `onLiveDocEvent`). It is a DELIVERY owner only. The doc is not added to the
 * board's `docIds`, so it does not show as a row there and a share visitor of
 * that board gains no path to it: share scope reads `docIds`, and this does
 * not write them.
 *
 * The board is configuration, never a hard-coded id: `CW_FEEDBACK_BOARD`
 * names a board by id or by name. Unset, it is the board named
 * `DEFAULT_FEEDBACK_BOARD`, which is what the product's own board is called.
 * Resolved on every event rather than once at boot, so a board created or
 * renamed later takes effect with no restart.
 */

/** The environment variable that names the owning board (id or name). */
export const FEEDBACK_BOARD_ENV = 'CW_FEEDBACK_BOARD';

/** The board name used when nothing is configured. */
export const DEFAULT_FEEDBACK_BOARD = 'Workspaces';

/** The fields of a board this decision reads. */
export interface FeedbackBoardCandidate {
  id: string;
  name: string;
  leadAgentId?: string;
  retiredAt?: number;
}

/**
 * The id of the board that owns product feedback, or null when no live board
 * matches.
 *
 * An exact id match wins. Otherwise the name is matched without regard to
 * case or surrounding space. A retired board is never the owner, because its
 * lead seat is closed. When several boards share the name, the first that has
 * a lead wins, then the first in listing order: a board with nobody to
 * deliver to is the failure this module exists to remove.
 */
export function feedbackOwnerBoard(
  spec: string | undefined,
  boards: readonly FeedbackBoardCandidate[],
): string | null {
  const wanted = spec?.trim() || DEFAULT_FEEDBACK_BOARD;
  const live = boards.filter((b) => b.retiredAt === undefined);
  const byId = live.find((b) => b.id === wanted);
  if (byId) return byId.id;
  const name = wanted.toLowerCase();
  const named = live.filter((b) => b.name.trim().toLowerCase() === name);
  return (named.find((b) => b.leadAgentId) ?? named[0])?.id ?? null;
}
